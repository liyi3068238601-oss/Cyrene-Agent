import type { MemoryStore } from "../memory/memory-types"
import type { MemoryV2Database } from "./database"
import { syncLegacySnapshot, type LegacyMigrationResult } from "./legacy-migrator"

export interface LegacySnapshotRepairResult {
  processed: boolean
  completed: boolean
  failed: boolean
  migration: LegacyMigrationResult | null
}

export function processLegacySnapshotRepair(
  db: MemoryV2Database,
  store: MemoryStore,
  now = Date.now(),
  sync: typeof syncLegacySnapshot = syncLegacySnapshot,
): LegacySnapshotRepairResult {
  const job = db.prepare(`
    SELECT * FROM memory_jobs
    WHERE job_type = 'legacy_snapshot_repair'
      AND status IN ('pending', 'failed')
      AND next_run_at <= ?
    ORDER BY priority DESC, created_at ASC
    LIMIT 1
  `).get(now)
  if (!job) return { processed: false, completed: false, failed: false, migration: null }

  const jobId = String(job.id)
  db.prepare("UPDATE memory_jobs SET status = 'running', updated_at = ? WHERE id = ?").run(now, jobId)
  try {
    const migration = sync(db, store, now)
    db.prepare(`
      UPDATE memory_jobs
      SET status = 'completed', last_error = NULL, updated_at = ?
      WHERE id = ?
    `).run(now, jobId)
    return { processed: true, completed: true, failed: false, migration }
  } catch (error) {
    const attempts = Number(job.attempt_count ?? 0) + 1
    const retryDelay = Math.min(6 * 60 * 60 * 1000, 60_000 * 2 ** Math.min(attempts - 1, 8))
    db.prepare(`
      UPDATE memory_jobs
      SET status = 'failed', attempt_count = ?, next_run_at = ?, last_error = ?, updated_at = ?
      WHERE id = ?
    `).run(
      attempts,
      now + retryDelay,
      error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000),
      now,
      jobId,
    )
    return { processed: true, completed: false, failed: true, migration: null }
  }
}
