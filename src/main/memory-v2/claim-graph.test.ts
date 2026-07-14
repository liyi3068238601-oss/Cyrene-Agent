import { afterEach, describe, expect, it } from "vitest"
import { MemoryV2Database } from "./database"
import {
  attachFragmentToClaim,
  attachRelationToClaim,
  attachStateToClaim,
  ensureMemoryClaim,
  invalidateFragmentProjections,
  reconcileProjectionValidity,
} from "./claim-graph"

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
    ) VALUES (?, ?, 'plan', 'explicit', 'user', 0.9, 0.8, 0.5,
      'active', ?, ?, ?, 0, 0, 1, '{}')
  `).run(id, content, now, now, now)
}

function insertState(db: MemoryV2Database, id: string, content: string, now: number): void {
  db.prepare(`
    INSERT INTO memory_states(
      id, state_type, content, status, confidence, importance, starts_at,
      expires_at, pinned, created_at, updated_at, metadata_json
    ) VALUES (?, 'plan', ?, 'active', 0.9, 0.8, ?, ?, 0, ?, ?, '{}')
  `).run(id, content, now, now + 30_000, now, now)
}

function insertRelation(db: MemoryV2Database, id: string, now: number): void {
  for (const [entityId, name] of [["user", "User"], ["project", "Project"]]) {
    db.prepare(`
      INSERT OR IGNORE INTO memory_entities(
        id, canonical_name, entity_type, aliases_json, overview, status,
        confidence, created_at, updated_at
      ) VALUES (?, ?, 'concept', '[]', '', 'active', 0.9, ?, ?)
    `).run(entityId, name, now, now)
  }
  db.prepare(`
    INSERT INTO memory_relations(
      id, source_entity_id, relation_type, target_entity_id, confidence,
      status, created_at, updated_at, metadata_json
    ) VALUES (?, 'user', 'works_on', 'project', 0.9, 'active', ?, ?, '{}')
  `).run(id, now, now)
}

describe("Memory v2 claim graph", () => {
  it("groups equivalent State and Fragment projections under one claim", () => {
    const db = createDatabase()
    const now = Date.UTC(2026, 6, 14)
    const content = "User is currently building Cyrene Memory v2"
    insertFragment(db, "fragment", content, now)
    insertState(db, "state", content, now)

    const fragmentClaim = ensureMemoryClaim(db, { content, claimType: "plan", confidence: 0.9, now })
    const stateClaim = ensureMemoryClaim(db, { content: `${content}.`, claimType: "plan", confidence: 0.8, now })
    expect(stateClaim).toBe(fragmentClaim)

    attachFragmentToClaim(db, "fragment", fragmentClaim, now)
    attachStateToClaim(db, "state", stateClaim, now)

    expect(db.prepare("SELECT claim_id FROM memory_states WHERE id = 'state'").get()?.claim_id).toBe(fragmentClaim)
    expect(db.prepare("SELECT fragment_revision FROM memory_state_fragments WHERE state_id = 'state'").get()?.fragment_revision).toBe(1)
  })

  it("invalidates projections when their only supporting Fragment revision changes", () => {
    const db = createDatabase()
    const now = Date.UTC(2026, 6, 14)
    const content = "User is currently building Cyrene Memory v2"
    insertFragment(db, "fragment", content, now)
    insertState(db, "state", content, now)
    insertRelation(db, "relation", now)
    const claimId = ensureMemoryClaim(db, { content, claimType: "plan", confidence: 0.9, now })
    attachFragmentToClaim(db, "fragment", claimId, now)
    attachStateToClaim(db, "state", claimId, now)
    attachRelationToClaim(db, "relation", claimId, now)

    db.prepare("UPDATE memory_fragments SET content = 'Updated claim', revision = 2, updated_at = ? WHERE id = 'fragment'").run(now + 1)
    const result = invalidateFragmentProjections(db, "fragment", "content_changed", now + 1)

    expect(result).toMatchObject({ states: 1, relations: 1 })
    expect(db.prepare("SELECT status FROM memory_states WHERE id = 'state'").get()?.status).toBe("superseded")
    expect(db.prepare("SELECT status FROM memory_relations WHERE id = 'relation'").get()?.status).toBe("superseded")
  })

  it("keeps projections valid while another current Fragment still supports the claim", () => {
    const db = createDatabase()
    const now = Date.UTC(2026, 6, 14)
    const content = "User is currently building Cyrene Memory v2"
    insertFragment(db, "first", content, now)
    insertFragment(db, "second", content, now)
    insertState(db, "state", content, now)
    const claimId = ensureMemoryClaim(db, { content, claimType: "plan", confidence: 0.9, now })
    attachFragmentToClaim(db, "first", claimId, now)
    attachFragmentToClaim(db, "second", claimId, now)
    attachStateToClaim(db, "state", claimId, now)

    db.prepare("UPDATE memory_fragments SET status = 'superseded' WHERE id = 'first'").run()
    const result = invalidateFragmentProjections(db, "first", "superseded", now + 1)

    expect(result.states).toBe(0)
    expect(db.prepare("SELECT status FROM memory_states WHERE id = 'state'").get()?.status).toBe("active")
  })

  it("expires State and deletes Relation after the last supporting Fragment is forgotten", () => {
    const db = createDatabase()
    const now = Date.UTC(2026, 6, 14)
    const content = "User is currently building Cyrene Memory v2"
    insertFragment(db, "fragment", content, now)
    insertState(db, "state", content, now)
    insertRelation(db, "relation", now)
    const claimId = ensureMemoryClaim(db, { content, claimType: "plan", confidence: 0.9, now })
    attachFragmentToClaim(db, "fragment", claimId, now)
    attachStateToClaim(db, "state", claimId, now)
    attachRelationToClaim(db, "relation", claimId, now)

    db.prepare("UPDATE memory_fragments SET status = 'tombstone', revision = 2 WHERE id = 'fragment'").run()
    const result = invalidateFragmentProjections(db, "fragment", "tombstone", now + 1)

    expect(result).toMatchObject({ states: 1, relations: 1, retiredClaims: 1 })
    expect(db.prepare("SELECT status FROM memory_states WHERE id = 'state'").get()?.status).toBe("expired")
    expect(db.prepare("SELECT status FROM memory_relations WHERE id = 'relation'").get()?.status).toBe("deleted")
    expect(db.prepare("SELECT status FROM memory_claims WHERE id = ?").get(claimId)?.status).toBe("retired")
  })

  it("repairs missed revision invalidations and enforces Relation valid_until", () => {
    const db = createDatabase()
    const now = Date.UTC(2026, 6, 14)
    const content = "User is currently building Cyrene Memory v2"
    insertFragment(db, "fragment", content, now)
    insertState(db, "state", content, now)
    insertRelation(db, "derived-relation", now)
    insertRelation(db, "timed-relation", now)
    const claimId = ensureMemoryClaim(db, { content, claimType: "plan", confidence: 0.9, now })
    attachFragmentToClaim(db, "fragment", claimId, now)
    attachStateToClaim(db, "state", claimId, now)
    attachRelationToClaim(db, "derived-relation", claimId, now)
    db.prepare("UPDATE memory_relations SET valid_until = ? WHERE id = 'timed-relation'").run(now - 1)

    // Simulate an older code path that changed the Fragment without cascading.
    db.prepare("UPDATE memory_fragments SET revision = 2 WHERE id = 'fragment'").run()
    const result = reconcileProjectionValidity(db, now)

    expect(result).toEqual({ states: 1, relations: 1, expiredRelations: 1 })
    expect(db.prepare("SELECT status FROM memory_states WHERE id = 'state'").get()?.status).toBe("superseded")
    expect(db.prepare("SELECT status FROM memory_relations WHERE id = 'derived-relation'").get()?.status).toBe("superseded")
    expect(db.prepare("SELECT status FROM memory_relations WHERE id = 'timed-relation'").get()?.status).toBe("deleted")
  })
})
