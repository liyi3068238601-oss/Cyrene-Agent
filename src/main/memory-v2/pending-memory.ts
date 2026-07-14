import { randomUUID } from "crypto"
import type { MemoryV2Database } from "./database"
import {
  attachFragmentToClaim,
  ensureMemoryClaim,
  invalidateFragmentProjections,
} from "./claim-graph"
import { enqueueVectorUpsert } from "./vector-sync"

export interface PendingMemoryItem {
  id: string
  content: string
  kind: string
  confidence: number
  createdAt: number
  sourceType: string
  conflictWith?: string
  conflictReason?: string
}

function isSensitiveSummary(text: string): boolean {
  return /敏感内容|密码|验证码|api[ _-]?key|token|authorization|cookie|支付|银行卡/i.test(text)
}

export function proposeScreenObservation(
  db: MemoryV2Database,
  text: string,
  observedAt = Date.now(),
): PendingMemoryItem | null {
  const content = text.trim()
  if (!content || isSensitiveSummary(content)) return null

  const duplicate = db.prepare(`
    SELECT id, content, kind, confidence, created_at
    FROM memory_fragments
    WHERE kind = 'observation' AND status = 'pending' AND content = ?
    ORDER BY created_at DESC LIMIT 1
  `).get(content)
  if (duplicate) {
    return {
      id: String(duplicate.id),
      content: String(duplicate.content),
      kind: String(duplicate.kind),
      confidence: Number(duplicate.confidence),
      createdAt: Number(duplicate.created_at),
      sourceType: "screen",
    }
  }

  const id = `fragment_${randomUUID()}`
  const sourceId = `source_${randomUUID()}`
  db.transaction(() => {
    const claimId = ensureMemoryClaim(db, {
      content,
      claimType: "observation",
      confidence: 0.45,
      status: "pending",
      now: observedAt,
      metadata: { screenObservation: true },
    })
    db.prepare(`
      INSERT INTO memory_sources(
        id, source_type, conversation_id, message_id, occurred_at,
        quote, status, metadata_json
      ) VALUES (?, 'screen', NULL, NULL, ?, ?, 'active', ?)
    `).run(sourceId, observedAt, content.slice(0, 600), JSON.stringify({ screenshotPersisted: false }))
    db.prepare(`
      INSERT INTO memory_fragments(
        id, claim_id, content, kind, certainty, attribution, confidence, importance,
        emotional_weight, status, created_at, updated_at, last_accessed_at,
        access_count, pinned, revision, metadata_json
      ) VALUES (?, ?, ?, 'observation', 'inferred', 'assistant', 0.45, 0.35,
        0.3, 'pending', ?, ?, ?, 0, 0, 1, ?)
    `).run(id, claimId, content, observedAt, observedAt, observedAt, JSON.stringify({ requiresConfirmation: true }))
    db.prepare(`
      INSERT INTO memory_fragment_sources(fragment_id, source_id, evidence_role)
      VALUES (?, ?, 'support')
    `).run(id, sourceId)
    attachFragmentToClaim(db, id, claimId, observedAt)
  })
  return { id, content, kind: "observation", confidence: 0.45, createdAt: observedAt, sourceType: "screen" }
}

export function listPendingMemories(db: MemoryV2Database, limit = 100): PendingMemoryItem[] {
  const fragments = db.prepare(`
    SELECT f.id, f.content, f.kind, f.confidence, f.created_at, f.metadata_json,
           COALESCE(s.source_type, 'unknown') AS source_type
    FROM memory_fragments f
    LEFT JOIN memory_fragment_sources fs ON fs.fragment_id = f.id
    LEFT JOIN memory_sources s ON s.id = fs.source_id
    WHERE f.status = 'pending'
    GROUP BY f.id
    ORDER BY f.created_at DESC
    LIMIT ?
  `).all(Math.max(1, Math.min(500, limit))).map((row) => {
    let metadata: Record<string, unknown> = {}
    try { metadata = JSON.parse(String(row.metadata_json ?? "{}")) as Record<string, unknown> } catch { /* ignore */ }
    return {
      id: String(row.id),
      content: String(row.content),
      kind: String(row.kind),
      confidence: Number(row.confidence),
      createdAt: Number(row.created_at),
      sourceType: String(row.source_type),
      conflictWith: typeof metadata.conflictWith === "string" ? metadata.conflictWith : undefined,
      conflictReason: typeof metadata.conflictReason === "string" ? metadata.conflictReason : undefined,
    }
  })
  const coreFacts = db.prepare(`
    SELECT id, value AS content, 'core_fact' AS kind, confidence, created_at,
           namespace || '.' || key AS conflict_reason
    FROM core_facts WHERE status = 'pending'
    ORDER BY created_at DESC LIMIT ?
  `).all(Math.max(1, Math.min(500, limit))).map((row) => ({
    id: String(row.id),
    content: String(row.content),
    kind: "core_fact",
    confidence: Number(row.confidence),
    createdAt: Number(row.created_at),
    sourceType: "chat",
    conflictReason: `unregistered_key:${String(row.conflict_reason)}`,
  }))
  const relations = db.prepare(`
    SELECT r.id, r.relation_type, r.confidence, r.created_at,
      source.canonical_name AS source_name,
      target.canonical_name AS target_name
    FROM memory_relations r
    JOIN memory_entities source ON source.id = r.source_entity_id
    JOIN memory_entities target ON target.id = r.target_entity_id
    WHERE r.status = 'pending'
    ORDER BY r.created_at DESC LIMIT ?
  `).all(Math.max(1, Math.min(500, limit))).map((row) => ({
    id: String(row.id),
    content: `${String(row.source_name)} ${String(row.relation_type)} ${String(row.target_name)}`,
    kind: "relation",
    confidence: Number(row.confidence),
    createdAt: Number(row.created_at),
    sourceType: "legacy",
    conflictReason: "relation_requires_evidence",
  }))
  return [...fragments, ...coreFacts, ...relations]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, Math.max(1, Math.min(500, limit)))
}

export function confirmPendingMemory(db: MemoryV2Database, id: string, now = Date.now()): boolean {
  return db.transaction(() => {
    const before = db.prepare(`SELECT * FROM memory_fragments WHERE id = ? AND status = 'pending'`).get(id)
    if (!before) {
      const coreBefore = db.prepare("SELECT * FROM core_facts WHERE id = ? AND status = 'pending'").get(id)
      if (coreBefore) {
        db.prepare("UPDATE core_facts SET status = 'active', confidence = MAX(confidence, 0.9), updated_at = ? WHERE id = ?").run(now, id)
        const coreAfter = db.prepare("SELECT * FROM core_facts WHERE id = ?").get(id)
        db.prepare(`INSERT INTO memory_revisions(
          id, target_type, target_id, action, before_json, after_json,
          reason, confidence, actor, source_id, created_at
        ) VALUES (?, 'core_fact', ?, 'confirm', ?, ?, 'User confirmed controlled Core fact', 1, 'user', NULL, ?)`)
          .run(`revision_${randomUUID()}`, id, JSON.stringify(coreBefore), JSON.stringify(coreAfter), now)
        return true
      }
      const relationBefore = db.prepare(`
        SELECT r.*, source.canonical_name AS source_name, target.canonical_name AS target_name
        FROM memory_relations r
        JOIN memory_entities source ON source.id = r.source_entity_id
        JOIN memory_entities target ON target.id = r.target_entity_id
        WHERE r.id = ? AND r.status = 'pending'
      `).get(id)
      if (!relationBefore) return false
      const sourceId = `source_${randomUUID()}`
      const quote = `${String(relationBefore.source_name)} ${String(relationBefore.relation_type)} ${String(relationBefore.target_name)}`
      db.prepare(`
        INSERT INTO memory_sources(
          id, source_type, conversation_id, message_id, occurred_at,
          quote, status, metadata_json
        ) VALUES (?, 'manual', NULL, NULL, ?, ?, 'active', ?)
      `).run(sourceId, now, quote, JSON.stringify({ userConfirmedRelation: id }))
      db.prepare("INSERT INTO memory_relation_sources(relation_id, source_id) VALUES (?, ?)").run(id, sourceId)
      db.prepare(`
        UPDATE memory_relations
        SET status = 'active', confidence = MAX(confidence, 0.9), updated_at = ?,
            metadata_json = json_set(metadata_json, '$.requiresEvidence', json('false'), '$.confirmedAt', ?)
        WHERE id = ?
      `).run(now, now, id)
      if (relationBefore.claim_id) {
        db.prepare("UPDATE memory_claims SET status = 'active', confidence = MAX(confidence, 0.9), updated_at = ? WHERE id = ?")
          .run(now, relationBefore.claim_id)
      }
      const relationAfter = db.prepare("SELECT * FROM memory_relations WHERE id = ?").get(id)
      db.prepare(`INSERT INTO memory_revisions(
        id, target_type, target_id, action, before_json, after_json,
        reason, confidence, actor, source_id, created_at
      ) VALUES (?, 'relation', ?, 'confirm', ?, ?, 'User confirmed a relation that lacked imported evidence', 1, 'user', ?, ?)`)
        .run(`revision_${randomUUID()}`, id, JSON.stringify(relationBefore), JSON.stringify(relationAfter), sourceId, now)
      return true
    }
    let conflictWith: string | undefined
    try {
      const metadata = JSON.parse(String(before.metadata_json ?? "{}")) as Record<string, unknown>
      if (typeof metadata.conflictWith === "string") conflictWith = metadata.conflictWith
    } catch { /* ignore */ }
    db.prepare(`
      UPDATE memory_fragments
      SET status = 'active', certainty = 'explicit', attribution = 'user',
          confidence = MAX(confidence, 0.9), updated_at = ?
      WHERE id = ?
    `).run(now, id)
    if (before.claim_id) {
      db.prepare(`
        UPDATE memory_claims SET status = 'active', confidence = MAX(confidence, 0.9), updated_at = ?
        WHERE id = ?
      `).run(now, before.claim_id)
    }
    if (conflictWith) {
      db.prepare(`
        UPDATE memory_fragments SET status = 'superseded', superseded_by = ?, updated_at = ?
        WHERE id = ? AND status IN ('active', 'cooling', 'frozen')
      `).run(id, now, conflictWith)
      invalidateFragmentProjections(db, conflictWith, "superseded", now)
    }
    const after = db.prepare("SELECT * FROM memory_fragments WHERE id = ?").get(id)
    enqueueVectorUpsert(db, "fragment", id, now, 80)
    db.prepare(`
      INSERT INTO memory_revisions(
        id, target_type, target_id, action, before_json, after_json,
        reason, confidence, actor, source_id, created_at
      ) VALUES (?, 'fragment', ?, 'confirm', ?, ?, '用户确认待定记忆', 1, 'user', NULL, ?)
    `).run(`revision_${randomUUID()}`, id, JSON.stringify(before), JSON.stringify(after), now)
    return true
  })
}

export function rejectPendingMemory(db: MemoryV2Database, id: string, now = Date.now()): boolean {
  return db.transaction(() => {
    const before = db.prepare(`SELECT * FROM memory_fragments WHERE id = ? AND status = 'pending'`).get(id)
    if (!before) {
      const coreBefore = db.prepare("SELECT * FROM core_facts WHERE id = ? AND status = 'pending'").get(id)
      if (coreBefore) {
        db.prepare("UPDATE core_facts SET status = 'deleted', value = '', updated_at = ? WHERE id = ?").run(now, id)
        db.prepare(`INSERT INTO memory_revisions(
          id, target_type, target_id, action, before_json, after_json,
          reason, confidence, actor, source_id, created_at
        ) VALUES (?, 'core_fact', ?, 'reject', ?, NULL, 'User rejected unknown Core fact', 1, 'user', NULL, ?)`)
          .run(`revision_${randomUUID()}`, id, JSON.stringify(coreBefore), now)
        return true
      }
      const relationBefore = db.prepare("SELECT * FROM memory_relations WHERE id = ? AND status = 'pending'").get(id)
      if (!relationBefore) return false
      db.prepare("UPDATE memory_relations SET status = 'deleted', updated_at = ? WHERE id = ?").run(now, id)
      db.prepare(`INSERT INTO memory_revisions(
        id, target_type, target_id, action, before_json, after_json,
        reason, confidence, actor, source_id, created_at
      ) VALUES (?, 'relation', ?, 'reject', ?, ?, 'User rejected an unsupported imported relation', 1, 'user', NULL, ?)`)
        .run(`revision_${randomUUID()}`, id, JSON.stringify(relationBefore), JSON.stringify({ status: "deleted" }), now)
      return true
    }
    db.prepare(`
      UPDATE memory_fragments
      SET status = 'tombstone', content = '', revision = revision + 1, updated_at = ?
      WHERE id = ?
    `).run(now, id)
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
    db.prepare(`
      INSERT INTO memory_revisions(
        id, target_type, target_id, action, before_json, after_json,
        reason, confidence, actor, source_id, created_at
      ) VALUES (?, 'fragment', ?, 'reject', ?, NULL, '用户拒绝待定记忆', 1, 'user', NULL, ?)
    `).run(`revision_${randomUUID()}`, id, JSON.stringify(before), now)
    return true
  })
}
