import { afterEach, describe, expect, it, vi } from "vitest"
import { MemoryV2Database } from "./database"
import {
  MEMORY_LIFECYCLE_POLICY,
  processArchivistRagJobs,
  runLightArchivist,
} from "./archivist"

const DAY_MS = 24 * 60 * 60 * 1000
const databases: MemoryV2Database[] = []

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

function createDatabase(): MemoryV2Database {
  const database = new MemoryV2Database(":memory:")
  databases.push(database)
  return database
}

function insertFragment(
  db: MemoryV2Database,
  input: {
    id: string
    content?: string
    now: number
    idleDays: number
    status?: "active" | "cooling" | "frozen"
    importance?: number
    pinned?: boolean
    ragId?: string
  },
): void {
  const lastAccessedAt = input.now - input.idleDays * DAY_MS
  db.prepare(`
    INSERT INTO memory_fragments(
      id, content, kind, certainty, attribution, confidence, importance,
      emotional_weight, status, created_at, updated_at, last_accessed_at,
      access_count, pinned, legacy_rag_id, metadata_json
    ) VALUES (?, ?, 'fact', 'explicit', 'user', 0.9, ?, 0.5, ?, ?, ?, ?, 0, ?, ?, '{}')
  `).run(
    input.id,
    input.content ?? input.id,
    input.importance ?? 0.5,
    input.status ?? "active",
    lastAccessedAt,
    lastAccessedAt,
    lastAccessedAt,
    input.pinned ? 1 : 0,
    input.ragId ?? null,
  )
}

describe("Memory v2 light Archivist", () => {
  it("moves ordinary fragments through 30/90/365-day lifecycle stages", () => {
    const db = createDatabase()
    const now = Date.UTC(2026, 6, 14)
    insertFragment(db, { id: "cool", now, idleDays: 31 })
    insertFragment(db, { id: "freeze", now, idleDays: 91, ragId: "rag-freeze" })
    insertFragment(db, { id: "forget", content: "应该被清除的正文", now, idleDays: 366, importance: 0.2, ragId: "rag-forget" })

    const result = runLightArchivist(db, now)
    expect(result).toMatchObject({ cooledFragments: 1, frozenFragments: 1, tombstonedFragments: 1 })
    expect(db.prepare("SELECT status FROM memory_fragments WHERE id = 'cool'").get()?.status).toBe("cooling")
    expect(db.prepare("SELECT status FROM memory_fragments WHERE id = 'freeze'").get()?.status).toBe("frozen")
    const forgotten = db.prepare("SELECT content, status, revision, metadata_json FROM memory_fragments WHERE id = 'forget'").get()
    expect(forgotten?.status).toBe("tombstone")
    expect(forgotten?.content).toBe("[已遗忘的记忆片段]")
    expect(forgotten?.revision).toBe(2)
    expect(JSON.parse(String(forgotten?.metadata_json))).toMatchObject({ originalLength: 8 })
    expect(db.prepare("SELECT * FROM memory_jobs WHERE job_type = 'rag-delete'").all()).toHaveLength(2)
  })

  it("extends durable memories and never cools pinned memories", () => {
    const db = createDatabase()
    const now = Date.UTC(2026, 6, 14)
    insertFragment(db, { id: "pinned", now, idleDays: 500, pinned: true })
    insertFragment(db, { id: "durable", now, idleDays: 100 })
    for (const index of [1, 2]) {
      db.prepare(`
        INSERT INTO memory_sources(
          id, source_type, conversation_id, occurred_at, quote, status, metadata_json
        ) VALUES (?, 'chat', ?, ?, '独立证据', 'active', '{}')
      `).run(`source-${index}`, `branch-${index}`, now)
      db.prepare(`
        INSERT INTO memory_fragment_sources(fragment_id, source_id, evidence_role)
        VALUES ('durable', ?, 'support')
      `).run(`source-${index}`)
    }

    runLightArchivist(db, now)
    expect(db.prepare("SELECT status FROM memory_fragments WHERE id = 'pinned'").get()?.status).toBe("active")
    expect(db.prepare("SELECT status FROM memory_fragments WHERE id = 'durable'").get()?.status).toBe("active")
  })

  it("wakes a recently accessed frozen fragment and queues vector rebuilding", () => {
    const db = createDatabase()
    const now = Date.UTC(2026, 6, 14)
    insertFragment(db, { id: "wake", now, idleDays: 0, status: "frozen", ragId: "old-rag" })

    const result = runLightArchivist(db, now)
    expect(result.activatedFragments).toBe(1)
    expect(db.prepare("SELECT status FROM memory_fragments WHERE id = 'wake'").get()?.status).toBe("active")
    expect(db.prepare("SELECT job_type FROM memory_jobs").get()?.job_type).toBe("rag-upsert")
  })

  it("merges exact duplicates without losing sources or episode links", () => {
    const db = createDatabase()
    const now = Date.UTC(2026, 6, 14)
    insertFragment(db, { id: "first", content: "用户喜欢紫色花朵", now, idleDays: 0 })
    insertFragment(db, { id: "duplicate", content: "  用户喜欢紫色花朵  ", now: now + 1, idleDays: 0 })
    db.prepare(`
      INSERT INTO memory_sources(id, source_type, conversation_id, occurred_at, quote, status, metadata_json)
      VALUES ('source-duplicate', 'chat', 'branch-b', ?, '用户喜欢紫色花朵', 'active', '{}')
    `).run(now)
    db.prepare(`INSERT INTO memory_fragment_sources VALUES ('duplicate', 'source-duplicate', 'support')`).run()
    db.prepare(`
      INSERT INTO memory_episodes(
        id, title, content, status, confidence, importance, created_at, updated_at,
        last_accessed_at, access_count, version, metadata_json
      ) VALUES ('episode', '花朵', '谈论紫色花朵', 'active', 0.9, 0.8, ?, ?, ?, 0, 1, '{}')
    `).run(now, now, now)
    db.prepare(`INSERT INTO memory_episode_fragments VALUES ('episode', 'duplicate', 0)`).run()

    const result = runLightArchivist(db, now + 2)
    expect(result.mergedFragments).toBe(1)
    expect(db.prepare("SELECT status, superseded_by FROM memory_fragments WHERE id = 'duplicate'").get()).toMatchObject({
      status: "superseded",
      superseded_by: "first",
    })
    expect(db.prepare("SELECT * FROM memory_fragment_sources WHERE fragment_id = 'first'").all()).toHaveLength(1)
    expect(db.prepare("SELECT fragment_id FROM memory_episode_fragments WHERE episode_id = 'episode'").get()?.fragment_id).toBe("first")
  })

  it("expires current states and matures or archives episodes", () => {
    const db = createDatabase()
    const now = Date.UTC(2026, 6, 14)
    db.prepare(`
      INSERT INTO memory_states(
        id, state_type, content, status, confidence, importance, starts_at,
        expires_at, pinned, created_at, updated_at, metadata_json
      ) VALUES ('state', 'plan', '完成 Memory v2', 'active', 0.9, 0.8, ?, ?, 0, ?, ?, '{}')
    `).run(now - DAY_MS, now - 1, now - DAY_MS, now - DAY_MS)
    for (const [id, ageDays, idleDays] of [["mature", 181, 20], ["archive", 500, 366]] as const) {
      db.prepare(`
        INSERT INTO memory_episodes(
          id, title, content, status, confidence, importance, created_at, updated_at,
          last_accessed_at, access_count, version, metadata_json
        ) VALUES (?, ?, ?, 'active', 0.9, 0.8, ?, ?, ?, 0, 1, '{}')
      `).run(id, id, id, now - ageDays * DAY_MS, now - ageDays * DAY_MS, now - idleDays * DAY_MS)
    }

    const result = runLightArchivist(db, now)
    expect(result).toMatchObject({ expiredStates: 1, maturedEpisodes: 1, archivedEpisodes: 1 })
    expect(db.prepare("SELECT status FROM memory_states WHERE id = 'state'").get()?.status).toBe("expired")
    expect(db.prepare("SELECT status FROM memory_episodes WHERE id = 'mature'").get()?.status).toBe("mature")
    expect(db.prepare("SELECT status FROM memory_episodes WHERE id = 'archive'").get()?.status).toBe("archived")
  })

  it("promotes explicit current plans into expiring states with the same evidence", () => {
    const db = createDatabase()
    const now = Date.UTC(2026, 6, 14)
    insertFragment(db, {
      id: "current-plan",
      content: "用户正在完成 Cyrene Memory v2 的设计",
      now,
      idleDays: 0,
    })
    db.prepare("UPDATE memory_fragments SET kind = 'plan' WHERE id = 'current-plan'").run()
    db.prepare(`
      INSERT INTO memory_sources(id, source_type, conversation_id, occurred_at, quote, status, metadata_json)
      VALUES ('plan-source', 'chat', 'main', ?, '正在完成 Memory v2', 'active', '{}')
    `).run(now)
    db.prepare(`INSERT INTO memory_fragment_sources VALUES ('current-plan', 'plan-source', 'support')`).run()

    const result = runLightArchivist(db, now)
    expect(result.promotedStates).toBe(1)
    const state = db.prepare("SELECT * FROM memory_states WHERE id = 'state_from_current-plan'").get()
    expect(state).toMatchObject({ status: "active", state_type: "plan" })
    expect(Number(state?.expires_at) - now).toBe(30 * DAY_MS)
    expect(db.prepare("SELECT source_id FROM memory_state_sources WHERE state_id = 'state_from_current-plan'").get()?.source_id).toBe("plan-source")

    expect(runLightArchivist(db, now + 1000).promotedStates).toBe(0)
  })

  it("processes vector jobs idempotently and retries failures", async () => {
    const db = createDatabase()
    const now = Date.UTC(2026, 6, 14)
    insertFragment(db, { id: "freeze", now, idleDays: 91, ragId: "rag-freeze" })
    insertFragment(db, { id: "wake", now, idleDays: 0, status: "frozen", ragId: "rag-old" })
    runLightArchivist(db, now)

    const deleteEntries = vi.fn(() => 1)
    const addEntry = vi.fn(async () => "rag-new")
    const processed = await processArchivistRagJobs(db, { deleteEntries, addEntry }, now)
    expect(processed).toEqual({ completed: 2, failed: 0 })
    expect(deleteEntries).toHaveBeenCalledWith(["rag-freeze"])
    expect(addEntry).toHaveBeenCalledWith("wake", "user_memory", expect.objectContaining({
      l2Id: "wake",
      memoryV2: true,
      memoryLayer: "fragment",
      indexKey: "memory-v2:fragment:wake",
      indexVersion: 2,
      targetRevision: 1,
    }))
    expect(db.prepare("SELECT legacy_rag_id FROM memory_fragments WHERE id = 'wake'").get()?.legacy_rag_id).toBe("rag-new")

    expect(MEMORY_LIFECYCLE_POLICY.fragmentCoolingDays).toBe(30)
  })

  it("prunes processed Scribe payloads and bounds non-authoritative recall diagnostics", () => {
    const db = createDatabase()
    const now = Date.UTC(2026, 6, 14)
    db.prepare(`INSERT INTO memory_sources(id, source_type, occurred_at, quote, status)
      VALUES ('user-source', 'chat', 1, 'user', 'active'), ('assistant-source', 'chat', 1, 'assistant', 'active')`).run()
    db.prepare(`INSERT INTO memory_event_log(
      id, conversation_id, user_text, assistant_text, occurred_at, status,
      attempt_count, processed_at, user_source_id, assistant_source_id
    ) VALUES ('old-event', 'main', 'full user payload', 'full assistant payload', 1, 'processed', 1, 1, 'user-source', 'assistant-source')`).run()
    const insertRecall = db.prepare(`INSERT INTO memory_recall_log(
      id, query, intent, candidate_counts_json, injected_items_json, rejected_items_json, duration_ms, created_at
    ) VALUES (?, 'q', 'semantic', '{}', '[]', '[]', 1, ?)`)
    db.transaction(() => {
      for (let index = 0; index < 5002; index += 1) insertRecall.run(`recall-${index}`, index)
    })
    const result = runLightArchivist(db, now)
    expect(result.cleanedEvents).toBe(1)
    expect(result.cleanedRecallLogs).toBe(2)
    expect(db.prepare("SELECT COUNT(*) AS count FROM memory_recall_log").get()?.count).toBe(5000)
    expect(db.prepare("SELECT COUNT(*) AS count FROM memory_sources").get()?.count).toBe(2)
  })
})
