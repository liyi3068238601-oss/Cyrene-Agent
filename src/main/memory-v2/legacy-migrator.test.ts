import { describe, expect, it } from "vitest"
import type { MemoryStore } from "../memory/memory-types"
import { MemoryV2Database } from "./database"
import { migrateLegacyStore } from "./legacy-migrator"

function createLegacyStore(): MemoryStore {
  return {
    schemaVersion: 4,
    version: 1,
    l0: {
      nickname: "P",
      preferredName: "主人",
      occupation: "开发者",
      longTermInterests: "AI 绘画",
      language: "zh-CN",
      permanentNote: "长期陪伴",
      isPinned: true,
      updatedAt: 100,
    },
    l1: {
      recentGoals: "完成 Memory v2",
      recentPreferences: "不开放遗忘天数设置",
      currentProject: "Cyrene-Agent",
      generatedAt: 200,
      roundCount: 20,
    },
    l2: [
      {
        id: "l2-fragment",
        content: "用户希望 QQ 只用于日常聊天。",
        triggerText: "QQ 就只负责聊天吧",
        sourceConversationId: "branch-1",
        createdAt: 300,
        lastAccessedAt: 400,
        accessCount: 2,
        weight: 40,
        isPinned: false,
        status: "active",
        syncStatus: "synced",
        ragId: "rag-1",
        evidenceIds: ["evidence-1"],
        sourceMessageIds: ["message-1"],
      },
      {
        id: "l2-summary",
        content: "用户和 Cyrene 完成了 QQ 接入与绘图工作台改造。",
        triggerText: "阶段总结",
        sourceConversationId: "main",
        sourceConversationIds: ["main", "branch-1"],
        createdAt: 500,
        lastAccessedAt: 600,
        accessCount: 1,
        weight: 55,
        isPinned: false,
        status: "active",
        syncStatus: "synced",
        ragId: "rag-summary",
        isSummary: true,
        subEntryIds: ["l2-fragment"],
        evidenceIds: [],
      },
    ],
    evidence: [{
      id: "evidence-1",
      memoryId: "l2-fragment",
      quoteSnippet: "QQ 就只负责聊天吧",
      contextBeforeSnippet: "那绘画功能先做到这",
      conversationId: "branch-1",
      messageIds: ["message-1"],
      createdAt: 300,
      sourceStatus: "active",
    }],
    reflectionLogs: [],
    conflictLogs: [{
      id: "conflict-1",
      createdAt: 700,
      status: "resolved",
      sourceL2Id: "l2-fragment",
      targetL2Id: "l2-fragment",
      reason: "legacy test",
      confidence: 0.8,
      detector: "manual",
      resolverStatus: "resolved",
      resolverFinishedAt: 750,
      resolutionType: "context_difference",
      resolutionReason: "QQ is now intentionally chat-only",
      resolutionConfidence: 0.9,
    }],
    deletedConversations: { "deleted-branch": 800 },
  }
}

describe("legacy Memory v2 migration", () => {
  it("maps L0/L1/L2, evidence, summaries and deleted conversations", () => {
    const db = new MemoryV2Database(":memory:")
    const store = createLegacyStore()
    const result = migrateLegacyStore(db, store, "test-memory", 1_000)

    expect(result).toMatchObject({
      skipped: false,
      coreProfiles: 1,
      states: 3,
      fragments: 1,
      episodes: 1,
      sources: 1,
      revisions: 2,
      deletedConversations: 1,
    })
    expect(db.prepare("SELECT preferred_name FROM core_profile WHERE id = 1").get()?.preferred_name).toBe("主人")
    expect(db.prepare("SELECT content FROM memory_states WHERE status = 'active'").all()).toHaveLength(3)
    expect(db.prepare("SELECT content, status FROM memory_fragments WHERE id = 'l2-fragment'").get()).toMatchObject({
      content: "用户希望 QQ 只用于日常聊天。",
      status: "active",
    })
    expect(db.prepare("SELECT content FROM memory_episodes WHERE id = 'l2-summary'").get()?.content).toContain("QQ 接入")
    expect(db.prepare("SELECT * FROM memory_fragment_sources").all()).toHaveLength(1)
    expect(db.prepare("SELECT * FROM memory_episode_fragments").all()).toHaveLength(1)
    expect(db.prepare("SELECT * FROM deleted_conversations").all()).toHaveLength(1)
    expect(db.prepare("SELECT action, actor FROM memory_revisions WHERE action = 'legacy_conflict_resolution'").get())
      .toMatchObject({ action: "legacy_conflict_resolution", actor: "user" })
    expect(db.getHealth().foreignKeyViolations).toBe(0)

    const repeated = migrateLegacyStore(db, store, "test-memory", 2_000)
    expect(repeated.skipped).toBe(true)
    expect(db.prepare("SELECT * FROM memory_fragments").all()).toHaveLength(1)
    expect(db.prepare("SELECT * FROM memory_episodes").all()).toHaveLength(1)
    db.close()
  })

  it("updates the same imported rows when the legacy snapshot changes", () => {
    const db = new MemoryV2Database(":memory:")
    const store = createLegacyStore()
    migrateLegacyStore(db, store, "test-memory", 1_000)

    store.l2[0].content = "用户希望 QQ 仅用于 companion chat 陪伴聊天。"
    const updated = migrateLegacyStore(db, store, "test-memory", 2_000)

    expect(updated.skipped).toBe(false)
    expect(db.prepare("SELECT content FROM memory_fragments WHERE id = 'l2-fragment'").get()?.content)
      .toBe("用户希望 QQ 仅用于 companion chat 陪伴聊天。")
    expect(db.prepare("SELECT fragment_id FROM memory_fragments_fts WHERE memory_fragments_fts MATCH ?").all("companion"))
      .toHaveLength(1)
    db.close()
  })
})
