import { afterEach, describe, expect, it, vi } from "vitest"
import { MemoryV2Database } from "./database"
import {
  enqueueVectorUpsert,
  processVectorSyncJobs,
  reconcileVectorIndex,
  vectorContentHash,
  vectorIndexKey,
  type VectorIndexEntry,
} from "./vector-sync"

const databases: MemoryV2Database[] = []

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

function createDatabase(): MemoryV2Database {
  const database = new MemoryV2Database(":memory:")
  databases.push(database)
  return database
}

function insertFragment(db: MemoryV2Database, id: string, content: string, now: number): void {
  db.prepare(`
    INSERT INTO memory_fragments(
      id, content, kind, certainty, attribution, confidence, importance,
      emotional_weight, status, created_at, updated_at, last_accessed_at,
      access_count, pinned, revision, metadata_json
    ) VALUES (?, ?, 'fact', 'explicit', 'user', 0.9, 0.8, 0.5,
      'active', ?, ?, ?, 0, 0, 1, '{}')
  `).run(id, content, now, now, now)
}

describe("Memory v2 vector synchronization", () => {
  it("commits the authoritative write and Outbox task atomically", () => {
    const db = createDatabase()
    const now = Date.UTC(2026, 6, 14)

    expect(() => db.transaction(() => {
      insertFragment(db, "fragment", "atomic memory", now)
      enqueueVectorUpsert(db, "fragment", "fragment", now)
      throw new Error("rollback")
    })).toThrow("rollback")

    expect(db.prepare("SELECT * FROM memory_fragments").all()).toHaveLength(0)
    expect(db.prepare("SELECT * FROM memory_vector_index").all()).toHaveLength(0)
    expect(db.prepare("SELECT * FROM memory_jobs").all()).toHaveLength(0)
  })

  it("uses a stable index key so a crash retry replaces rather than duplicates", async () => {
    const db = createDatabase()
    const now = Date.UTC(2026, 6, 14)
    insertFragment(db, "fragment", "stable vector memory", now)
    enqueueVectorUpsert(db, "fragment", "fragment", now)
    const entries = new Map<string, VectorIndexEntry>()
    const upsertEntry = vi.fn(async (indexKey: string, text: string, source: string, metadata?: Record<string, unknown>) => {
      const entry = { id: `rag:${indexKey}`, text, source, createdAt: now, metadata }
      entries.set(indexKey, entry)
      return entry.id
    })
    const deps = { upsertEntry, deleteEntries: vi.fn(() => 0) }

    expect(await processVectorSyncJobs(db, deps, now)).toEqual({ completed: 1, failed: 0 })
    db.prepare("UPDATE memory_jobs SET status = 'pending', next_run_at = ?").run(now)
    expect(await processVectorSyncJobs(db, deps, now + 1)).toEqual({ completed: 1, failed: 0 })

    expect(upsertEntry).toHaveBeenCalledTimes(2)
    expect(entries.size).toBe(1)
    expect(db.prepare("SELECT status, target_revision FROM memory_vector_index").get()).toMatchObject({
      status: "synced",
      target_revision: 1,
    })
  })

  it("does not publish an obsolete queued revision", async () => {
    const db = createDatabase()
    const now = Date.UTC(2026, 6, 14)
    insertFragment(db, "fragment", "old content", now)
    enqueueVectorUpsert(db, "fragment", "fragment", now)
    db.prepare("UPDATE memory_fragments SET content = 'new content', revision = 2 WHERE id = 'fragment'").run()
    const upsertEntry = vi.fn(async () => "rag")

    const result = await processVectorSyncJobs(db, { upsertEntry, deleteEntries: () => 0 }, now)

    expect(result).toEqual({ completed: 1, failed: 0 })
    expect(upsertEntry).not.toHaveBeenCalled()
    const pending = db.prepare("SELECT payload_json FROM memory_jobs WHERE status = 'pending'").get()
    expect(JSON.parse(String(pending?.payload_json))).toMatchObject({
      targetRevision: 2,
      contentHash: vectorContentHash("new content"),
    })
  })

  it("detects stale, duplicate, and orphan vectors and queues repair", () => {
    const db = createDatabase()
    const now = Date.UTC(2026, 6, 14)
    insertFragment(db, "fragment", "current content", now)
    const indexKey = vectorIndexKey("fragment", "fragment")
    const validMetadata = {
      l2Id: "fragment",
      memoryV2: true,
      memoryLayer: "fragment",
      indexKey,
      targetRevision: 1,
      contentHash: vectorContentHash("current content"),
      indexVersion: 2,
    }
    const entries: VectorIndexEntry[] = [
      { id: "valid", text: "current content", source: "user_memory", createdAt: now, metadata: validMetadata },
      { id: "duplicate", text: "current content", source: "user_memory", createdAt: now, metadata: validMetadata },
      { id: "stale", text: "old", source: "user_memory", createdAt: now, metadata: { ...validMetadata, contentHash: "old" } },
      { id: "orphan", text: "gone", source: "user_memory", createdAt: now, metadata: { ...validMetadata, l2Id: "missing", indexKey: vectorIndexKey("fragment", "missing") } },
    ]
    const deleteEntries = vi.fn((ids: Iterable<string>) => [...ids].length)

    const result = reconcileVectorIndex(db, { listEntries: () => entries, deleteEntries }, now)

    expect(result).toMatchObject({
      orphanEntries: 1,
      staleEntries: 1,
      duplicateEntries: 1,
      deletedEntries: 3,
    })
    expect(deleteEntries).toHaveBeenCalledWith(new Set(["stale", "orphan", "duplicate"]))
    expect(db.prepare("SELECT * FROM memory_jobs WHERE job_type = 'rag-upsert'").all().length).toBeGreaterThan(0)
  })
})
