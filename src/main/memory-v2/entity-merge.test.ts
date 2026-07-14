import { afterEach, describe, expect, it } from "vitest"
import { MemoryV2Database } from "./database"
import { mergeExactDuplicateEntities, mergeMemoryEntities } from "./entity-merge"

const databases: MemoryV2Database[] = []
afterEach(() => databases.splice(0).forEach((db) => db.close()))

function setup(): MemoryV2Database {
  const db = new MemoryV2Database(":memory:")
  databases.push(db)
  db.prepare(`INSERT INTO memory_entities(id, canonical_name, entity_type, aliases_json, overview, status, confidence, created_at, updated_at)
    VALUES ('a', 'Cyrene', 'person', '["昔涟"]', '', 'active', .8, 1, 1),
           ('b', 'CYRENE', 'person', '["小昔"]', '陪伴者', 'active', .9, 2, 2),
           ('project', 'Memory v2', 'project', '[]', '', 'active', .9, 1, 1)`).run()
  db.prepare(`INSERT INTO memory_fragments(
    id, content, kind, certainty, attribution, confidence, importance, status,
    created_at, updated_at, last_accessed_at, metadata_json
  ) VALUES ('fragment', '昔涟开发 Memory v2', 'relationship', 'explicit', 'user', .9, .8, 'active', 1, 1, 1, '{}')`).run()
  db.prepare(`INSERT INTO memory_fragment_entities VALUES ('fragment', 'b', 'subject', .9)`).run()
  db.prepare(`INSERT INTO memory_relations(id, source_entity_id, relation_type, target_entity_id, confidence, status, created_at, updated_at, metadata_json)
    VALUES ('r1', 'a', 'develops', 'project', .9, 'active', 1, 1, '{}'),
           ('r2', 'b', 'develops', 'project', .8, 'active', 2, 2, '{}')`).run()
  return db
}

describe("Memory v2 entity merge", () => {
  it("moves aliases, Fragment links and relation evidence to the canonical entity", () => {
    const db = setup()
    const result = mergeMemoryEntities(db, "b", "a", 10)
    expect(result).toMatchObject({ merged: true, relationsCollapsed: 1 })
    expect(db.prepare("SELECT status, merged_into FROM memory_entities WHERE id = 'b'").get())
      .toMatchObject({ status: "merged", merged_into: "a" })
    expect(JSON.parse(String(db.prepare("SELECT aliases_json FROM memory_entities WHERE id = 'a'").get()?.aliases_json)))
      .toEqual(expect.arrayContaining(["昔涟", "小昔"]))
    expect(JSON.parse(String(db.prepare("SELECT aliases_json FROM memory_entities WHERE id = 'a'").get()?.aliases_json)))
      .not.toContain("CYRENE")
    expect(db.prepare("SELECT entity_id FROM memory_fragment_entities WHERE fragment_id = 'fragment'").get()?.entity_id).toBe("a")
    expect(db.prepare("SELECT COUNT(*) AS count FROM memory_relations WHERE status = 'active'").get()?.count).toBe(1)
    expect(db.prepare("SELECT action FROM memory_revisions WHERE target_type = 'entity'").get()?.action).toBe("merge")
  })

  it("merges exact normalized duplicates automatically", () => {
    const db = setup()
    expect(mergeExactDuplicateEntities(db, 10)).toBe(1)
    expect(db.prepare("SELECT COUNT(*) AS count FROM memory_entities WHERE status = 'active'").get()?.count).toBe(2)
  })

  it("rejects incompatible entity types and merge cycles", () => {
    const db = setup()
    expect(mergeMemoryEntities(db, "project", "a", 10).merged).toBe(false)
    expect(mergeMemoryEntities(db, "b", "a", 10).merged).toBe(true)
    expect(mergeMemoryEntities(db, "a", "b", 11).merged).toBe(false)
  })
})
