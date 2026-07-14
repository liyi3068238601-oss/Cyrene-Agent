import { createHash, randomUUID } from "crypto"
import type { MemoryV2Database } from "./database"

export type VectorTargetType = "fragment" | "episode"

export interface VectorIndexEntry {
  id: string
  text: string
  source: string
  createdAt: number
  metadata?: Record<string, unknown>
}

export interface VectorSyncDeps {
  isReady?: () => boolean
  addEntry?: (text: string, source: string, metadata?: Record<string, unknown>) => Promise<string>
  upsertEntry?: (
    indexKey: string,
    text: string,
    source: string,
    metadata?: Record<string, unknown>,
  ) => Promise<string>
  deleteEntries(ids: Iterable<string>): number
  deleteIndexEntries?: (indexKeys: Iterable<string>) => number
  listEntries?: (source?: string) => VectorIndexEntry[]
}

export interface VectorTargetSnapshot {
  targetType: VectorTargetType
  targetId: string
  indexKey: string
  text: string
  revision: number
  contentHash: string
  indexable: boolean
  ragId: string | null
}

export interface VectorReconcileResult {
  scannedTargets: number
  queuedUpserts: number
  queuedDeletes: number
  orphanEntries: number
  staleEntries: number
  duplicateEntries: number
  deletedEntries: number
}

export function vectorIndexKey(targetType: VectorTargetType, targetId: string): string {
  return `memory-v2:${targetType}:${targetId}`
}

export function vectorContentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}

function parseMetadata(raw: unknown): Record<string, unknown> {
  try {
    const value = JSON.parse(String(raw ?? "{}"))
    return value && typeof value === "object" ? value as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

export function loadVectorTarget(
  db: MemoryV2Database,
  targetType: VectorTargetType,
  targetId: string,
): VectorTargetSnapshot | null {
  if (targetType === "fragment") {
    const row = db.prepare(`
      SELECT id, content, status, revision, legacy_rag_id
      FROM memory_fragments WHERE id = ?
    `).get(targetId)
    if (!row) return null
    const text = String(row.content)
    return {
      targetType,
      targetId,
      indexKey: vectorIndexKey(targetType, targetId),
      text,
      revision: Math.max(1, Number(row.revision ?? 1)),
      contentHash: vectorContentHash(text),
      indexable: ["active", "cooling"].includes(String(row.status)),
      ragId: typeof row.legacy_rag_id === "string" && row.legacy_rag_id ? row.legacy_rag_id : null,
    }
  }

  const row = db.prepare(`
    SELECT id, title, content, status, version, metadata_json
    FROM memory_episodes WHERE id = ?
  `).get(targetId)
  if (!row) return null
  const text = `${String(row.title)}\n${String(row.content)}`
  const metadata = parseMetadata(row.metadata_json)
  return {
    targetType,
    targetId,
    indexKey: vectorIndexKey(targetType, targetId),
    text,
    revision: Math.max(1, Number(row.version ?? 1)),
    contentHash: vectorContentHash(text),
    indexable: ["active", "mature"].includes(String(row.status)),
    ragId: typeof metadata.ragId === "string" && metadata.ragId ? metadata.ragId : null,
  }
}

function upsertLedger(db: MemoryV2Database, target: VectorTargetSnapshot, now: number): void {
  db.prepare(`
    INSERT INTO memory_vector_index(
      index_key, target_type, target_id, target_revision, content_hash,
      rag_id, status, last_error, synced_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, ?)
    ON CONFLICT(index_key) DO UPDATE SET
      target_revision = excluded.target_revision,
      content_hash = excluded.content_hash,
      rag_id = COALESCE(memory_vector_index.rag_id, excluded.rag_id),
      status = CASE
        WHEN memory_vector_index.target_revision = excluded.target_revision
         AND memory_vector_index.content_hash = excluded.content_hash
         AND memory_vector_index.status = 'synced'
        THEN 'synced' ELSE 'pending' END,
      last_error = NULL,
      updated_at = excluded.updated_at
  `).run(
    target.indexKey,
    target.targetType,
    target.targetId,
    target.revision,
    target.contentHash,
    target.ragId,
    now,
    now,
  )
}

function enqueueJob(
  db: MemoryV2Database,
  jobType: "rag-upsert" | "rag-upsert-episode" | "rag-delete" | "rag-delete-episode",
  idempotencyKey: string,
  payload: Record<string, unknown>,
  priority: number,
  now: number,
): boolean {
  const before = db.prepare("SELECT status FROM memory_jobs WHERE idempotency_key = ?").get(idempotencyKey)
  db.prepare(`
    INSERT INTO memory_jobs(
      id, job_type, idempotency_key, payload_json, status, priority,
      attempt_count, next_run_at, last_error, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'pending', ?, 0, ?, NULL, ?, ?)
    ON CONFLICT(idempotency_key) DO UPDATE SET
      payload_json = excluded.payload_json,
      priority = MAX(memory_jobs.priority, excluded.priority),
      status = CASE WHEN memory_jobs.status IN ('completed', 'cancelled') THEN 'pending' ELSE memory_jobs.status END,
      attempt_count = CASE WHEN memory_jobs.status IN ('completed', 'cancelled') THEN 0 ELSE memory_jobs.attempt_count END,
      next_run_at = MIN(memory_jobs.next_run_at, excluded.next_run_at),
      last_error = CASE WHEN memory_jobs.status IN ('completed', 'cancelled') THEN NULL ELSE memory_jobs.last_error END,
      updated_at = excluded.updated_at
  `).run(
    `job_${randomUUID()}`,
    jobType,
    idempotencyKey,
    JSON.stringify(payload),
    priority,
    now,
    now,
    now,
  )
  return !before || ["completed", "cancelled"].includes(String(before.status))
}

export function enqueueVectorUpsert(
  db: MemoryV2Database,
  targetType: VectorTargetType,
  targetId: string,
  now = Date.now(),
  priority = 20,
): boolean {
  const target = loadVectorTarget(db, targetType, targetId)
  if (!target || !target.indexable) return false
  upsertLedger(db, target, now)
  const jobType = targetType === "fragment" ? "rag-upsert" : "rag-upsert-episode"
  return enqueueJob(
    db,
    jobType,
    `rag-upsert:${target.indexKey}:${target.revision}:${target.contentHash}`,
    {
      indexKey: target.indexKey,
      targetType,
      targetId,
      targetRevision: target.revision,
      contentHash: target.contentHash,
      ...(targetType === "fragment" ? { fragmentId: targetId } : { episodeId: targetId }),
    },
    priority,
    now,
  )
}

export function enqueueVectorDelete(
  db: MemoryV2Database,
  targetType: VectorTargetType,
  targetId: string,
  now = Date.now(),
  priority = 100,
): boolean {
  const indexKey = vectorIndexKey(targetType, targetId)
  const target = loadVectorTarget(db, targetType, targetId)
  const ledger = db.prepare("SELECT rag_id FROM memory_vector_index WHERE index_key = ?").get(indexKey)
  const ragId = typeof ledger?.rag_id === "string" && ledger.rag_id
    ? ledger.rag_id
    : target?.ragId ?? null
  db.prepare(`
    UPDATE memory_vector_index SET status = 'deleting', updated_at = ? WHERE index_key = ?
  `).run(now, indexKey)
  const jobType = targetType === "fragment" ? "rag-delete" : "rag-delete-episode"
  return enqueueJob(
    db,
    jobType,
    `rag-delete:${indexKey}:${ragId ?? "by-key"}`,
    { indexKey, targetType, targetId, ragId },
    priority,
    now,
  )
}

function metadataFor(target: VectorTargetSnapshot): Record<string, unknown> {
  return {
    l2Id: target.targetId,
    memoryV2Id: target.targetId,
    memoryV2: true,
    memoryLayer: target.targetType,
    indexKey: target.indexKey,
    targetRevision: target.revision,
    contentHash: target.contentHash,
    indexVersion: 2,
  }
}

function completeJob(db: MemoryV2Database, jobId: string, now: number): void {
  db.prepare(`
    UPDATE memory_jobs SET status = 'completed', last_error = NULL, updated_at = ? WHERE id = ?
  `).run(now, jobId)
}

function failJob(db: MemoryV2Database, jobId: string, error: unknown, attemptCount: number, now: number): void {
  const message = error instanceof Error ? error.message : String(error)
  const nextRunAt = now + Math.min(6 * 60, 2 ** Math.max(1, attemptCount)) * 60 * 1000
  db.prepare(`
    UPDATE memory_jobs SET status = 'failed', last_error = ?, next_run_at = ?, updated_at = ? WHERE id = ?
  `).run(message.slice(0, 1000), nextRunAt, now, jobId)
}

export async function processVectorSyncJobs(
  db: MemoryV2Database,
  deps: VectorSyncDeps,
  now = Date.now(),
  limit = 20,
): Promise<{ completed: number; failed: number }> {
  if (deps.isReady && !deps.isReady()) return { completed: 0, failed: 0 }
  const jobs = db.prepare(`
    SELECT * FROM memory_jobs
    WHERE job_type IN ('rag-delete', 'rag-upsert', 'rag-delete-episode', 'rag-upsert-episode')
      AND status IN ('pending', 'failed') AND next_run_at <= ? AND attempt_count < 10
    ORDER BY priority DESC, created_at ASC LIMIT ?
  `).all(now, limit)
  let completed = 0
  let failed = 0

  for (const job of jobs) {
    const jobId = String(job.id)
    const attemptCount = Number(job.attempt_count) + 1
    db.prepare(`
      UPDATE memory_jobs SET status = 'running', attempt_count = attempt_count + 1, updated_at = ? WHERE id = ?
    `).run(now, jobId)
    try {
      const payload = parseMetadata(job.payload_json) as {
        indexKey?: string
        targetType?: VectorTargetType
        targetId?: string
        targetRevision?: number
        contentHash?: string
        fragmentId?: string
        episodeId?: string
        ragId?: string | null
      }
      const jobType = String(job.job_type)
      const targetType: VectorTargetType = payload.targetType ?? (jobType.includes("episode") ? "episode" : "fragment")
      const targetId = payload.targetId ?? payload.fragmentId ?? payload.episodeId
      if (!targetId) throw new Error("Vector sync job is missing targetId")
      const indexKey = payload.indexKey ?? vectorIndexKey(targetType, targetId)

      if (jobType === "rag-delete" || jobType === "rag-delete-episode") {
        if (deps.deleteIndexEntries) deps.deleteIndexEntries([indexKey])
        if (payload.ragId) deps.deleteEntries([payload.ragId])
        db.transaction(() => {
          db.prepare("DELETE FROM memory_vector_index WHERE index_key = ?").run(indexKey)
          if (targetType === "fragment") {
            db.prepare("UPDATE memory_fragments SET legacy_rag_id = NULL WHERE id = ?").run(targetId)
          } else {
            const episode = db.prepare("SELECT metadata_json FROM memory_episodes WHERE id = ?").get(targetId)
            if (episode) {
              const metadata = parseMetadata(episode.metadata_json)
              delete metadata.ragId
              db.prepare("UPDATE memory_episodes SET metadata_json = ? WHERE id = ?")
                .run(JSON.stringify(metadata), targetId)
            }
          }
          completeJob(db, jobId, now)
        })
        completed += 1
        continue
      }

      const target = loadVectorTarget(db, targetType, targetId)
      if (!target || !target.indexable) {
        if (deps.deleteIndexEntries) deps.deleteIndexEntries([indexKey])
        if (payload.ragId) deps.deleteEntries([payload.ragId])
        db.transaction(() => {
          db.prepare("DELETE FROM memory_vector_index WHERE index_key = ?").run(indexKey)
          completeJob(db, jobId, now)
        })
        completed += 1
        continue
      }

      if (
        (payload.targetRevision && Number(payload.targetRevision) !== target.revision) ||
        (payload.contentHash && payload.contentHash !== target.contentHash)
      ) {
        db.transaction(() => {
          completeJob(db, jobId, now)
          enqueueVectorUpsert(db, targetType, targetId, now)
        })
        completed += 1
        continue
      }

      const ragId = deps.upsertEntry
        ? await deps.upsertEntry(target.indexKey, target.text, "user_memory", metadataFor(target))
        : deps.addEntry
          ? await deps.addEntry(target.text, "user_memory", metadataFor(target))
          : (() => { throw new Error("Vector sync has no upsert dependency") })()

      db.transaction(() => {
        const latest = loadVectorTarget(db, targetType, targetId)
        if (!latest || !latest.indexable || latest.revision !== target.revision || latest.contentHash !== target.contentHash) {
          db.prepare(`
            INSERT INTO memory_vector_index(
              index_key, target_type, target_id, target_revision, content_hash,
              rag_id, status, last_error, synced_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, 'stale', NULL, NULL, ?, ?)
            ON CONFLICT(index_key) DO UPDATE SET
              rag_id = excluded.rag_id, status = 'stale', updated_at = excluded.updated_at
          `).run(target.indexKey, targetType, targetId, target.revision, target.contentHash, ragId, now, now)
          if (latest?.indexable) enqueueVectorUpsert(db, targetType, targetId, now)
        } else {
          db.prepare(`
            INSERT INTO memory_vector_index(
              index_key, target_type, target_id, target_revision, content_hash,
              rag_id, status, last_error, synced_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, 'synced', NULL, ?, ?, ?)
            ON CONFLICT(index_key) DO UPDATE SET
              target_revision = excluded.target_revision,
              content_hash = excluded.content_hash,
              rag_id = excluded.rag_id,
              status = 'synced', last_error = NULL,
              synced_at = excluded.synced_at, updated_at = excluded.updated_at
          `).run(target.indexKey, targetType, targetId, target.revision, target.contentHash, ragId, now, now, now)
          if (targetType === "fragment") {
            db.prepare("UPDATE memory_fragments SET legacy_rag_id = ? WHERE id = ?").run(ragId, targetId)
          } else {
            const episode = db.prepare("SELECT metadata_json FROM memory_episodes WHERE id = ?").get(targetId)
            if (episode) {
              const metadata = parseMetadata(episode.metadata_json)
              db.prepare("UPDATE memory_episodes SET metadata_json = ? WHERE id = ?")
                .run(JSON.stringify({ ...metadata, ragId }), targetId)
            }
          }
        }
        completeJob(db, jobId, now)
      })
      completed += 1
    } catch (error) {
      failJob(db, jobId, error, attemptCount, now)
      failed += 1
    }
  }
  return { completed, failed }
}

function ledgerMatches(db: MemoryV2Database, target: VectorTargetSnapshot): boolean {
  const ledger = db.prepare(`
    SELECT target_revision, content_hash, status FROM memory_vector_index WHERE index_key = ?
  `).get(target.indexKey)
  return Boolean(
    ledger &&
    String(ledger.status) === "synced" &&
    Number(ledger.target_revision) === target.revision &&
    String(ledger.content_hash) === target.contentHash,
  )
}

export function reconcileVectorIndex(
  db: MemoryV2Database,
  deps: Pick<VectorSyncDeps, "listEntries" | "deleteEntries">,
  now = Date.now(),
): VectorReconcileResult {
  const result: VectorReconcileResult = {
    scannedTargets: 0,
    queuedUpserts: 0,
    queuedDeletes: 0,
    orphanEntries: 0,
    staleEntries: 0,
    duplicateEntries: 0,
    deletedEntries: 0,
  }

  for (const row of db.prepare(`SELECT id FROM memory_fragments WHERE status IN ('active', 'cooling')`).all()) {
    const target = loadVectorTarget(db, "fragment", String(row.id))
    if (!target) continue
    result.scannedTargets += 1
    if (!ledgerMatches(db, target) && enqueueVectorUpsert(db, "fragment", target.targetId, now)) result.queuedUpserts += 1
  }
  for (const row of db.prepare(`SELECT id FROM memory_episodes WHERE status IN ('active', 'mature')`).all()) {
    const target = loadVectorTarget(db, "episode", String(row.id))
    if (!target) continue
    result.scannedTargets += 1
    if (!ledgerMatches(db, target) && enqueueVectorUpsert(db, "episode", target.targetId, now)) result.queuedUpserts += 1
  }
  for (const row of db.prepare("SELECT target_type, target_id FROM memory_vector_index").all()) {
    const targetType = String(row.target_type) as VectorTargetType
    const target = loadVectorTarget(db, targetType, String(row.target_id))
    if ((!target || !target.indexable) && enqueueVectorDelete(db, targetType, String(row.target_id), now)) {
      result.queuedDeletes += 1
    }
  }

  const entries = deps.listEntries?.("user_memory") ?? []
  const byIndexKey = new Map<string, VectorIndexEntry[]>()
  const invalidIds = new Set<string>()
  for (const entry of entries) {
    if (entry.metadata?.memoryV2 !== true) continue
    const targetId = typeof entry.metadata.memoryV2Id === "string"
      ? entry.metadata.memoryV2Id
      : typeof entry.metadata.l2Id === "string" ? entry.metadata.l2Id : null
    const targetType: VectorTargetType = entry.metadata.memoryLayer === "episode" ? "episode" : "fragment"
    const indexKey = typeof entry.metadata.indexKey === "string"
      ? entry.metadata.indexKey
      : targetId ? vectorIndexKey(targetType, targetId) : ""
    if (!targetId || !indexKey) {
      result.orphanEntries += 1
      invalidIds.add(entry.id)
      continue
    }
    const target = loadVectorTarget(db, targetType, targetId)
    if (!target || !target.indexable) {
      result.orphanEntries += 1
      invalidIds.add(entry.id)
      continue
    }
    if (
      entry.metadata.indexKey !== target.indexKey ||
      Number(entry.metadata.targetRevision ?? 0) !== target.revision ||
      String(entry.metadata.contentHash ?? "") !== target.contentHash
    ) {
      result.staleEntries += 1
      invalidIds.add(entry.id)
      if (enqueueVectorUpsert(db, targetType, targetId, now)) result.queuedUpserts += 1
      continue
    }
    const group = byIndexKey.get(indexKey) ?? []
    group.push(entry)
    byIndexKey.set(indexKey, group)
  }
  for (const group of byIndexKey.values()) {
    for (const duplicate of group.slice(1)) {
      result.duplicateEntries += 1
      invalidIds.add(duplicate.id)
    }
  }
  if (invalidIds.size > 0) result.deletedEntries = deps.deleteEntries(invalidIds)
  return result
}
