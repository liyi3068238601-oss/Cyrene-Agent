import { afterEach, describe, expect, it, vi } from "vitest"
import { MemoryV2Database } from "./database"
import {
  findEpisodeCandidateGroups,
  publishEpisodeDraft,
  runDeepArchivist,
  validateEpisodeDraft,
} from "./deep-archivist"
import { processArchivistRagJobs } from "./archivist"

const databases: MemoryV2Database[] = []

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

function setup(): { db: MemoryV2Database; now: number } {
  const db = new MemoryV2Database(":memory:")
  databases.push(db)
  const now = Date.UTC(2026, 6, 14)
  db.prepare(`
    INSERT INTO memory_entities(
      id, canonical_name, entity_type, aliases_json, overview, status,
      confidence, created_at, updated_at
    ) VALUES ('cyrene-project', 'Cyrene-Agent', 'project', '["Cyrene"]', '', 'active', 0.9, ?, ?)
  `).run(now, now)
  const fragments = [
    ["fragment-1", "用户与 Cyrene 完成了 NapCat 的 QQ 消息接收。"],
    ["fragment-2", "用户让 Cyrene 能够在 QQ 中自然地分段回复。"],
    ["fragment-3", "用户决定 QQ 只用于日常聊天，不再下达任务。"],
  ] as const
  for (const [index, [id, content]] of fragments.entries()) {
    const sourceId = `source-${index + 1}`
    db.prepare(`
      INSERT INTO memory_sources(
        id, source_type, conversation_id, message_id, occurred_at, quote, status, metadata_json
      ) VALUES (?, 'chat', ?, ?, ?, ?, 'active', '{}')
    `).run(sourceId, `branch-${index + 1}`, `message-${index + 1}`, now + index, content)
    db.prepare(`
      INSERT INTO memory_fragments(
        id, content, kind, certainty, attribution, confidence, importance,
        status, created_at, updated_at, last_accessed_at, metadata_json
      ) VALUES (?, ?, 'experience', 'explicit', 'user', 0.9, 0.8, 'active', ?, ?, ?, '{}')
    `).run(id, content, now + index, now + index, now + index)
    db.prepare(`INSERT INTO memory_fragment_sources VALUES (?, ?, 'support')`).run(id, sourceId)
    db.prepare(`INSERT INTO memory_fragment_entities VALUES (?, 'cyrene-project', 'subject', 0.9)`).run(id)
  }
  return { db, now }
}

describe("Memory v2 deep Archivist", () => {
  it("groups unarchived evidence-backed fragments around known entities", () => {
    const { db } = setup()
    const groups = findEpisodeCandidateGroups(db)
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ key: "entity:cyrene-project", label: "Cyrene-Agent" })
    expect(groups[0].fragments.map((fragment) => fragment.id)).toEqual(["fragment-1", "fragment-2", "fragment-3"])
  })

  it("rejects unsupported facts and unknown fragment references", () => {
    const { db } = setup()
    const allowed = new Map(findEpisodeCandidateGroups(db)[0].fragments.map((fragment) => [fragment.id, fragment]))
    expect(validateEpisodeDraft({
      title: "不存在的事实",
      content: "用户与 Cyrene 在 2048 年一定会永远完成一项来源中没有出现的目标和结果。",
      fragmentIds: ["fragment-1", "fragment-2", "fragment-3"],
      confidence: 0.9,
      importance: 0.8,
    }, allowed)).toMatchObject({ valid: false })
    expect(validateEpisodeDraft({
      title: "未知引用",
      content: "用户和 Cyrene 围绕 QQ 接入逐步完成了消息接收、自然分段回复，并最终明确只把 QQ 用于日常聊天。",
      fragmentIds: ["fragment-1", "fragment-2", "missing"],
      confidence: 0.8,
      importance: 0.8,
    }, allowed)).toEqual({ valid: false, reason: "unknown_fragment" })
  })

  it("publishes a validated Episode transactionally and idempotently", () => {
    const { db, now } = setup()
    const draft = {
      title: "Cyrene 接入 QQ 的阶段",
      content: "用户和 Cyrene 围绕 QQ 接入逐步完成了 NapCat 消息接收与自然分段回复，之后又明确 QQ 只用于日常聊天，不再承担任务下达。",
      fragmentIds: ["fragment-1", "fragment-2", "fragment-3"],
      confidence: 0.88,
      importance: 0.82,
    }
    const first = publishEpisodeDraft(db, draft, now)
    const second = publishEpisodeDraft(db, draft, now + 1)
    expect(first.created).toBe(true)
    expect(second).toEqual({ created: false, episodeId: first.episodeId })
    expect(db.prepare("SELECT * FROM memory_episode_fragments WHERE episode_id = ?").all(first.episodeId)).toHaveLength(3)
    expect(db.prepare("SELECT * FROM memory_episode_sources WHERE episode_id = ?").all(first.episodeId)).toHaveLength(3)
    expect(db.prepare("SELECT job_type FROM memory_jobs").get()?.job_type).toBe("rag-upsert-episode")
  })

  it("uses the model only to draft, validates output, and indexes published Episodes", async () => {
    const { db, now } = setup()
    const model = vi.fn(async () => JSON.stringify([{
      title: "Cyrene 接入 QQ 的阶段",
      content: "用户和 Cyrene 围绕 QQ 接入逐步完成了 NapCat 消息接收与自然分段回复，之后又明确 QQ 只用于日常聊天，不再承担任务下达。",
      fragmentIds: ["fragment-1", "fragment-2", "fragment-3"],
      confidence: 0.88,
      importance: 0.82,
    }]))
    const result = await runDeepArchivist(db, model, now)
    expect(result).toEqual({ candidateGroups: 1, draftsReceived: 1, episodesCreated: 1, draftsRejected: 0 })
    expect(model).toHaveBeenCalledOnce()

    const addEntry = vi.fn(async () => "rag-episode")
    expect(await processArchivistRagJobs(db, { deleteEntries: () => 0, addEntry }, now)).toEqual({ completed: 1, failed: 0 })
    const episode = db.prepare("SELECT id, metadata_json FROM memory_episodes").get()
    expect(JSON.parse(String(episode?.metadata_json))).toMatchObject({ ragId: "rag-episode" })
    expect(addEntry).toHaveBeenCalledWith(
      expect.stringContaining("Cyrene 接入 QQ 的阶段"),
      "user_memory",
      expect.objectContaining({ l2Id: episode?.id, memoryLayer: "episode" }),
    )
  })
})
