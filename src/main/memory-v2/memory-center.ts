import { createHash, randomUUID } from "crypto"
import * as fs from "fs"
import type { MemoryV2Database } from "./database"
import { listPendingMemories } from "./pending-memory"
import { isMemoryAutomationPaused } from "./memory-runtime"
import {
  attachFragmentToClaim,
  attachStateToClaim,
  ensureMemoryClaim,
  invalidateFragmentProjections,
} from "./claim-graph"
import { enqueueVectorDelete, enqueueVectorUpsert } from "./vector-sync"
import { loadShadowRecallSummary } from "./shadow-recall"
import { loadMemoryBackgroundMetrics } from "./background-metrics"

export type EditableMemoryType = "core" | "state" | "fragment"

const CORE_COLUMNS: Record<string, string> = {
  nickname: "nickname",
  preferredName: "preferred_name",
  occupation: "occupation",
  longTermInterests: "long_term_interests",
  language: "language",
  permanentNote: "permanent_note",
}

function count(db: MemoryV2Database, table: string, where = "1 = 1"): number {
  return Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`).get()?.count ?? 0)
}

function databaseFootprintBytes(db: MemoryV2Database): number {
  if (db.path === ":memory:") return 0
  return [db.path, `${db.path}-wal`, `${db.path}-shm`].reduce((total, filePath) => {
    try { return total + fs.statSync(filePath).size } catch { return total }
  }, 0)
}

function countMergeCycles(db: MemoryV2Database): number {
  const specs = [
    ["memory_claims", "superseded_by"],
    ["memory_fragments", "superseded_by"],
    ["memory_entities", "merged_into"],
    ["memory_episodes", "superseded_by"],
    ["memory_sagas", "superseded_by"],
  ] as const
  let cycles = 0
  for (const [table, column] of specs) {
    const links = new Map(db.prepare(`SELECT id, ${column} AS next_id FROM ${table} WHERE ${column} IS NOT NULL`).all()
      .map((row) => [String(row.id), String(row.next_id)]))
    const counted = new Set<string>()
    for (const start of links.keys()) {
      const path = new Map<string, number>()
      let current: string | undefined = start
      while (current && links.has(current) && !counted.has(current)) {
        if (path.has(current)) {
          const cycleStart = path.get(current) ?? 0
          cycles += [...path.keys()].slice(cycleStart).length
          break
        }
        path.set(current, path.size)
        current = links.get(current)
      }
      for (const id of path.keys()) counted.add(id)
    }
  }
  return cycles
}

function loadMemoryDiagnostics(db: MemoryV2Database, now = Date.now()) {
  const noEvidenceFragments = Number(db.prepare(`
    SELECT COUNT(*) AS count FROM memory_fragments f
    WHERE f.status IN ('pending', 'active', 'cooling', 'frozen')
      AND NOT EXISTS (SELECT 1 FROM memory_fragment_sources fs WHERE fs.fragment_id = f.id)
  `).get()?.count ?? 0)
  const noEvidenceStates = Number(db.prepare(`
    SELECT COUNT(*) AS count FROM memory_states st
    WHERE st.status IN ('pending', 'active')
      AND NOT EXISTS (SELECT 1 FROM memory_state_sources ss WHERE ss.state_id = st.id)
      AND NOT EXISTS (SELECT 1 FROM memory_state_fragments sf WHERE sf.state_id = st.id)
  `).get()?.count ?? 0)
  const noEvidenceRelations = Number(db.prepare(`
    SELECT COUNT(*) AS count FROM memory_relations r
    WHERE r.status = 'active'
      AND NOT EXISTS (SELECT 1 FROM memory_relation_sources rs WHERE rs.relation_id = r.id)
      AND NOT EXISTS (SELECT 1 FROM memory_relation_fragments rf WHERE rf.relation_id = r.id)
  `).get()?.count ?? 0)
  const brokenSources = Number(db.prepare(`
    SELECT COUNT(*) AS count FROM (
      SELECT fs.source_id FROM memory_fragment_sources fs
      JOIN memory_fragments f ON f.id = fs.fragment_id
      JOIN memory_sources s ON s.id = fs.source_id
      WHERE f.status IN ('pending', 'active', 'cooling', 'frozen') AND s.status = 'deleted'
      UNION ALL
      SELECT ss.source_id FROM memory_state_sources ss
      JOIN memory_states st ON st.id = ss.state_id
      JOIN memory_sources s ON s.id = ss.source_id
      WHERE st.status IN ('pending', 'active') AND s.status = 'deleted'
      UNION ALL
      SELECT rs.source_id FROM memory_relation_sources rs
      JOIN memory_relations r ON r.id = rs.relation_id
      JOIN memory_sources s ON s.id = rs.source_id
      WHERE r.status = 'active' AND s.status = 'deleted'
    )
  `).get()?.count ?? 0)
  const expiredStates = Number(db.prepare(`
    SELECT COUNT(*) AS count FROM memory_states
    WHERE status IN ('pending', 'active') AND expires_at IS NOT NULL AND expires_at <= ?
  `).get(now)?.count ?? 0)
  return {
    noEvidence: noEvidenceFragments + noEvidenceStates + noEvidenceRelations,
    noEvidenceFragments,
    noEvidenceStates,
    noEvidenceRelations,
    brokenSources,
    mergeCycles: countMergeCycles(db),
    expiredStates,
  }
}

export function loadMemoryCenterData(db: MemoryV2Database) {
  const core = db.prepare("SELECT * FROM core_profile WHERE id = 1").get() ?? null
  const coreFacts = db.prepare(`SELECT * FROM core_facts WHERE status IN ('pending', 'active') ORDER BY pinned DESC, updated_at DESC`).all()
  const states = db.prepare(`SELECT * FROM memory_states WHERE status IN ('pending', 'active') ORDER BY pinned DESC, importance DESC, updated_at DESC LIMIT 100`).all()
  const archivedStates = db.prepare(`SELECT * FROM memory_states WHERE status IN ('resolved', 'expired', 'superseded') ORDER BY updated_at DESC LIMIT 200`).all()
  const fragments = db.prepare(`
    SELECT f.*, GROUP_CONCAT(DISTINCT e.canonical_name) AS entities
    FROM memory_fragments f
    LEFT JOIN memory_fragment_entities fe ON fe.fragment_id = f.id
    LEFT JOIN memory_entities e ON e.id = fe.entity_id
    WHERE f.status IN ('pending', 'active')
    GROUP BY f.id ORDER BY f.pinned DESC, f.updated_at DESC LIMIT 300
  `).all()
  const archivedFragments = db.prepare(`
    SELECT f.*, GROUP_CONCAT(DISTINCT e.canonical_name) AS entities
    FROM memory_fragments f
    LEFT JOIN memory_fragment_entities fe ON fe.fragment_id = f.id
    LEFT JOIN memory_entities e ON e.id = fe.entity_id
    WHERE f.status IN ('cooling', 'frozen', 'superseded', 'tombstone')
    GROUP BY f.id ORDER BY f.updated_at DESC LIMIT 300
  `).all()
  const entities = db.prepare(`
    SELECT e.*, COUNT(DISTINCT fe.fragment_id) AS fragment_count
    FROM memory_entities e
    LEFT JOIN memory_fragment_entities fe ON fe.entity_id = e.id
    WHERE e.status IN ('seed', 'active')
    GROUP BY e.id ORDER BY fragment_count DESC, e.updated_at DESC LIMIT 200
  `).all()
  const archivedRelations = db.prepare(`
    SELECT r.*, source.canonical_name AS source_name, target.canonical_name AS target_name
    FROM memory_relations r
    JOIN memory_entities source ON source.id = r.source_entity_id
    JOIN memory_entities target ON target.id = r.target_entity_id
    WHERE r.status IN ('superseded', 'deleted')
    ORDER BY r.updated_at DESC LIMIT 200
  `).all()
  const episodes = db.prepare(`
    SELECT e.*, COUNT(DISTINCT ef.fragment_id) AS fragment_count
    FROM memory_episodes e
    LEFT JOIN memory_episode_fragments ef ON ef.episode_id = e.id
    WHERE e.status <> 'superseded'
    GROUP BY e.id ORDER BY COALESCE(e.ends_at, e.starts_at, e.created_at) DESC LIMIT 200
  `).all()
  const sagas = db.prepare(`
    SELECT s.*, COUNT(DISTINCT se.episode_id) AS episode_count
    FROM memory_sagas s
    LEFT JOIN memory_saga_episodes se ON se.saga_id = s.id
    WHERE s.status <> 'superseded'
    GROUP BY s.id ORDER BY s.updated_at DESC LIMIT 100
  `).all()
  const archives = db.prepare(`
    SELECT d.*, a.topic_summary, a.message_count, a.created_at AS archived_at
    FROM deleted_conversations d
    LEFT JOIN conversation_archives a ON a.id = d.archive_id
    ORDER BY d.deleted_at DESC LIMIT 100
  `).all()
  const jobs = db.prepare(`
    SELECT id, job_type, status, attempt_count, next_run_at, last_error, updated_at
    FROM memory_jobs WHERE status IN ('pending', 'running', 'failed')
    ORDER BY CASE status WHEN 'failed' THEN 0 ELSE 1 END, priority DESC, updated_at DESC LIMIT 100
  `).all()
  const metaRows = db.prepare("SELECT key, value, updated_at FROM memory_meta ORDER BY key").all()
  const meta = Object.fromEntries(metaRows.map((row) => [String(row.key), { value: row.value, updatedAt: row.updated_at }]))
  const vectorCounts = Object.fromEntries(db.prepare(`
    SELECT status, COUNT(*) AS count FROM memory_vector_index GROUP BY status
  `).all().map((row) => [String(row.status), Number(row.count)]))
  let vectorReconcile: Record<string, unknown> | null = null
  try {
    const raw = meta["archivist.lastVectorReconcile"]?.value
    if (raw) vectorReconcile = JSON.parse(String(raw)) as Record<string, unknown>
  } catch { /* invalid diagnostics must not break the memory center */ }

  return {
    core,
    coreFacts,
    states,
    archivedStates,
    fragments,
    archivedFragments,
    entities,
    archivedRelations,
    episodes,
    sagas,
    pending: listPendingMemories(db),
    archives,
    revisions: db.prepare("SELECT * FROM memory_revisions ORDER BY created_at DESC LIMIT 100").all(),
    system: {
      paused: isMemoryAutomationPaused(),
      counts: {
        pendingScribe: count(db, "memory_event_log", "status IN ('pending', 'processing')"),
        coreFacts: count(db, "core_facts", "status IN ('pending', 'active')"),
        claims: count(db, "memory_claims", "status IN ('pending', 'active')"),
        states: count(db, "memory_states", "status IN ('pending', 'active')"),
        fragments: count(db, "memory_fragments", "status IN ('pending', 'active', 'cooling', 'frozen')"),
        entities: count(db, "memory_entities", "status IN ('seed', 'active')"),
        episodes: count(db, "memory_episodes", "status IN ('draft', 'active', 'mature', 'archived')"),
        sagas: count(db, "memory_sagas", "status IN ('draft', 'active', 'archived')"),
        pending:
          count(db, "memory_fragments", "status = 'pending'") +
          count(db, "core_facts", "status = 'pending'") +
          count(db, "memory_relations", "status = 'pending'") +
          count(db, "memory_states", "status = 'pending'"),
        archives: count(db, "conversation_archives"),
      },
      jobs,
      meta,
      vector: {
        counts: vectorCounts,
        reconcile: vectorReconcile,
      },
      shadowRecall: loadShadowRecallSummary(db),
      backgroundModel: loadMemoryBackgroundMetrics(db),
      databaseBytes: databaseFootprintBytes(db),
      diagnostics: loadMemoryDiagnostics(db),
    },
  }
}

function revision(
  db: MemoryV2Database,
  targetType: string,
  targetId: string,
  action: string,
  before: unknown,
  after: unknown,
  reason: string,
  now: number,
): void {
  db.prepare(`INSERT INTO memory_revisions(
    id, target_type, target_id, action, before_json, after_json,
    reason, confidence, actor, source_id, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'user', NULL, ?)`)
    .run(`revision_${randomUUID()}`, targetType, targetId, action, JSON.stringify(before), JSON.stringify(after), reason, now)
}

export function editMemoryCenterItem(
  db: MemoryV2Database,
  type: EditableMemoryType,
  id: string,
  patch: Record<string, unknown>,
  now = Date.now(),
): boolean {
  return db.transaction(() => {
    if (type === "core") {
      if (id !== "1") {
        const before = db.prepare("SELECT * FROM core_facts WHERE id = ? AND status IN ('pending', 'active')").get(id)
        if (!before || typeof patch.value !== "string" || !patch.value.trim()) return false
        db.prepare("UPDATE core_facts SET value = ?, status = 'active', updated_at = ? WHERE id = ?").run(patch.value.trim(), now, id)
        const after = db.prepare("SELECT * FROM core_facts WHERE id = ?").get(id)
        revision(db, "core_fact", id, "manual_edit", before, after, "User edited Core fact", now)
        return true
      }
      const field = typeof patch.field === "string" ? patch.field : ""
      const column = CORE_COLUMNS[field]
      if (!column || typeof patch.value !== "string") return false
      db.prepare("INSERT OR IGNORE INTO core_profile(id, updated_at) VALUES (1, ?)").run(now)
      const before = db.prepare(`SELECT ${column} AS value FROM core_profile WHERE id = 1`).get()
      db.prepare(`UPDATE core_profile SET ${column} = ?, updated_at = ? WHERE id = 1`).run(patch.value.trim(), now)
      const after = { value: patch.value.trim() }
      revision(db, "core_profile", "1", `manual_update_${field}`, before, after, "User edited Core Profile", now)
      return true
    }

    if (type === "state") {
      const before = db.prepare("SELECT * FROM memory_states WHERE id = ?").get(id)
      if (!before) return false
      const content = typeof patch.content === "string" ? patch.content.trim() : String(before.content)
      const pinned = typeof patch.pinned === "boolean" ? Number(patch.pinned) : Number(before.pinned)
      const expiresAt = patch.expiresAt === null ? null : Number.isFinite(Number(patch.expiresAt)) ? Number(patch.expiresAt) : before.expires_at
      if (!content) return false
      const contentChanged = content !== String(before.content)
      const claimId = contentChanged
        ? ensureMemoryClaim(db, {
            content,
            claimType: String(before.state_type),
            confidence: 1,
            status: "active",
            now,
            metadata: { manual: true },
          })
        : before.claim_id
      db.prepare("UPDATE memory_states SET claim_id = ?, content = ?, pinned = ?, expires_at = ?, updated_at = ? WHERE id = ?")
        .run(claimId ?? null, content, pinned, expiresAt, now, id)
      if (contentChanged) {
        db.prepare("DELETE FROM memory_state_fragments WHERE state_id = ?").run(id)
        if (claimId) attachStateToClaim(db, id, String(claimId), now)
      }
      const after = db.prepare("SELECT * FROM memory_states WHERE id = ?").get(id)
      revision(db, "state", id, "manual_edit", before, after, "User edited Current State", now)
      return true
    }

    const before = db.prepare("SELECT * FROM memory_fragments WHERE id = ? AND status <> 'tombstone'").get(id)
    if (!before) return false
    const content = typeof patch.content === "string" ? patch.content.trim() : String(before.content)
    const pinned = typeof patch.pinned === "boolean" ? Number(patch.pinned) : Number(before.pinned)
    if (!content || content.length > 500) return false
    const contentChanged = content !== String(before.content)
    db.prepare(`
      UPDATE memory_fragments
      SET content = ?, pinned = ?, revision = revision + ?, updated_at = ?
      WHERE id = ?
    `).run(content, pinned, contentChanged ? 1 : 0, now, id)
    if (contentChanged) {
      invalidateFragmentProjections(db, id, "content_changed", now)
      const claimId = ensureMemoryClaim(db, {
        content,
        claimType: String(before.kind),
        confidence: 1,
        status: "active",
        now,
        metadata: { manual: true },
      })
      attachFragmentToClaim(db, id, claimId, now)
      enqueueVectorUpsert(db, "fragment", id, now, 80)
    }
    const after = db.prepare("SELECT * FROM memory_fragments WHERE id = ?").get(id)
    revision(db, "fragment", id, "manual_edit", before, after, "User edited Fragment", now)
    return true
  })
}

export function expireMemoryState(db: MemoryV2Database, id: string, now = Date.now()): boolean {
  return db.transaction(() => {
    const before = db.prepare("SELECT * FROM memory_states WHERE id = ? AND status IN ('pending', 'active')").get(id)
    if (!before) return false
    db.prepare("UPDATE memory_states SET status = 'expired', resolved_at = ?, updated_at = ? WHERE id = ?").run(now, now, id)
    revision(db, "state", id, "expire", before, { status: "expired" }, "User expired Current State", now)
    return true
  })
}

export function restoreMemoryState(db: MemoryV2Database, id: string, now = Date.now()): boolean {
  return db.transaction(() => {
    const before = db.prepare("SELECT * FROM memory_states WHERE id = ? AND status IN ('resolved', 'expired', 'superseded')").get(id)
    if (!before) return false
    db.prepare(`
      UPDATE memory_states
      SET status = 'active', resolved_at = NULL, expires_at = NULL, pinned = 1, updated_at = ?
      WHERE id = ?
    `).run(now, id)
    const after = db.prepare("SELECT * FROM memory_states WHERE id = ?").get(id)
    revision(db, "state", id, "restore", before, after, "User restored and pinned a historical Current State", now)
    return true
  })
}

export function forgetMemoryFragment(db: MemoryV2Database, id: string, now = Date.now()): boolean {
  return db.transaction(() => {
    const before = db.prepare("SELECT * FROM memory_fragments WHERE id = ? AND status <> 'tombstone'").get(id)
    if (!before) return false
    const content = String(before.content)
    const hash = createHash("sha256").update(content).digest("hex")
    db.prepare(`UPDATE memory_fragments
      SET status = 'tombstone', content = '[forgotten memory]', revision = revision + 1, updated_at = ?,
          metadata_json = json_set(metadata_json, '$.tombstonedAt', ?, '$.contentHash', ?, '$.originalLength', ?)
      WHERE id = ?`).run(now, now, hash, content.length, id)
    invalidateFragmentProjections(db, id, "tombstone", now)
    db.prepare(`
      UPDATE memory_sources SET status = 'deleted', quote = ''
      WHERE id IN (SELECT source_id FROM memory_fragment_sources WHERE fragment_id = ?)
        AND NOT EXISTS (
          SELECT 1 FROM memory_fragment_sources other
          JOIN memory_fragments f ON f.id = other.fragment_id
          WHERE other.source_id = memory_sources.id
            AND other.fragment_id <> ?
            AND f.status IN ('pending', 'active', 'cooling', 'frozen')
        )
    `).run(id, id)
    revision(db, "fragment", id, "forget", before, { status: "tombstone", contentHash: hash }, "User requested forgetting", now)
    enqueueVectorDelete(db, "fragment", id, now, 100)
    return true
  })
}

export function loadMemoryItemDetail(db: MemoryV2Database, type: string, id: string) {
  const revisions = db.prepare("SELECT * FROM memory_revisions WHERE target_type = ? AND target_id = ? ORDER BY created_at DESC").all(type, id)
  let sources: Array<Record<string, unknown>> = []
  if (type === "fragment") {
    sources = db.prepare(`SELECT s.*, fs.evidence_role FROM memory_fragment_sources fs JOIN memory_sources s ON s.id = fs.source_id WHERE fs.fragment_id = ? ORDER BY s.occurred_at DESC`).all(id)
  } else if (type === "state") {
    sources = db.prepare(`SELECT s.* FROM memory_state_sources ss JOIN memory_sources s ON s.id = ss.source_id WHERE ss.state_id = ? ORDER BY s.occurred_at DESC`).all(id)
  } else if (type === "episode") {
    sources = db.prepare(`SELECT s.* FROM memory_episode_sources es JOIN memory_sources s ON s.id = es.source_id WHERE es.episode_id = ? ORDER BY s.occurred_at DESC`).all(id)
  } else if (type === "relation") {
    sources = db.prepare(`SELECT s.* FROM memory_relation_sources rs JOIN memory_sources s ON s.id = rs.source_id WHERE rs.relation_id = ? ORDER BY s.occurred_at DESC`).all(id)
  } else if (type === "entity") {
    sources = db.prepare(`
      SELECT DISTINCT s.* FROM memory_fragment_entities fe
      JOIN memory_fragment_sources fs ON fs.fragment_id = fe.fragment_id
      JOIN memory_sources s ON s.id = fs.source_id
      WHERE fe.entity_id = ? ORDER BY s.occurred_at DESC
    `).all(id)
  } else if (type === "saga") {
    sources = db.prepare(`
      SELECT DISTINCT src.* FROM memory_saga_episodes se
      JOIN memory_episode_sources es ON es.episode_id = se.episode_id
      JOIN memory_sources src ON src.id = es.source_id
      WHERE se.saga_id = ? ORDER BY src.occurred_at DESC
    `).all(id)
  }
  const claim = type === "fragment"
    ? db.prepare(`SELECT c.* FROM memory_fragments f LEFT JOIN memory_claims c ON c.id = f.claim_id WHERE f.id = ?`).get(id)
    : type === "state"
      ? db.prepare(`SELECT c.* FROM memory_states st LEFT JOIN memory_claims c ON c.id = st.claim_id WHERE st.id = ?`).get(id)
      : type === "relation"
        ? db.prepare(`SELECT c.* FROM memory_relations r LEFT JOIN memory_claims c ON c.id = r.claim_id WHERE r.id = ?`).get(id)
        : null
  const dependencies = type === "fragment"
    ? {
        states: db.prepare(`SELECT st.*, sf.fragment_revision, sf.evidence_role FROM memory_state_fragments sf JOIN memory_states st ON st.id = sf.state_id WHERE sf.fragment_id = ?`).all(id),
        relations: db.prepare(`SELECT r.*, rf.fragment_revision, rf.evidence_role FROM memory_relation_fragments rf JOIN memory_relations r ON r.id = rf.relation_id WHERE rf.fragment_id = ?`).all(id),
        episodes: db.prepare(`SELECT ep.*, ef.position FROM memory_episode_fragments ef JOIN memory_episodes ep ON ep.id = ef.episode_id WHERE ef.fragment_id = ?`).all(id),
      }
    : type === "state"
      ? db.prepare(`SELECT f.*, sf.fragment_revision, sf.evidence_role FROM memory_state_fragments sf JOIN memory_fragments f ON f.id = sf.fragment_id WHERE sf.state_id = ?`).all(id)
      : type === "relation"
        ? db.prepare(`SELECT f.*, rf.fragment_revision, rf.evidence_role FROM memory_relation_fragments rf JOIN memory_fragments f ON f.id = rf.fragment_id WHERE rf.relation_id = ?`).all(id)
        : type === "episode"
          ? {
              fragments: db.prepare(`SELECT f.*, ef.position FROM memory_episode_fragments ef JOIN memory_fragments f ON f.id = ef.fragment_id WHERE ef.episode_id = ? ORDER BY ef.position`).all(id),
              sagas: db.prepare(`SELECT s.*, se.position FROM memory_saga_episodes se JOIN memory_sagas s ON s.id = se.saga_id WHERE se.episode_id = ?`).all(id),
            }
          : type === "saga"
            ? db.prepare(`SELECT ep.*, se.position FROM memory_saga_episodes se JOIN memory_episodes ep ON ep.id = se.episode_id WHERE se.saga_id = ? ORDER BY se.position`).all(id)
            : type === "entity"
              ? {
                  fragments: db.prepare(`SELECT f.*, fe.role FROM memory_fragment_entities fe JOIN memory_fragments f ON f.id = fe.fragment_id WHERE fe.entity_id = ? ORDER BY f.updated_at DESC`).all(id),
                  relations: db.prepare(`
                    SELECT r.*, source.canonical_name AS source_name, target.canonical_name AS target_name
                    FROM memory_relations r
                    JOIN memory_entities source ON source.id = r.source_entity_id
                    JOIN memory_entities target ON target.id = r.target_entity_id
                    WHERE r.source_entity_id = ? OR r.target_entity_id = ?
                    ORDER BY r.updated_at DESC
                  `).all(id, id),
                }
              : []
  return { sources, revisions, claim, dependencies }
}
