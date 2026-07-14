import { describe, expect, it } from "vitest"
import { MemoryV2Database } from "./database"
import { mergeMemoryFragments } from "./fragment-merge"
import { ensureMemoryClaim, linkStateToFragment } from "./claim-graph"

describe("manual Fragment merge", () => {
  it("preserves sources, entities and projection support under the target Claim", () => {
    const db = new MemoryV2Database(":memory:")
    const sourceClaim = ensureMemoryClaim(db, { content: "用户正在做记忆升级", claimType: "plan", confidence: .8, now: 1 })
    const targetClaim = ensureMemoryClaim(db, { content: "用户正在升级记忆系统", claimType: "plan", confidence: .9, now: 1 })
    db.prepare(`INSERT INTO memory_fragments(
      id, claim_id, content, kind, certainty, attribution, confidence, importance, status, revision, created_at, updated_at, last_accessed_at
    ) VALUES ('source', ?, '用户正在做记忆升级', 'plan', 'explicit', 'user', .8, .7, 'active', 1, 1, 1, 1),
             ('target', ?, '用户正在升级记忆系统', 'plan', 'explicit', 'user', .9, .8, 'active', 1, 1, 1, 1)`).run(sourceClaim, targetClaim)
    db.prepare(`INSERT INTO memory_sources(id, source_type, occurred_at, quote, status) VALUES ('source-evidence', 'chat', 1, '证据', 'active')`).run()
    db.prepare("INSERT INTO memory_fragment_sources VALUES ('source', 'source-evidence', 'support')").run()
    db.prepare(`INSERT INTO memory_states(id, claim_id, state_type, content, status, confidence, importance, starts_at, created_at, updated_at)
      VALUES ('state', ?, 'plan', '用户正在做记忆升级', 'active', .8, .7, 1, 1, 1)`).run(sourceClaim)
    linkStateToFragment(db, "state", "source", 1)

    expect(mergeMemoryFragments(db, "source", "target", 10)).toBe(true)
    expect(db.prepare("SELECT status, superseded_by FROM memory_fragments WHERE id = 'source'").get())
      .toMatchObject({ status: "superseded", superseded_by: "target" })
    expect(db.prepare("SELECT claim_id FROM memory_states WHERE id = 'state'").get()?.claim_id).toBe(targetClaim)
    expect(db.prepare("SELECT COUNT(*) AS count FROM memory_fragment_sources WHERE source_id = 'source-evidence' AND fragment_id = 'target'").get()?.count).toBe(1)
    expect(db.prepare("SELECT COUNT(*) AS count FROM memory_state_fragments WHERE state_id = 'state' AND fragment_id = 'target'").get()?.count).toBe(1)
    expect(db.prepare("SELECT status, superseded_by FROM memory_claims WHERE id = ?").get(sourceClaim))
      .toMatchObject({ status: "superseded", superseded_by: targetClaim })
    expect(db.prepare("SELECT COUNT(*) AS count FROM memory_jobs WHERE job_type LIKE 'rag-%'").get()?.count).toBe(2)
    db.close()
  })

  it("rejects merging different Fragment kinds", () => {
    const db = new MemoryV2Database(":memory:")
    db.prepare(`INSERT INTO memory_fragments(id, content, kind, certainty, attribution, confidence, importance, status, created_at, updated_at, last_accessed_at)
      VALUES ('a', 'A', 'fact', 'explicit', 'user', .8, .8, 'active', 1, 1, 1),
             ('b', 'B', 'plan', 'explicit', 'user', .8, .8, 'active', 1, 1, 1)`).run()
    expect(mergeMemoryFragments(db, "a", "b", 10)).toBe(false)
    db.close()
  })
})
