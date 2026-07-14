import { describe, expect, it } from "vitest"
import { MemoryV2Database } from "./database"
import {
  confirmPendingMemory,
  listPendingMemories,
  proposeScreenObservation,
  rejectPendingMemory,
} from "./pending-memory"
import { syncLegacyEntityGraph } from "./entity-linker"

describe("pending memory confirmation", () => {
  it("stores a non-sensitive screen observation as pending and deduplicates it", () => {
    const db = new MemoryV2Database(":memory:")
    const first = proposeScreenObservation(db, "屏幕上正在编辑 Memory v2 代码。", 100)
    const duplicate = proposeScreenObservation(db, "屏幕上正在编辑 Memory v2 代码。", 200)

    expect(first).not.toBeNull()
    expect(duplicate?.id).toBe(first?.id)
    expect(listPendingMemories(db)).toEqual([
      expect.objectContaining({ id: first?.id, kind: "observation", sourceType: "screen" }),
    ])
    db.close()
  })

  it("does not persist sensitive visual summaries", () => {
    const db = new MemoryV2Database(":memory:")
    expect(proposeScreenObservation(db, "屏幕包含密码和验证码。", 100)).toBeNull()
    expect(db.prepare("SELECT id FROM memory_fragments").all()).toHaveLength(0)
    db.close()
  })

  it("activates only after user confirmation and records a revision", () => {
    const db = new MemoryV2Database(":memory:")
    const pending = proposeScreenObservation(db, "用户正在编写记忆设计。", 100)!
    expect(confirmPendingMemory(db, pending.id, 200)).toBe(true)
    expect(db.prepare("SELECT status, certainty, attribution FROM memory_fragments WHERE id = ?").get(pending.id))
      .toMatchObject({ status: "active", certainty: "explicit", attribution: "user" })
    expect(db.prepare("SELECT action FROM memory_revisions WHERE target_id = ?").get(pending.id)?.action).toBe("confirm")
    db.close()
  })

  it("removes rejected content and source quotes", () => {
    const db = new MemoryV2Database(":memory:")
    const pending = proposeScreenObservation(db, "这条观察不正确。", 100)!
    expect(rejectPendingMemory(db, pending.id, 200)).toBe(true)
    expect(db.prepare("SELECT status, content FROM memory_fragments WHERE id = ?").get(pending.id))
      .toMatchObject({ status: "tombstone", content: "" })
    expect(db.prepare(`
      SELECT s.status, s.quote FROM memory_sources s
      JOIN memory_fragment_sources fs ON fs.source_id = s.id
      WHERE fs.fragment_id = ?
    `).get(pending.id)).toMatchObject({ status: "deleted", quote: "" })
    db.close()
  })

  it("keeps a source that still supports another current fragment", () => {
    const db = new MemoryV2Database(":memory:")
    const pending = proposeScreenObservation(db, "这条观察需要确认。", 100)!
    const sourceId = String(db.prepare(`
      SELECT source_id FROM memory_fragment_sources WHERE fragment_id = ?
    `).get(pending.id)?.source_id)
    db.prepare(`
      INSERT INTO memory_fragments(
        id, content, kind, certainty, attribution, confidence, importance,
        status, created_at, updated_at, last_accessed_at, metadata_json
      ) VALUES ('other', '同一来源支持的另一条记忆', 'observation', 'explicit',
        'user', 0.9, 0.7, 'active', 100, 100, 100, '{}')
    `).run()
    db.prepare(`
      INSERT INTO memory_fragment_sources(fragment_id, source_id, evidence_role)
      VALUES ('other', ?, 'support')
    `).run(sourceId)

    expect(rejectPendingMemory(db, pending.id, 200)).toBe(true)
    expect(db.prepare("SELECT status, quote FROM memory_sources WHERE id = ?").get(sourceId))
      .toMatchObject({ status: "active", quote: "这条观察需要确认。" })
    db.close()
  })

  it("lets the user confirm or reject imported relations that lack evidence", () => {
    const db = new MemoryV2Database(":memory:")
    const graph = {
      entities: [
        { id: "user", name: "用户", type: "person" as const, aliases: [], mentionCount: 1, firstMentionedAt: 100, lastMentionedAt: 100 },
        { id: "project", name: "Cyrene", type: "concept" as const, aliases: [], mentionCount: 1, firstMentionedAt: 100, lastMentionedAt: 100 },
      ],
      relations: [
        { id: "develops", sourceId: "user", targetId: "project", relation: "develops", confidence: 0.7, strength: 1 },
        { id: "maintains", sourceId: "user", targetId: "project", relation: "maintains", confidence: 0.6, strength: 1 },
      ],
    }
    syncLegacyEntityGraph(db, graph, 100)
    expect(listPendingMemories(db).filter((item) => item.kind === "relation")).toHaveLength(2)

    expect(confirmPendingMemory(db, "legacy_develops", 200)).toBe(true)
    expect(db.prepare("SELECT status FROM memory_relations WHERE id = 'legacy_develops'").get()?.status).toBe("active")
    expect(db.prepare("SELECT source_id FROM memory_relation_sources WHERE relation_id = 'legacy_develops'").get()?.source_id).toBeTruthy()
    expect(db.prepare("SELECT action, actor FROM memory_revisions WHERE target_id = 'legacy_develops'").get())
      .toMatchObject({ action: "confirm", actor: "user" })

    expect(rejectPendingMemory(db, "legacy_maintains", 300)).toBe(true)
    expect(db.prepare("SELECT status FROM memory_relations WHERE id = 'legacy_maintains'").get()?.status).toBe("deleted")
    db.close()
  })
})
