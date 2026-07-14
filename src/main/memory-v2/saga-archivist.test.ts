import { afterEach, describe, expect, it, vi } from "vitest"
import { MemoryV2Database } from "./database"
import {
  findSagaCandidateGroups,
  publishSagaDraft,
  runSagaArchivist,
  validateSagaDraft,
} from "./saga-archivist"

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
    ) VALUES ('cyrene', 'Cyrene-Agent', 'project', '[]', '', 'active', 0.9, ?, ?)
  `).run(now, now)
  const contents = [
    "最初完成桌面聊天和角色交互。",
    "随后接入 QQ 并优化自然分段回复。",
    "后来增加 NovelAI 绘图工作台和角色档案。",
    "最后开始重建全局长期记忆系统。",
  ]
  contents.forEach((content, index) => {
    const fragmentId = `fragment-${index + 1}`
    const episodeId = `episode-${index + 1}`
    const sourceId = `source-${index + 1}`
    db.prepare(`
      INSERT INTO memory_sources(id, source_type, conversation_id, occurred_at, quote, status, metadata_json)
      VALUES (?, 'chat', 'main', ?, ?, 'active', '{}')
    `).run(sourceId, now + index, content)
    db.prepare(`
      INSERT INTO memory_fragments(
        id, content, kind, certainty, attribution, confidence, importance,
        status, created_at, updated_at, last_accessed_at, metadata_json
      ) VALUES (?, ?, 'experience', 'explicit', 'user', 0.9, 0.8, 'active', ?, ?, ?, '{}')
    `).run(fragmentId, content, now + index, now + index, now + index)
    db.prepare(`INSERT INTO memory_fragment_sources VALUES (?, ?, 'support')`).run(fragmentId, sourceId)
    db.prepare(`INSERT INTO memory_fragment_entities VALUES (?, 'cyrene', 'subject', 0.9)`).run(fragmentId)
    db.prepare(`
      INSERT INTO memory_episodes(
        id, title, content, status, confidence, importance, starts_at, ends_at,
        created_at, updated_at, last_accessed_at, access_count, version, metadata_json
      ) VALUES (?, ?, ?, 'active', 0.85, 0.8, ?, ?, ?, ?, ?, 0, 1, '{}')
    `).run(episodeId, `阶段 ${index + 1}`, content, now + index, now + index, now + index, now + index, now + index)
    db.prepare(`INSERT INTO memory_episode_fragments VALUES (?, ?, 0)`).run(episodeId, fragmentId)
  })
  return { db, now }
}

describe("Memory v2 Saga Archivist", () => {
  it("requires at least three Episodes linked by a stable entity", () => {
    const { db } = setup()
    const groups = findSagaCandidateGroups(db)
    expect(groups).toHaveLength(1)
    expect(groups[0].label).toBe("Cyrene-Agent")
    expect(groups[0].episodes).toHaveLength(4)
  })

  it("treats Saga as a weak narrative and rejects unsupported claims", () => {
    const { db } = setup()
    const allowed = new Map(findSagaCandidateGroups(db)[0].episodes.map((episode) => [episode.id, episode]))
    expect(validateSagaDraft({
      theme: "Cyrene 的成长",
      content: "Cyrene-Agent 从最初的桌面聊天和角色交互，逐步扩展到 NapCat QQ 消息接收与自然分段回复，后来又加入 NovelAI 绘图工作台、角色档案和全局长期记忆系统。用户在这些阶段持续围绕陪伴体验完善 Cyrene 的交互方式与能力边界。",
      episodeIds: ["episode-1", "episode-2", "episode-3", "episode-4"],
      confidence: 0.7,
    }, allowed)).toBe(true)
    expect(validateSagaDraft({
      theme: "虚构未来",
      content: "Cyrene-Agent 将在 2048 年永远成为唯一的完美助手，这是所有阶段都已经明确保证的最终结果。",
      episodeIds: ["episode-1", "episode-2", "episode-3"],
      confidence: 0.8,
    }, allowed)).toBe(false)
  })

  it("publishes immutable Saga versions and links their Episodes", () => {
    const { db, now } = setup()
    const first = publishSagaDraft(db, {
      theme: "Cyrene 的成长",
      content: "Cyrene-Agent 从最初的桌面聊天和角色交互，逐步扩展到 NapCat QQ 消息接收与自然分段回复，后来又加入 NovelAI 绘图工作台、角色档案和全局长期记忆系统。用户在这些阶段持续围绕陪伴体验完善 Cyrene 的交互方式与能力边界。",
      episodeIds: ["episode-1", "episode-2", "episode-3"],
      confidence: 0.7,
    }, now)
    const second = publishSagaDraft(db, {
      theme: "Cyrene 的成长",
      content: "Cyrene-Agent 从桌面聊天与角色交互开始，经由 NapCat QQ 陪伴和自然分段回复，逐步扩展到 NovelAI 绘图工作台、角色档案和全局长期记忆系统，形成持续完善的桌面陪伴体验与更清晰的能力边界。",
      episodeIds: ["episode-1", "episode-2", "episode-3", "episode-4"],
      confidence: 0.75,
    }, now + 1)
    expect(first.created).toBe(true)
    expect(second.created).toBe(true)
    expect(db.prepare("SELECT status, superseded_by FROM memory_sagas WHERE id = ?").get(first.sagaId)).toMatchObject({
      status: "superseded",
      superseded_by: second.sagaId,
    })
    expect(db.prepare("SELECT version FROM memory_sagas WHERE id = ?").get(second.sagaId)?.version).toBe(2)
    expect(db.prepare("SELECT * FROM memory_saga_episodes WHERE saga_id = ?").all(second.sagaId)).toHaveLength(4)
  })

  it("drafts and validates Sagas through the background model interface", async () => {
    const { db, now } = setup()
    const model = vi.fn(async () => JSON.stringify([{
      theme: "Cyrene 的成长",
      content: "Cyrene-Agent 从最初的桌面聊天和角色交互，逐步扩展到 NapCat QQ 消息接收与自然分段回复，后来又加入 NovelAI 绘图工作台、角色档案和全局长期记忆系统。用户在这些阶段持续围绕陪伴体验完善 Cyrene 的交互方式与能力边界。",
      episodeIds: ["episode-1", "episode-2", "episode-3", "episode-4"],
      confidence: 0.7,
    }]))
    const result = await runSagaArchivist(db, model, now)
    expect(result).toEqual({ candidateGroups: 1, draftsReceived: 1, sagasCreated: 1, draftsRejected: 0 })
    expect(model).toHaveBeenCalledOnce()
  })
})
