import { createHash, randomUUID } from "crypto"
import type { MemoryV2Database } from "./database"

export type ClaimMemberType = "fragment" | "state" | "relation"
export type FragmentInvalidationReason = "content_changed" | "superseded" | "tombstone"

export interface EnsureClaimInput {
  content: string
  claimType: string
  confidence: number
  status?: "pending" | "active"
  metadata?: Record<string, unknown>
  now?: number
}

export interface ProjectionInvalidationResult {
  states: number
  relations: number
  retiredClaims: number
}

export interface ProjectionReconcileResult {
  states: number
  relations: number
  expiredRelations: number
}

export function normalizeClaimText(content: string): string {
  return content
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[\s\u3000]+/g, " ")
    .replace(/[，。；：！？,.!?;:]+$/g, "")
    .trim()
}

export function claimSemanticKey(content: string): string {
  return createHash("sha256").update(normalizeClaimText(content)).digest("hex")
}

export function ensureMemoryClaim(db: MemoryV2Database, input: EnsureClaimInput): string {
  const now = input.now ?? Date.now()
  const canonicalText = input.content.trim().replace(/\s+/g, " ")
  if (!canonicalText) throw new Error("Cannot create a claim from empty content")
  const semanticKey = claimSemanticKey(canonicalText)
  const existing = db.prepare("SELECT id, status FROM memory_claims WHERE semantic_key = ?").get(semanticKey)
  if (existing) {
    db.prepare(`
      UPDATE memory_claims
      SET confidence = MAX(confidence, ?),
          status = CASE WHEN status = 'retired' THEN ? ELSE status END,
          updated_at = ?
      WHERE id = ?
    `).run(input.confidence, input.status ?? "active", now, existing.id)
    return String(existing.id)
  }

  const id = `claim_${randomUUID()}`
  db.prepare(`
    INSERT INTO memory_claims(
      id, semantic_key, canonical_text, claim_type, status, confidence,
      revision, superseded_by, created_at, updated_at, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, 1, NULL, ?, ?, ?)
  `).run(
    id,
    semanticKey,
    canonicalText,
    input.claimType || "fact",
    input.status ?? "active",
    Math.max(0, Math.min(1, input.confidence)),
    now,
    now,
    JSON.stringify(input.metadata ?? {}),
  )
  return id
}

export function attachFragmentToClaim(
  db: MemoryV2Database,
  fragmentId: string,
  claimId: string,
  now = Date.now(),
): void {
  const previous = db.prepare("SELECT claim_id FROM memory_fragments WHERE id = ?").get(fragmentId)
  db.prepare("UPDATE memory_fragments SET claim_id = ?, updated_at = ? WHERE id = ?")
    .run(claimId, now, fragmentId)
  linkClaimProjectionsToFragment(db, fragmentId, claimId, now)
  const previousClaimId = typeof previous?.claim_id === "string" ? previous.claim_id : null
  if (previousClaimId && previousClaimId !== claimId) {
    const remaining = Number(db.prepare(`
      SELECT COUNT(*) AS count FROM memory_fragments
      WHERE claim_id = ? AND status IN ('pending', 'active', 'cooling', 'frozen')
    `).get(previousClaimId)?.count ?? 0)
    if (remaining === 0) {
      db.prepare(`
        UPDATE memory_claims SET status = 'retired', updated_at = ?
        WHERE id = ? AND status IN ('pending', 'active')
      `).run(now, previousClaimId)
    }
  }
}

export function attachStateToClaim(
  db: MemoryV2Database,
  stateId: string,
  claimId: string,
  now = Date.now(),
): void {
  db.prepare("UPDATE memory_states SET claim_id = ?, updated_at = ? WHERE id = ?")
    .run(claimId, now, stateId)
  const fragments = db.prepare(`
    SELECT id, revision FROM memory_fragments
    WHERE claim_id = ? AND status IN ('active', 'cooling', 'frozen')
  `).all(claimId)
  const link = db.prepare(`
    INSERT OR IGNORE INTO memory_state_fragments(
      state_id, fragment_id, fragment_revision, evidence_role, created_at
    ) VALUES (?, ?, ?, 'support', ?)
  `)
  for (const fragment of fragments) link.run(stateId, fragment.id, fragment.revision, now)
}

export function attachRelationToClaim(
  db: MemoryV2Database,
  relationId: string,
  claimId: string,
  now = Date.now(),
): void {
  db.prepare("UPDATE memory_relations SET claim_id = ?, updated_at = ? WHERE id = ?")
    .run(claimId, now, relationId)
  const fragments = db.prepare(`
    SELECT id, revision FROM memory_fragments
    WHERE claim_id = ? AND status IN ('active', 'cooling', 'frozen')
  `).all(claimId)
  const link = db.prepare(`
    INSERT OR IGNORE INTO memory_relation_fragments(
      relation_id, fragment_id, fragment_revision, evidence_role, created_at
    ) VALUES (?, ?, ?, 'support', ?)
  `)
  for (const fragment of fragments) link.run(relationId, fragment.id, fragment.revision, now)
}

export function linkStateToFragment(
  db: MemoryV2Database,
  stateId: string,
  fragmentId: string,
  now = Date.now(),
): boolean {
  const fragment = db.prepare("SELECT claim_id, revision FROM memory_fragments WHERE id = ?").get(fragmentId)
  if (!fragment) return false
  const state = db.prepare("SELECT claim_id FROM memory_states WHERE id = ?").get(stateId)
  if (!state) return false
  if (fragment.claim_id && !state.claim_id) {
    db.prepare("UPDATE memory_states SET claim_id = ?, updated_at = ? WHERE id = ?")
      .run(fragment.claim_id, now, stateId)
  }
  db.prepare(`
    INSERT OR REPLACE INTO memory_state_fragments(
      state_id, fragment_id, fragment_revision, evidence_role, created_at
    ) VALUES (?, ?, ?, 'support', ?)
  `).run(stateId, fragmentId, fragment.revision, now)
  return true
}

export function linkRelationToFragment(
  db: MemoryV2Database,
  relationId: string,
  fragmentId: string,
  now = Date.now(),
): boolean {
  const fragment = db.prepare("SELECT claim_id, revision FROM memory_fragments WHERE id = ?").get(fragmentId)
  if (!fragment) return false
  const relation = db.prepare("SELECT claim_id FROM memory_relations WHERE id = ?").get(relationId)
  if (!relation) return false
  if (fragment.claim_id && !relation.claim_id) {
    db.prepare("UPDATE memory_relations SET claim_id = ?, updated_at = ? WHERE id = ?")
      .run(fragment.claim_id, now, relationId)
  }
  db.prepare(`
    INSERT OR REPLACE INTO memory_relation_fragments(
      relation_id, fragment_id, fragment_revision, evidence_role, created_at
    ) VALUES (?, ?, ?, 'support', ?)
  `).run(relationId, fragmentId, fragment.revision, now)
  db.prepare(`
    INSERT OR IGNORE INTO memory_relation_sources(relation_id, source_id)
    SELECT ?, source_id FROM memory_fragment_sources WHERE fragment_id = ?
  `).run(relationId, fragmentId)
  return true
}

function linkClaimProjectionsToFragment(
  db: MemoryV2Database,
  fragmentId: string,
  claimId: string,
  now: number,
): void {
  const fragment = db.prepare("SELECT revision FROM memory_fragments WHERE id = ?").get(fragmentId)
  if (!fragment) return
  db.prepare(`
    INSERT OR IGNORE INTO memory_state_fragments(
      state_id, fragment_id, fragment_revision, evidence_role, created_at
    )
    SELECT id, ?, ?, 'support', ? FROM memory_states
    WHERE claim_id = ? AND status IN ('pending', 'active')
  `).run(fragmentId, fragment.revision, now, claimId)
  db.prepare(`
    INSERT OR IGNORE INTO memory_relation_fragments(
      relation_id, fragment_id, fragment_revision, evidence_role, created_at
    )
    SELECT id, ?, ?, 'support', ? FROM memory_relations
    WHERE claim_id = ? AND status IN ('pending', 'active')
  `).run(fragmentId, fragment.revision, now, claimId)
}

function systemRevision(
  db: MemoryV2Database,
  targetType: "state" | "relation" | "claim",
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
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'system', NULL, ?)
  `).run(
    `revision_${randomUUID()}`,
    targetType,
    targetId,
    action,
    JSON.stringify(before),
    JSON.stringify(after),
    reason,
    now,
  )
}

function hasValidStateSupport(db: MemoryV2Database, stateId: string): boolean {
  return Number(db.prepare(`
    SELECT COUNT(*) AS count
    FROM memory_state_fragments sf
    JOIN memory_fragments f ON f.id = sf.fragment_id
    WHERE sf.state_id = ?
      AND sf.evidence_role = 'support'
      AND f.status IN ('active', 'cooling', 'frozen')
      AND f.revision = sf.fragment_revision
  `).get(stateId)?.count ?? 0) > 0
}

function hasValidRelationSupport(db: MemoryV2Database, relationId: string): boolean {
  return Number(db.prepare(`
    SELECT COUNT(*) AS count
    FROM memory_relation_fragments rf
    JOIN memory_fragments f ON f.id = rf.fragment_id
    WHERE rf.relation_id = ?
      AND rf.evidence_role = 'support'
      AND f.status IN ('active', 'cooling', 'frozen')
      AND f.revision = rf.fragment_revision
  `).get(relationId)?.count ?? 0) > 0
}

export function invalidateFragmentProjections(
  db: MemoryV2Database,
  fragmentId: string,
  reason: FragmentInvalidationReason,
  now = Date.now(),
): ProjectionInvalidationResult {
  const result: ProjectionInvalidationResult = { states: 0, relations: 0, retiredClaims: 0 }
  const states = db.prepare(`
    SELECT DISTINCT st.id, st.status
    FROM memory_states st
    JOIN memory_state_fragments sf ON sf.state_id = st.id
    WHERE sf.fragment_id = ? AND st.status IN ('pending', 'active')
  `).all(fragmentId)
  for (const state of states) {
    if (hasValidStateSupport(db, String(state.id))) continue
    const nextStatus = reason === "tombstone" ? "expired" : "superseded"
    db.prepare(`
      UPDATE memory_states SET status = ?, resolved_at = ?, updated_at = ? WHERE id = ?
    `).run(nextStatus, now, now, state.id)
    systemRevision(
      db,
      "state",
      String(state.id),
      "invalidate_projection",
      { status: state.status, sourceFragmentId: fragmentId },
      { status: nextStatus },
      `Supporting Fragment became ${reason}.`,
      now,
    )
    result.states += 1
  }

  const relations = db.prepare(`
    SELECT DISTINCT r.id, r.status
    FROM memory_relations r
    JOIN memory_relation_fragments rf ON rf.relation_id = r.id
    WHERE rf.fragment_id = ? AND r.status IN ('pending', 'active')
  `).all(fragmentId)
  for (const relation of relations) {
    if (hasValidRelationSupport(db, String(relation.id))) continue
    const nextStatus = reason === "tombstone" ? "deleted" : "superseded"
    db.prepare("UPDATE memory_relations SET status = ?, updated_at = ? WHERE id = ?")
      .run(nextStatus, now, relation.id)
    systemRevision(
      db,
      "relation",
      String(relation.id),
      "invalidate_projection",
      { status: relation.status, sourceFragmentId: fragmentId },
      { status: nextStatus },
      `Supporting Fragment became ${reason}.`,
      now,
    )
    result.relations += 1
  }

  const claim = db.prepare("SELECT claim_id FROM memory_fragments WHERE id = ?").get(fragmentId)
  if (claim?.claim_id) {
    const remaining = Number(db.prepare(`
      SELECT COUNT(*) AS count FROM memory_fragments
      WHERE claim_id = ? AND status IN ('pending', 'active', 'cooling', 'frozen')
    `).get(claim.claim_id)?.count ?? 0)
    if (remaining === 0) {
      const changed = Number(db.prepare(`
        UPDATE memory_claims SET status = 'retired', updated_at = ?
        WHERE id = ? AND status IN ('pending', 'active')
      `).run(now, claim.claim_id).changes)
      if (changed > 0) {
        systemRevision(
          db,
          "claim",
          String(claim.claim_id),
          "retire",
          { status: "active" },
          { status: "retired" },
          `No current Fragment supports the claim after ${reason}.`,
          now,
        )
        result.retiredClaims += 1
      }
    }
  }
  return result
}

export function backfillMemoryClaims(db: MemoryV2Database, now = Date.now(), options: { transaction?: boolean } = {}): {
  claims: number
  fragments: number
  states: number
  relations: number
} {
  const before = Number(db.prepare("SELECT COUNT(*) AS count FROM memory_claims").get()?.count ?? 0)
  let fragments = 0
  let states = 0
  let relations = 0

  const work = () => {
    for (const fragment of db.prepare("SELECT id, content, kind, confidence FROM memory_fragments WHERE claim_id IS NULL").all()) {
      const claimId = ensureMemoryClaim(db, {
        content: String(fragment.content),
        claimType: String(fragment.kind),
        confidence: Number(fragment.confidence),
        status: "active",
        now,
        metadata: { backfilled: true },
      })
      attachFragmentToClaim(db, String(fragment.id), claimId, now)
      fragments += 1
    }
    for (const state of db.prepare("SELECT id, content, state_type, confidence FROM memory_states WHERE claim_id IS NULL").all()) {
      const claimId = ensureMemoryClaim(db, {
        content: String(state.content),
        claimType: String(state.state_type),
        confidence: Number(state.confidence),
        status: String(state.status) === "pending" ? "pending" : "active",
        now,
        metadata: { backfilled: true },
      })
      attachStateToClaim(db, String(state.id), claimId, now)
      states += 1
    }
    for (const relation of db.prepare(`
      SELECT r.id, r.relation_type, r.confidence,
        source.canonical_name AS source_name, target.canonical_name AS target_name
      FROM memory_relations r
      JOIN memory_entities source ON source.id = r.source_entity_id
      JOIN memory_entities target ON target.id = r.target_entity_id
      WHERE r.claim_id IS NULL
    `).all()) {
      const content = `${String(relation.source_name)} ${String(relation.relation_type)} ${String(relation.target_name)}`
      const claimId = ensureMemoryClaim(db, {
        content,
        claimType: "relationship",
        confidence: Number(relation.confidence),
        status: "active",
        now,
        metadata: { backfilled: true },
      })
      attachRelationToClaim(db, String(relation.id), claimId, now)
      relations += 1
    }
  }
  if (options.transaction === false) work()
  else db.transaction(work)

  const after = Number(db.prepare("SELECT COUNT(*) AS count FROM memory_claims").get()?.count ?? 0)
  return { claims: after - before, fragments, states, relations }
}

export function reconcileProjectionValidity(
  db: MemoryV2Database,
  now = Date.now(),
): ProjectionReconcileResult {
  const result: ProjectionReconcileResult = { states: 0, relations: 0, expiredRelations: 0 }
  const states = db.prepare(`
    SELECT st.id, st.status
    FROM memory_states st
    WHERE st.status IN ('pending', 'active')
      AND EXISTS (SELECT 1 FROM memory_state_fragments sf WHERE sf.state_id = st.id)
      AND NOT EXISTS (
        SELECT 1 FROM memory_state_fragments sf
        JOIN memory_fragments f ON f.id = sf.fragment_id
        WHERE sf.state_id = st.id
          AND sf.evidence_role = 'support'
          AND f.status IN ('active', 'cooling', 'frozen')
          AND f.revision = sf.fragment_revision
      )
  `).all()
  for (const state of states) {
    const hasForgottenSupport = Number(db.prepare(`
      SELECT COUNT(*) AS count FROM memory_state_fragments sf
      JOIN memory_fragments f ON f.id = sf.fragment_id
      WHERE sf.state_id = ? AND f.status = 'tombstone'
    `).get(state.id)?.count ?? 0) > 0
    const nextStatus = hasForgottenSupport ? "expired" : "superseded"
    db.prepare("UPDATE memory_states SET status = ?, resolved_at = ?, updated_at = ? WHERE id = ?")
      .run(nextStatus, now, now, state.id)
    systemRevision(
      db,
      "state",
      String(state.id),
      "reconcile_projection",
      { status: state.status },
      { status: nextStatus },
      "No current Fragment revision supports this State.",
      now,
    )
    result.states += 1
  }

  const relations = db.prepare(`
    SELECT r.id, r.status
    FROM memory_relations r
    WHERE r.status IN ('pending', 'active')
      AND EXISTS (SELECT 1 FROM memory_relation_fragments rf WHERE rf.relation_id = r.id)
      AND NOT EXISTS (
        SELECT 1 FROM memory_relation_fragments rf
        JOIN memory_fragments f ON f.id = rf.fragment_id
        WHERE rf.relation_id = r.id
          AND rf.evidence_role = 'support'
          AND f.status IN ('active', 'cooling', 'frozen')
          AND f.revision = rf.fragment_revision
      )
  `).all()
  for (const relation of relations) {
    const hasForgottenSupport = Number(db.prepare(`
      SELECT COUNT(*) AS count FROM memory_relation_fragments rf
      JOIN memory_fragments f ON f.id = rf.fragment_id
      WHERE rf.relation_id = ? AND f.status = 'tombstone'
    `).get(relation.id)?.count ?? 0) > 0
    const nextStatus = hasForgottenSupport ? "deleted" : "superseded"
    db.prepare("UPDATE memory_relations SET status = ?, updated_at = ? WHERE id = ?")
      .run(nextStatus, now, relation.id)
    systemRevision(
      db,
      "relation",
      String(relation.id),
      "reconcile_projection",
      { status: relation.status },
      { status: nextStatus },
      "No current Fragment revision supports this Relation.",
      now,
    )
    result.relations += 1
  }

  const expiring = db.prepare(`
    SELECT id, status FROM memory_relations
    WHERE status = 'active' AND valid_until IS NOT NULL AND valid_until <= ?
  `).all(now)
  for (const relation of expiring) {
    db.prepare("UPDATE memory_relations SET status = 'deleted', updated_at = ? WHERE id = ?")
      .run(now, relation.id)
    systemRevision(
      db,
      "relation",
      String(relation.id),
      "expire",
      { status: relation.status },
      { status: "deleted" },
      "Relation valid_until elapsed.",
      now,
    )
    result.expiredRelations += 1
  }
  return result
}
