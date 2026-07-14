import { describe, expect, it, vi } from "vitest"
import { MemoryV2Database } from "./database"
import { processLegacySnapshotRepair } from "./legacy-repair"
import type { MemoryStore } from "../memory/memory-types"

const store = {
  schemaVersion: 4,
  version: 1,
  l0: { nickname: "", preferredName: "", occupation: "", longTermInterests: "", language: "", permanentNote: "", isPinned: false, updatedAt: 1 },
  l1: { recentGoals: "", recentPreferences: "", currentProject: "", generatedAt: 1, roundCount: 0 },
  l2: [],
} satisfies MemoryStore

function queue(db: MemoryV2Database, now: number): void {
  db.prepare(`INSERT INTO memory_jobs(
    id, job_type, idempotency_key, payload_json, status, priority,
    attempt_count, next_run_at, created_at, updated_at
  ) VALUES ('repair', 'legacy_snapshot_repair', 'legacy_snapshot_repair', '{}', 'pending', 100, 0, ?, ?, ?)`)
    .run(now, now, now)
}

describe("legacy snapshot repair", () => {
  it("replays a failed shadow snapshot and completes the repair job", () => {
    const db = new MemoryV2Database(":memory:")
    queue(db, 100)
    const sync = vi.fn(() => ({
      skipped: false,
      coreProfiles: 1,
      states: 0,
      fragments: 0,
      episodes: 0,
      sources: 0,
      revisions: 0,
      deletedConversations: 0,
    }))
    const result = processLegacySnapshotRepair(db, store, 100, sync)
    expect(result).toMatchObject({ processed: true, completed: true, failed: false })
    expect(sync).toHaveBeenCalledOnce()
    expect(db.prepare("SELECT status, last_error FROM memory_jobs WHERE id = 'repair'").get())
      .toMatchObject({ status: "completed", last_error: null })
    db.close()
  })

  it("backs off after failure and ignores a repair before its next run", () => {
    const db = new MemoryV2Database(":memory:")
    queue(db, 100)
    const sync = vi.fn(() => { throw new Error("still unavailable") })
    expect(processLegacySnapshotRepair(db, store, 100, sync)).toMatchObject({ processed: true, failed: true })
    const job = db.prepare("SELECT status, attempt_count, next_run_at, last_error FROM memory_jobs WHERE id = 'repair'").get()
    expect(job).toMatchObject({ status: "failed", attempt_count: 1, last_error: "still unavailable" })
    expect(Number(job?.next_run_at)).toBeGreaterThan(100)
    expect(processLegacySnapshotRepair(db, store, 101, sync).processed).toBe(false)
    expect(sync).toHaveBeenCalledOnce()
    db.close()
  })
})
