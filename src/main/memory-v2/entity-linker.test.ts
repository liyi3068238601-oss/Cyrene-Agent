import { afterEach, describe, expect, it } from "vitest"
import { MemoryV2Database } from "./database"
import { linkKnownEntities, syncLegacyEntityGraph } from "./entity-linker"

const databases: MemoryV2Database[] = []

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

describe("Memory v2 entity linker", () => {
  it("imports legacy entities and relations then links matching fragments", () => {
    const db = new MemoryV2Database(":memory:")
    databases.push(db)
    const now = Date.UTC(2026, 6, 14)
    const imported = syncLegacyEntityGraph(db, {
      entities: [
        { id: "cyrene", name: "昔涟", type: "person", aliases: ["Cyrene"], mentionCount: 8, firstMentionedAt: now - 100, lastMentionedAt: now },
        { id: "project", name: "记忆系统", type: "concept", aliases: ["Memory v2"], mentionCount: 3, firstMentionedAt: now - 50, lastMentionedAt: now },
      ],
      relations: [
        { id: "relation", sourceId: "cyrene", targetId: "project", relation: "develops", confidence: 0.85, strength: 3 },
      ],
    }, now)
    expect(imported).toEqual({ entities: 2, relations: 1 })
    expect(db.prepare("SELECT status FROM memory_relations WHERE id = 'legacy_relation'").get()?.status).toBe("pending")

    db.prepare(`
      INSERT INTO memory_fragments(
        id, content, kind, certainty, attribution, confidence, importance,
        status, created_at, updated_at, last_accessed_at, metadata_json
      ) VALUES ('fragment', 'Cyrene 正在整理 Memory v2 的设计。', 'plan', 'explicit',
        'user', 0.9, 0.8, 'active', ?, ?, ?, '{}')
    `).run(now, now, now)

    expect(linkKnownEntities(db)).toBe(2)
    const links = db.prepare(`
      SELECT e.canonical_name
      FROM memory_fragment_entities fe
      JOIN memory_entities e ON e.id = fe.entity_id
      WHERE fe.fragment_id = 'fragment'
      ORDER BY e.canonical_name
    `).all().map((row) => row.canonical_name)
    expect(links).toEqual(["昔涟", "记忆系统"])
  })

  it("activates an imported relation only when a Fragment and Source support it", () => {
    const db = new MemoryV2Database(":memory:")
    databases.push(db)
    const now = Date.UTC(2026, 6, 14)
    db.prepare(`
      INSERT INTO memory_sources(id, source_type, conversation_id, occurred_at, quote, status, metadata_json)
      VALUES ('source', 'chat', 'main', ?, '用户 develops Cyrene-Agent', 'active', '{"role":"user"}')
    `).run(now)
    db.prepare(`
      INSERT INTO memory_fragments(
        id, content, kind, certainty, attribution, confidence, importance,
        status, created_at, updated_at, last_accessed_at, metadata_json
      ) VALUES ('fragment', '用户 develops Cyrene-Agent', 'relationship', 'explicit',
        'user', 0.9, 0.8, 'active', ?, ?, ?, '{}')
    `).run(now, now, now)
    db.prepare(`INSERT INTO memory_fragment_sources VALUES ('fragment', 'source', 'support')`).run()

    syncLegacyEntityGraph(db, {
      entities: [
        { id: "user", name: "用户", type: "person", aliases: [], mentionCount: 3, firstMentionedAt: now, lastMentionedAt: now },
        { id: "cyrene", name: "Cyrene-Agent", type: "concept", aliases: [], mentionCount: 3, firstMentionedAt: now, lastMentionedAt: now },
      ],
      relations: [
        { id: "develops", sourceId: "user", targetId: "cyrene", relation: "develops", confidence: 0.9, strength: 3 },
      ],
    }, now)

    expect(db.prepare("SELECT status FROM memory_relations WHERE id = 'legacy_develops'").get()?.status).toBe("active")
    expect(db.prepare("SELECT fragment_revision FROM memory_relation_fragments WHERE relation_id = 'legacy_develops'").get()?.fragment_revision).toBe(1)
    expect(db.prepare("SELECT source_id FROM memory_relation_sources WHERE relation_id = 'legacy_develops'").get()?.source_id).toBe("source")
  })
})
