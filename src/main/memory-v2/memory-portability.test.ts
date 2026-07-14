import { describe, expect, it } from "vitest"
import { MemoryV2Database } from "./database"
import { createMemoryExport, replaceMemoryFromExport, validateMemoryExport } from "./memory-portability"

describe("Memory v2 portability", () => {
  it("exports structured memory without chat archives, Scribe text, or source context", () => {
    const db = new MemoryV2Database(":memory:")
    db.prepare(`INSERT INTO memory_sources(
      id, source_type, conversation_id, occurred_at, quote, context_before, context_after, status, metadata_json
    ) VALUES ('source', 'chat', 'main', 1, 'API key=sk-secretsecretsecret', 'full before', 'full after', 'active', '{}')`).run()
    db.prepare(`INSERT INTO memory_event_log(
      id, conversation_id, user_text, assistant_text, occurred_at, status,
      attempt_count, user_source_id, assistant_source_id
    ) VALUES ('event', 'main', 'raw user', 'raw assistant', 1, 'processed', 1, 'source', 'source')`).run()

    const exported = createMemoryExport(db, 100)
    expect(validateMemoryExport(exported)).toBe(true)
    expect(exported.data.memory_sources[0]).toMatchObject({ context_before: null, context_after: null })
    expect(String(exported.data.memory_sources[0].quote)).not.toContain("sk-secretsecretsecret")
    expect(exported.data).not.toHaveProperty("memory_event_log")
    expect(exported.data).not.toHaveProperty("conversation_archives")
    db.close()
  })

  it("restores all structured links transactionally and queues vector rebuilding", () => {
    const source = new MemoryV2Database(":memory:")
    source.prepare(`INSERT INTO memory_sources(id, source_type, conversation_id, occurred_at, quote, status, metadata_json)
      VALUES ('source', 'chat', 'main', 1, '用户喜欢紫色花朵', 'active', '{}')`).run()
    source.prepare(`INSERT INTO memory_fragments(
      id, content, kind, certainty, attribution, confidence, importance, status,
      created_at, updated_at, last_accessed_at, revision, metadata_json
    ) VALUES ('fragment', '用户喜欢紫色花朵', 'preference', 'explicit', 'user', .9, .8,
      'active', 1, 1, 1, 1, '{}')`).run()
    source.prepare(`INSERT INTO memory_fragment_sources VALUES ('fragment', 'source', 'support')`).run()
    const exported = createMemoryExport(source, 100)
    source.close()

    const target = new MemoryV2Database(":memory:")
    target.prepare(`INSERT INTO memory_fragments(
      id, content, kind, certainty, attribution, confidence, importance, status,
      created_at, updated_at, last_accessed_at, metadata_json
    ) VALUES ('old', 'will be replaced', 'fact', 'explicit', 'user', 1, 1, 'active', 1, 1, 1, '{}')`).run()
    const result = replaceMemoryFromExport(target, exported, 200)

    expect(result.queuedVectorUpserts).toBe(1)
    expect(target.prepare("SELECT id, claim_id FROM memory_fragments").all()).toEqual([
      expect.objectContaining({ id: "fragment", claim_id: expect.stringMatching(/^claim_/) }),
    ])
    expect(target.prepare("SELECT source_id FROM memory_fragment_sources WHERE fragment_id = 'fragment'").get()?.source_id).toBe("source")
    expect(target.prepare("SELECT job_type FROM memory_jobs").get()?.job_type).toBe("rag-upsert")
    target.close()
  })

  it("rejects a modified package without changing the target database", () => {
    const source = new MemoryV2Database(":memory:")
    const exported = createMemoryExport(source, 100)
    source.close()
    exported.data.core_profile.push({ id: 1, preferred_name: "tampered", updated_at: 1 })

    const target = new MemoryV2Database(":memory:")
    target.prepare("INSERT INTO core_profile(id, preferred_name, updated_at) VALUES (1, 'kept', 1)").run()
    expect(() => replaceMemoryFromExport(target, exported, 200)).toThrow(/Invalid or corrupted/)
    expect(target.prepare("SELECT preferred_name FROM core_profile WHERE id = 1").get()?.preferred_name).toBe("kept")
    target.close()
  })
})
