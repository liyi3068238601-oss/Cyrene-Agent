import { describe, expect, it } from "vitest"
import { MemoryV2Database } from "./database"
import { refreshEntityOverviews } from "./entity-linker"

describe("entity overviews", () => {
  it("builds and refreshes an overview only from current linked Fragments", () => {
    const db = new MemoryV2Database(":memory:")
    db.prepare(`INSERT INTO memory_entities(id, canonical_name, entity_type, status, created_at, updated_at)
      VALUES ('entity', 'Cyrene-Agent', 'project', 'active', 1, 1)`).run()
    db.prepare(`INSERT INTO memory_fragments(
      id, content, kind, certainty, attribution, confidence, importance, status, created_at, updated_at, last_accessed_at
    ) VALUES ('f1', '用户正在开发 Cyrene-Agent。', 'fact', 'explicit', 'user', .9, .9, 'active', 1, 1, 1),
             ('f2', '已经失效的旧描述。', 'fact', 'explicit', 'user', .9, 1, 'superseded', 1, 1, 1)`).run()
    db.prepare("INSERT INTO memory_fragment_entities VALUES ('f1', 'entity', 'subject', .9), ('f2', 'entity', 'subject', .9)").run()
    expect(refreshEntityOverviews(db, 10)).toBe(1)
    expect(db.prepare("SELECT overview FROM memory_entities WHERE id = 'entity'").get()?.overview).toBe("用户正在开发 Cyrene-Agent。")
    expect(db.prepare("SELECT action FROM memory_revisions WHERE target_type = 'entity'").get()?.action).toBe("refresh_overview")
    db.prepare("UPDATE memory_fragments SET content = '用户正在升级 Cyrene-Agent。', updated_at = 11 WHERE id = 'f1'").run()
    expect(refreshEntityOverviews(db, 12)).toBe(1)
    expect(db.prepare("SELECT overview FROM memory_entities WHERE id = 'entity'").get()?.overview).toBe("用户正在升级 Cyrene-Agent。")
    db.close()
  })

  it("does not overwrite a non-system overview", () => {
    const db = new MemoryV2Database(":memory:")
    db.prepare(`INSERT INTO memory_entities(id, canonical_name, entity_type, overview, status, created_at, updated_at)
      VALUES ('entity', 'Cyrene-Agent', 'project', '用户维护的概览', 'active', 1, 1)`).run()
    expect(refreshEntityOverviews(db, 10)).toBe(0)
    expect(db.prepare("SELECT overview FROM memory_entities WHERE id = 'entity'").get()?.overview).toBe("用户维护的概览")
    db.close()
  })
})
