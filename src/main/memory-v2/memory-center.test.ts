import { afterEach, describe, expect, it } from "vitest"
import { MemoryV2Database } from "./database"
import { editMemoryCenterItem, expireMemoryState, forgetMemoryFragment, loadMemoryCenterData, loadMemoryItemDetail, restoreMemoryState } from "./memory-center"

const databases: MemoryV2Database[] = []
afterEach(() => databases.splice(0).forEach((db) => db.close()))

function setup(): MemoryV2Database {
  const db = new MemoryV2Database(":memory:")
  databases.push(db)
  db.prepare(`INSERT INTO memory_sources(id, source_type, conversation_id, occurred_at, quote, status, metadata_json)
    VALUES ('source', 'chat', 'branch', 1, 'source quote', 'active', '{}')`).run()
  db.prepare(`INSERT INTO memory_fragments(
    id, content, kind, certainty, attribution, confidence, importance, emotional_weight,
    status, created_at, updated_at, last_accessed_at, access_count, pinned, metadata_json
  ) VALUES ('fragment', 'remember this', 'fact', 'explicit', 'user', .9, .8, .5,
    'active', 1, 1, 1, 0, 0, '{}')`).run()
  db.prepare("INSERT INTO memory_fragment_sources(fragment_id, source_id, evidence_role) VALUES ('fragment', 'source', 'support')").run()
  db.prepare(`INSERT INTO memory_states(
    id, state_type, content, status, confidence, importance, starts_at, expires_at,
    pinned, created_at, updated_at, metadata_json
  ) VALUES ('state', 'goal', 'ship v2', 'active', .9, .8, 1, 1000, 0, 1, 1, '{}')`).run()
  return db
}

describe("Memory center", () => {
  it("loads v2 overview collections and counts", () => {
    const data = loadMemoryCenterData(setup())
    expect(data.fragments).toHaveLength(1)
    expect(data.states).toHaveLength(1)
    expect(data.system.counts.fragments).toBe(1)
  })

  it("allows direct edits only through the Core/State/Fragment APIs with revisions", () => {
    const db = setup()
    expect(editMemoryCenterItem(db, "core", "1", { field: "preferredName", value: "Master" }, 2)).toBe(true)
    expect(editMemoryCenterItem(db, "state", "state", { content: "ship memory v2", pinned: true }, 3)).toBe(true)
    expect(editMemoryCenterItem(db, "fragment", "fragment", { content: "remember this detail", pinned: true }, 4)).toBe(true)
    expect(db.prepare("SELECT preferred_name FROM core_profile WHERE id = 1").get()?.preferred_name).toBe("Master")
    expect(db.prepare("SELECT COUNT(*) AS count FROM memory_revisions").get()?.count).toBe(3)
  })

  it("expires states and forgets fragments while retaining audit hashes", () => {
    const db = setup()
    expect(expireMemoryState(db, "state", 10)).toBe(true)
    expect(forgetMemoryFragment(db, "fragment", 11)).toBe(true)
    expect(db.prepare("SELECT status FROM memory_states WHERE id = 'state'").get()?.status).toBe("expired")
    expect(db.prepare("SELECT status, content FROM memory_fragments WHERE id = 'fragment'").get()).toMatchObject({ status: "tombstone", content: "[forgotten memory]" })
    expect(db.prepare("SELECT quote, status FROM memory_sources WHERE id = 'source'").get()).toMatchObject({ quote: "", status: "deleted" })
    expect(loadMemoryItemDetail(db, "fragment", "fragment").revisions.length).toBeGreaterThan(0)
  })

  it("shows historical states and restores one as an explicit pinned state", () => {
    const db = setup()
    expect(expireMemoryState(db, "state", 10)).toBe(true)
    expect(loadMemoryCenterData(db).archivedStates.map((row) => row.id)).toContain("state")
    expect(restoreMemoryState(db, "state", 20)).toBe(true)
    expect(db.prepare("SELECT status, expires_at, pinned FROM memory_states WHERE id = 'state'").get())
      .toMatchObject({ status: "active", expires_at: null, pinned: 1 })
    expect(db.prepare("SELECT action FROM memory_revisions WHERE target_type = 'state' ORDER BY created_at DESC LIMIT 1").get()?.action).toBe("restore")
  })
})
