import { createHash, randomUUID } from "crypto"
import type { MemoryV2Database } from "./database"
import {
  backfillMemoryClaims,
  invalidateFragmentProjections,
  linkStateToFragment,
  reconcileProjectionValidity,
} from "./claim-graph"
import {
  enqueueVectorDelete,
  enqueueVectorUpsert,
  processVectorSyncJobs,
  type VectorSyncDeps,
} from "./vector-sync"

const DAY_MS = 24 * 60 * 60 * 1000

export const MEMORY_LIFECYCLE_POLICY = Object.freeze({
  fragmentCoolingDays: 30,
  fragmentFrozenDays: 90,
  fragmentTombstoneDays: 365,
  durableMultiplier: 4,
  episodeMatureDays: 180,
  episodeArchiveDays: 365,
  completedJobRetentionDays: 7,
})

export interface ArchivistLightResult {
  backfilledClaims: number
  mergedFragments: number
  activatedFragments: number
  cooledFragments: number
  frozenFragments: number
  tombstonedFragments: number
  expiredStates: number
  invalidatedStates: number
  invalidatedRelations: number
  expiredRelations: number
  promotedStates: number
  maturedEpisodes: number
  archivedEpisodes: number
  cleanedJobs: number
  cleanedEvents: number
  cleanedRecallLogs: number
}

interface FragmentLifecycleRow extends Record<string, unknown> {
  id: string
  content: string
  status: string
  last_accessed_at: number
  importance: number
  pinned: number
  updated_at: number
  legacy_rag_id?: string | null
  source_count: number
  episode_count: number
  entity_count: number
  active_state_count: number
}

function enqueueJob(
  db: MemoryV2Database,
  jobType: "rag-delete" | "rag-upsert",
  fragment: FragmentLifecycleRow,
  now: number,
): void {
  if (jobType === "rag-delete") enqueueVectorDelete(db, "fragment", fragment.id, now)
  else enqueueVectorUpsert(db, "fragment", fragment.id, now)
}

function revision(
  db: MemoryV2Database,
  targetId: string,
  action: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  reason: string,
  now: number,
): void {
  db.prepare(`
    INSERT INTO memory_revisions(
      id, target_type, target_id, action, before_json, after_json,
      reason, confidence, actor, source_id, created_at
    ) VALUES (?, 'fragment', ?, ?, ?, ?, ?, 1, 'system', NULL, ?)
  `).run(
    `revision_${randomUUID()}`,
    targetId,
    action,
    JSON.stringify(before),
    JSON.stringify(after),
    reason,
    now,
  )
}

function normalizeContent(content: string): string {
  return content.trim().replace(/\s+/g, " ").toLocaleLowerCase()
}

function mergeExactDuplicates(db: MemoryV2Database, now: number): number {
  const rows = db.prepare(`
    SELECT id, content, confidence, importance, created_at
    FROM memory_fragments
    WHERE status IN ('active', 'cooling')
    ORDER BY created_at ASC, confidence DESC, importance DESC
  `).all()
  const keeperByContent = new Map<string, string>()
  let merged = 0

  const copySource = db.prepare(`
    INSERT OR IGNORE INTO memory_fragment_sources(fragment_id, source_id, evidence_role)
    SELECT ?, source_id, evidence_role FROM memory_fragment_sources WHERE fragment_id = ?
  `)
  const copyEntity = db.prepare(`
    INSERT OR IGNORE INTO memory_fragment_entities(fragment_id, entity_id, role, confidence)
    SELECT ?, entity_id, role, confidence FROM memory_fragment_entities WHERE fragment_id = ?
  `)
  const copyEpisode = db.prepare(`
    INSERT OR IGNORE INTO memory_episode_fragments(episode_id, fragment_id, position)
    SELECT episode_id, ?, position FROM memory_episode_fragments WHERE fragment_id = ?
  `)
  const supersede = db.prepare(`
    UPDATE memory_fragments
    SET status = 'superseded', superseded_by = ?, updated_at = ?
    WHERE id = ? AND status IN ('active', 'cooling')
  `)
  const copyStateDependency = db.prepare(`
    INSERT OR IGNORE INTO memory_state_fragments(
      state_id, fragment_id, fragment_revision, evidence_role, created_at
    )
    SELECT sf.state_id, keeper.id, keeper.revision, sf.evidence_role, ?
    FROM memory_state_fragments sf
    JOIN memory_fragments keeper ON keeper.id = ?
    WHERE sf.fragment_id = ?
  `)
  const copyRelationDependency = db.prepare(`
    INSERT OR IGNORE INTO memory_relation_fragments(
      relation_id, fragment_id, fragment_revision, evidence_role, created_at
    )
    SELECT rf.relation_id, keeper.id, keeper.revision, rf.evidence_role, ?
    FROM memory_relation_fragments rf
    JOIN memory_fragments keeper ON keeper.id = ?
    WHERE rf.fragment_id = ?
  `)
  for (const row of rows) {
    const id = String(row.id)
    const normalized = normalizeContent(String(row.content))
    if (!normalized) continue
    const keeperId = keeperByContent.get(normalized)
    if (!keeperId) {
      keeperByContent.set(normalized, id)
      continue
    }
    copySource.run(keeperId, id)
    copyEntity.run(keeperId, id)
    copyEpisode.run(keeperId, id)
    copyStateDependency.run(now, keeperId, id)
    copyRelationDependency.run(now, keeperId, id)
    db.prepare("DELETE FROM memory_episode_fragments WHERE fragment_id = ?").run(id)
    const result = supersede.run(keeperId, now, id)
    if (Number(result.changes) === 0) continue
    invalidateFragmentProjections(db, id, "superseded", now)
    revision(
      db,
      id,
      "merge_duplicate",
      { status: "active", contentHash: createHash("sha256").update(normalized).digest("hex") },
      { status: "superseded", supersededBy: keeperId },
      "Archivist merged an exact duplicate and preserved its evidence links.",
      now,
    )
    merged += 1
  }
  return merged
}

function fragmentRows(db: MemoryV2Database): FragmentLifecycleRow[] {
  return db.prepare(`
    SELECT f.*,
      COUNT(DISTINCT fs.source_id) AS source_count,
      COUNT(DISTINCT ef.episode_id) AS episode_count,
      COUNT(DISTINCT fe.entity_id) AS entity_count,
      COUNT(DISTINCT CASE WHEN st.status = 'active' THEN st.id END) AS active_state_count
    FROM memory_fragments f
    LEFT JOIN memory_fragment_sources fs ON fs.fragment_id = f.id
    LEFT JOIN memory_episode_fragments ef ON ef.fragment_id = f.id
    LEFT JOIN memory_fragment_entities fe ON fe.fragment_id = f.id
    LEFT JOIN memory_state_sources ss ON ss.source_id = fs.source_id
    LEFT JOIN memory_states st ON st.id = ss.state_id
    WHERE f.status IN ('active', 'cooling', 'frozen')
    GROUP BY f.id
  `).all() as FragmentLifecycleRow[]
}

function nextFragmentStatus(row: FragmentLifecycleRow, now: number): "active" | "cooling" | "frozen" | "tombstone" {
  if (Number(row.pinned) === 1) return "active"
  const idleDays = Math.max(0, now - Number(row.last_accessed_at)) / DAY_MS
  const durable = Number(row.source_count) >= 2 || Number(row.episode_count) > 0 ||
    Number(row.entity_count) > 0 || Number(row.active_state_count) > 0
  const multiplier = durable ? MEMORY_LIFECYCLE_POLICY.durableMultiplier : 1
  if (!durable && Number(row.importance) < 0.6 && idleDays >= MEMORY_LIFECYCLE_POLICY.fragmentTombstoneDays) {
    return "tombstone"
  }
  if (idleDays >= MEMORY_LIFECYCLE_POLICY.fragmentFrozenDays * multiplier) return "frozen"
  if (idleDays >= MEMORY_LIFECYCLE_POLICY.fragmentCoolingDays * multiplier) return "cooling"
  return "active"
}

function transitionFragments(db: MemoryV2Database, now: number, result: ArchivistLightResult): void {
  const updateStatus = db.prepare(`
    UPDATE memory_fragments SET status = ?, updated_at = ? WHERE id = ?
  `)
  for (const row of fragmentRows(db)) {
    const before = String(row.status)
    const after = nextFragmentStatus(row, now)
    if (before === after) continue
    if (after === "tombstone") {
      const metadata = (() => {
        try { return JSON.parse(String(row.metadata_json ?? "{}")) as Record<string, unknown> } catch { return {} }
      })()
      const content = String(row.content)
      const contentHash = createHash("sha256").update(content).digest("hex")
      db.prepare(`
        UPDATE memory_fragments
        SET content = '[已遗忘的记忆片段]', status = 'tombstone', updated_at = ?,
          revision = revision + 1, metadata_json = ?
        WHERE id = ?
      `).run(now, JSON.stringify({ ...metadata, tombstonedAt: now, contentHash, originalLength: content.length }), row.id)
      invalidateFragmentProjections(db, row.id, "tombstone", now)
      revision(db, row.id, "tombstone", { status: before, contentHash }, { status: after }, "Low-importance fragment reached its final retention stage.", now)
      enqueueJob(db, "rag-delete", row, now)
      result.tombstonedFragments += 1
      continue
    }
    updateStatus.run(after, now, row.id)
    revision(db, row.id, "lifecycle", { status: before }, { status: after }, "Archivist lifecycle transition.", now)
    if (after === "frozen") enqueueJob(db, "rag-delete", row, now)
    if (before === "frozen" && after !== "frozen") enqueueJob(db, "rag-upsert", row, now)
    if (after === "active") result.activatedFragments += 1
    if (after === "cooling") result.cooledFragments += 1
    if (after === "frozen") result.frozenFragments += 1
  }
}

function stateLifetimeDays(content: string): number {
  if (/今天|今晚|明天|本周|这周|周末/.test(content)) return 7
  if (/最近|近期|这段时间|正在|当前/.test(content)) return 30
  return 90
}

function promoteCurrentStates(db: MemoryV2Database, now: number): number {
  const fragments = db.prepare(`
    SELECT f.id, f.claim_id, f.revision, f.content, f.created_at
    FROM memory_fragments f
    WHERE f.kind = 'plan' AND f.status IN ('active', 'cooling')
      AND f.certainty = 'explicit' AND f.attribution IN ('user', 'mixed')
      AND (f.content LIKE '%正在%' OR f.content LIKE '%计划%' OR f.content LIKE '%准备%'
        OR f.content LIKE '%打算%' OR f.content LIKE '%目标%' OR f.content LIKE '%接下来%'
        OR f.content LIKE '%当前%')
    ORDER BY f.updated_at DESC LIMIT 100
  `).all()
  const insertState = db.prepare(`
    INSERT OR IGNORE INTO memory_states(
      id, claim_id, state_type, content, status, confidence, importance, starts_at,
      expires_at, resolved_at, superseded_by, pinned, created_at, updated_at, metadata_json
    ) VALUES (?, ?, 'plan', ?, 'active', 0.8, 0.7, ?, ?, NULL, NULL, 0, ?, ?, ?)
  `)
  const linkSources = db.prepare(`
    INSERT OR IGNORE INTO memory_state_sources(state_id, source_id)
    SELECT ?, source_id FROM memory_fragment_sources WHERE fragment_id = ?
  `)
  let promoted = 0
  for (const fragment of fragments) {
    const id = `state_from_${String(fragment.id)}`
    const createdAt = Number(fragment.created_at)
    const expiresAt = createdAt + stateLifetimeDays(String(fragment.content)) * DAY_MS
    const inserted = Number(insertState.run(
      id,
      fragment.claim_id,
      fragment.content,
      createdAt,
      expiresAt,
      createdAt,
      now,
      JSON.stringify({ sourceFragmentId: fragment.id, automatic: true }),
    ).changes)
    if (inserted === 0) continue
    linkSources.run(id, fragment.id)
    linkStateToFragment(db, id, String(fragment.id), now)
    db.prepare(`
      INSERT INTO memory_revisions(
        id, target_type, target_id, action, before_json, after_json,
        reason, confidence, actor, source_id, created_at
      ) VALUES (?, 'state', ?, 'promote_from_fragment', NULL, ?, ?, 0.8, 'system', NULL, ?)
    `).run(
      `revision_${randomUUID()}`,
      id,
      JSON.stringify({ status: "active", expiresAt, sourceFragmentId: fragment.id }),
      "Explicit current plan promoted from an evidence-backed fragment.",
      now,
    )
    promoted += 1
  }
  return promoted
}

export function runLightArchivist(db: MemoryV2Database, now = Date.now()): ArchivistLightResult {
  const backfilled = backfillMemoryClaims(db, now)
  const result: ArchivistLightResult = {
    backfilledClaims: backfilled.claims,
    mergedFragments: 0,
    activatedFragments: 0,
    cooledFragments: 0,
    frozenFragments: 0,
    tombstonedFragments: 0,
    expiredStates: 0,
    invalidatedStates: 0,
    invalidatedRelations: 0,
    expiredRelations: 0,
    promotedStates: 0,
    maturedEpisodes: 0,
    archivedEpisodes: 0,
    cleanedJobs: 0,
    cleanedEvents: 0,
    cleanedRecallLogs: 0,
  }
  db.transaction(() => {
    result.mergedFragments = mergeExactDuplicates(db, now)
    result.promotedStates = promoteCurrentStates(db, now)
    result.expiredStates = Number(db.prepare(`
      UPDATE memory_states
      SET status = 'expired', updated_at = ?
      WHERE status = 'active' AND pinned = 0 AND expires_at IS NOT NULL AND expires_at <= ?
    `).run(now, now).changes)

    transitionFragments(db, now, result)
    const projections = reconcileProjectionValidity(db, now)
    result.invalidatedStates = projections.states
    result.invalidatedRelations = projections.relations
    result.expiredRelations = projections.expiredRelations

    const episodesToArchive = db.prepare(`
      SELECT id, updated_at, metadata_json FROM memory_episodes
      WHERE status IN ('active', 'mature') AND last_accessed_at <= ?
    `).all(now - MEMORY_LIFECYCLE_POLICY.episodeArchiveDays * DAY_MS)
    result.archivedEpisodes = Number(db.prepare(`
      UPDATE memory_episodes
      SET status = 'archived', updated_at = ?
      WHERE status IN ('active', 'mature') AND last_accessed_at <= ?
    `).run(now, now - MEMORY_LIFECYCLE_POLICY.episodeArchiveDays * DAY_MS).changes)
    for (const episode of episodesToArchive) {
      let ragId: string | null = null
      try {
        const metadata = JSON.parse(String(episode.metadata_json ?? "{}")) as { ragId?: unknown }
        if (typeof metadata.ragId === "string") ragId = metadata.ragId
      } catch { /* invalid legacy metadata is non-fatal */ }
      void ragId
      enqueueVectorDelete(db, "episode", String(episode.id), now, 10)
    }
    result.maturedEpisodes = Number(db.prepare(`
      UPDATE memory_episodes
      SET status = 'mature', updated_at = ?
      WHERE status = 'active' AND created_at <= ?
    `).run(now, now - MEMORY_LIFECYCLE_POLICY.episodeMatureDays * DAY_MS).changes)
    result.cleanedJobs = Number(db.prepare(`
      DELETE FROM memory_jobs
      WHERE status IN ('completed', 'cancelled') AND updated_at <= ?
    `).run(now - MEMORY_LIFECYCLE_POLICY.completedJobRetentionDays * DAY_MS).changes)
    result.cleanedEvents = Number(db.prepare(`
      DELETE FROM memory_event_log
      WHERE (status = 'processed' AND processed_at IS NOT NULL AND processed_at <= ?)
         OR (status = 'failed' AND occurred_at <= ?)
    `).run(now - 30 * DAY_MS, now - 90 * DAY_MS).changes)
    result.cleanedRecallLogs = Number(db.prepare(`
      DELETE FROM memory_recall_log
      WHERE id NOT IN (
        SELECT id FROM memory_recall_log ORDER BY created_at DESC, id DESC LIMIT 5000
      )
    `).run().changes)
  })
  return result
}

export interface ArchivistRagDeps extends VectorSyncDeps {}

export async function processArchivistRagJobs(
  db: MemoryV2Database,
  deps: ArchivistRagDeps,
  now = Date.now(),
  limit = 20,
): Promise<{ completed: number; failed: number }> {
  return processVectorSyncJobs(db, deps, now, limit)
}
