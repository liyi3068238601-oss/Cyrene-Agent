import { randomUUID } from "crypto"
import type { MemoryV2Database } from "./database"
import { invalidateFragmentProjections } from "./claim-graph"
import { enqueueVectorDelete, enqueueVectorUpsert } from "./vector-sync"

export function mergeMemoryFragments(
  db: MemoryV2Database,
  sourceId: string,
  targetId: string,
  now = Date.now(),
): boolean {
  if (!sourceId || !targetId || sourceId === targetId) return false
  return db.transaction(() => {
    const source = db.prepare(`SELECT * FROM memory_fragments WHERE id = ? AND status IN ('pending', 'active', 'cooling', 'frozen')`).get(sourceId)
    const target = db.prepare(`SELECT * FROM memory_fragments WHERE id = ? AND status IN ('pending', 'active', 'cooling', 'frozen')`).get(targetId)
    if (!source || !target || source.kind !== target.kind) return false

    const sourceClaimId = typeof source.claim_id === "string" ? source.claim_id : null
    const targetClaimId = typeof target.claim_id === "string" ? target.claim_id : null
    if (sourceClaimId && targetClaimId && sourceClaimId !== targetClaimId) {
      db.prepare("UPDATE memory_fragments SET claim_id = ?, updated_at = ? WHERE claim_id = ?").run(targetClaimId, now, sourceClaimId)
      db.prepare("UPDATE memory_states SET claim_id = ?, updated_at = ? WHERE claim_id = ?").run(targetClaimId, now, sourceClaimId)
      db.prepare("UPDATE memory_relations SET claim_id = ?, updated_at = ? WHERE claim_id = ?").run(targetClaimId, now, sourceClaimId)
      db.prepare(`
        UPDATE memory_claims SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE id = ?
      `).run(targetClaimId, now, sourceClaimId)
      db.prepare(`
        UPDATE memory_claims
        SET confidence = MAX(confidence, ?), revision = revision + 1, updated_at = ?
        WHERE id = ?
      `).run(source.confidence, now, targetClaimId)
    } else if (sourceClaimId && !targetClaimId) {
      db.prepare("UPDATE memory_fragments SET claim_id = ?, updated_at = ? WHERE id = ?").run(sourceClaimId, now, targetId)
    }

    db.prepare(`INSERT OR IGNORE INTO memory_fragment_sources(fragment_id, source_id, evidence_role)
      SELECT ?, source_id, evidence_role FROM memory_fragment_sources WHERE fragment_id = ?`).run(targetId, sourceId)
    db.prepare(`INSERT OR IGNORE INTO memory_fragment_entities(fragment_id, entity_id, role, confidence)
      SELECT ?, entity_id, role, confidence FROM memory_fragment_entities WHERE fragment_id = ?`).run(targetId, sourceId)
    db.prepare(`INSERT OR IGNORE INTO memory_episode_fragments(episode_id, fragment_id, position)
      SELECT episode_id, ?, position FROM memory_episode_fragments WHERE fragment_id = ?`).run(targetId, sourceId)
    db.prepare(`INSERT OR IGNORE INTO memory_state_fragments(state_id, fragment_id, fragment_revision, evidence_role, created_at)
      SELECT state_id, ?, ?, evidence_role, ? FROM memory_state_fragments WHERE fragment_id = ?`)
      .run(targetId, target.revision, now, sourceId)
    db.prepare(`INSERT OR IGNORE INTO memory_relation_fragments(relation_id, fragment_id, fragment_revision, evidence_role, created_at)
      SELECT relation_id, ?, ?, evidence_role, ? FROM memory_relation_fragments WHERE fragment_id = ?`)
      .run(targetId, target.revision, now, sourceId)
    db.prepare("DELETE FROM memory_episode_fragments WHERE fragment_id = ?").run(sourceId)
    db.prepare(`
      UPDATE memory_fragments
      SET confidence = MAX(confidence, ?), importance = MAX(importance, ?), updated_at = ?
      WHERE id = ?
    `).run(source.confidence, source.importance, now, targetId)
    db.prepare(`
      UPDATE memory_fragments SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE id = ?
    `).run(targetId, now, sourceId)
    invalidateFragmentProjections(db, sourceId, "superseded", now)

    db.prepare(`INSERT INTO memory_revisions(
      id, target_type, target_id, action, before_json, after_json,
      reason, confidence, actor, source_id, created_at
    ) VALUES (?, 'fragment', ?, 'manual_merge', ?, ?, ?, 1, 'user', NULL, ?)`)
      .run(
        `revision_${randomUUID()}`,
        sourceId,
        JSON.stringify(source),
        JSON.stringify({ status: "superseded", supersededBy: targetId }),
        "User merged this Fragment into a canonical Fragment; evidence and dependencies were preserved.",
        now,
      )
    enqueueVectorDelete(db, "fragment", sourceId, now, 100)
    enqueueVectorUpsert(db, "fragment", targetId, now, 90)
    return true
  })
}
