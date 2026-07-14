import { afterEach, describe, expect, it } from "vitest"
import { MemoryV2Database } from "./database"
import { classifyMemoryIntent, recallMemoryV2, tokenizeMemoryQuery } from "./librarian"
import { attachFragmentToClaim, attachStateToClaim, ensureMemoryClaim } from "./claim-graph"
import { vectorContentHash, vectorIndexKey } from "./vector-sync"

const databases: MemoryV2Database[] = []

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

function createDatabase(): MemoryV2Database {
  const database = new MemoryV2Database(":memory:")
  databases.push(database)
  return database
}

function insertFragment(
  db: MemoryV2Database,
  input: {
    id: string
    content: string
    conversationId: string
    now: number
    status?: "pending" | "active" | "cooling" | "frozen"
    certainty?: "explicit" | "inferred" | "uncertain"
    attribution?: "user" | "assistant" | "mixed" | "system"
    confidence?: number
  },
): void {
  const sourceId = `source_${input.id}`
  db.prepare(`
    INSERT INTO memory_sources(
      id, source_type, conversation_id, message_id, occurred_at, quote,
      context_before, context_after, status, metadata_json
    ) VALUES (?, 'chat', ?, ?, ?, ?, NULL, NULL, 'active', '{}')
  `).run(sourceId, input.conversationId, `message_${input.id}`, input.now, input.content)
  db.prepare(`
    INSERT INTO memory_fragments(
      id, content, kind, certainty, attribution, confidence, importance,
      emotional_weight, status, created_at, updated_at, last_accessed_at,
      access_count, pinned, metadata_json
    ) VALUES (?, ?, 'fact', ?, ?, ?, 0.8, 0.5, ?, ?, ?, ?, 0, 0, '{}')
  `).run(
    input.id,
    input.content,
    input.certainty ?? "explicit",
    input.attribution ?? "user",
    input.confidence ?? 0.95,
    input.status ?? "active",
    input.now,
    input.now,
    input.now,
  )
  db.prepare(`
    INSERT INTO memory_fragment_sources(fragment_id, source_id, evidence_role)
    VALUES (?, ?, 'support')
  `).run(input.id, sourceId)
}

describe("Memory v2 Librarian", () => {
  it("classifies intents and tokenizes Chinese queries", () => {
    expect(classifyMemoryIntent("你还记得我们最开始做 Cyrene 的时候吗")).toBe("long_term")
    expect(classifyMemoryIntent("我现在正在做什么项目")).toBe("current_state")
    expect(tokenizeMemoryQuery("Cyrene 最近的 Memory v2 进展")).toEqual(
      expect.arrayContaining([expect.stringMatching(/cyrene|memory|进展/)]),
    )
  })

  it("recalls global memories across sessions while using the current session only as a boost", async () => {
    const db = createDatabase()
    const now = Date.UTC(2026, 6, 14)
    insertFragment(db, {
      id: "fragment_branch_a",
      content: "用户喜欢紫色花朵",
      conversationId: "branch-a",
      now,
    })
    insertFragment(db, {
      id: "fragment_branch_b",
      content: "用户正在开发 Cyrene Memory v2 项目",
      conversationId: "branch-b",
      now,
    })

    const recalled = await recallMemoryV2(db, "Cyrene Memory v2 项目进展", {
      currentConversationId: "branch-a",
      now,
    })

    expect(recalled.items.map((item) => item.id)).toContain("fragment_branch_b")
    const crossSession = recalled.items.find((item) => item.id === "fragment_branch_b")
    expect(crossSession?.scoreParts.topic).toBe(0)
    expect(crossSession?.permission).toBe("can_quote")
    expect(recalled.context).toContain("用户正在开发 Cyrene Memory v2 项目")
  })

  it("excludes pending fragments while allowing low-weight exact recovery of frozen memories", async () => {
    const db = createDatabase()
    const now = Date.UTC(2026, 6, 14)
    insertFragment(db, {
      id: "fragment_active",
      content: "屏幕上正在编辑记忆系统设计文档",
      conversationId: "main",
      now,
    })
    insertFragment(db, {
      id: "fragment_pending",
      content: "屏幕上可能显示银行卡号码",
      conversationId: "main",
      now,
      status: "pending",
    })
    insertFragment(db, {
      id: "fragment_frozen",
      content: "很久以前编辑过记忆系统设计文档",
      conversationId: "old-branch",
      now,
      status: "frozen",
    })

    const recalled = await recallMemoryV2(db, "记忆系统设计文档", { now })
    const ids = recalled.items.map((item) => item.id)
    expect(ids).toContain("fragment_active")
    expect(ids).not.toContain("fragment_pending")
    expect(ids).toContain("fragment_frozen")
    const active = recalled.items.find((item) => item.id === "fragment_active")
    const frozen = recalled.items.find((item) => item.id === "fragment_frozen")
    expect(frozen!.score).toBeLessThan(active!.score)
  })

  it("downgrades inferred memories and records recall diagnostics and access counts", async () => {
    const db = createDatabase()
    const now = Date.UTC(2026, 6, 14)
    insertFragment(db, {
      id: "fragment_inferred",
      content: "用户可能偏爱安静的夜晚",
      conversationId: "branch-b",
      now,
      certainty: "inferred",
      attribution: "assistant",
      confidence: 0.6,
    })

    const recalled = await recallMemoryV2(db, "安静的夜晚", { now })
    expect(recalled.items).toHaveLength(1)
    expect(recalled.items[0].permission).toBe("cautious")
    expect(db.prepare("SELECT access_count FROM memory_fragments WHERE id = ?").get("fragment_inferred")?.access_count).toBe(1)

    const log = db.prepare("SELECT * FROM memory_recall_log ORDER BY created_at DESC LIMIT 1").get()
    expect(log?.intent).toBe("semantic")
    expect(JSON.parse(String(log?.injected_items_json))).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "fragment_inferred", permission: "cautious" })]),
    )
  })

  it("does not touch lifecycle access counters during shadow recall and redacts logged queries", async () => {
    const db = createDatabase()
    const now = Date.UTC(2026, 6, 14)
    insertFragment(db, {
      id: "fragment_shadow",
      content: "用户正在设计 Memory v2",
      conversationId: "main",
      now,
    })

    await recallMemoryV2(db, "Memory v2 apiKey=sk-secretsecretsecret", {
      now,
      recordAccess: false,
      logMode: "shadow",
    })

    expect(db.prepare("SELECT access_count FROM memory_fragments WHERE id = 'fragment_shadow'").get()?.access_count).toBe(0)
    const log = db.prepare("SELECT query, candidate_counts_json FROM memory_recall_log").get()!
    expect(log.query).not.toContain("sk-secretsecretsecret")
    expect(JSON.parse(String(log.candidate_counts_json))).toMatchObject({ mode: "shadow" })
  })

  it("includes archived episodes and sagas only for long-term recall", async () => {
    const db = createDatabase()
    const now = Date.UTC(2026, 6, 14)
    db.prepare(`
      INSERT INTO memory_episodes(
        id, title, content, status, confidence, importance, starts_at, ends_at,
        created_at, updated_at, last_accessed_at, access_count, version, metadata_json
      ) VALUES ('episode-1', '第一次连接 QQ', '我们第一次让 Cyrene 通过 QQ 回复消息。',
        'archived', 0.9, 0.9, ?, ?, ?, ?, ?, 0, 1, '{}')
    `).run(now, now, now, now, now)
    db.prepare(`
      INSERT INTO memory_sagas(
        id, theme, content, status, confidence, starts_at, ends_at,
        created_at, updated_at, version, metadata_json
      ) VALUES ('saga-1', 'Cyrene 成长', 'Cyrene 从桌面聊天逐渐成长为长期陪伴型 Agent。',
        'active', 0.8, ?, ?, ?, ?, 1, '{}')
    `).run(now, now, now, now)

    const ordinary = await recallMemoryV2(db, "第一次连接 QQ", { now })
    expect(ordinary.items.map((item) => item.id)).not.toContain("episode-1")

    const longTerm = await recallMemoryV2(db, "还记得 Cyrene 第一次连接 QQ 的成长吗", { now })
    expect(longTerm.items.map((item) => item.id)).toEqual(expect.arrayContaining(["episode-1", "saga-1"]))
  })

  it("builds evidence-aware proactive context from active states, recent Episodes, and weak Sagas", async () => {
    const db = createDatabase()
    const now = Date.UTC(2026, 6, 14)
    db.prepare(`
      INSERT INTO memory_states(
        id, state_type, content, status, confidence, importance, starts_at,
        expires_at, pinned, created_at, updated_at, metadata_json
      ) VALUES ('state-plan', 'plan', '用户正在完成 Memory v2', 'active', 0.9, 0.9,
        ?, ?, 0, ?, ?, '{}')
    `).run(now, now + 7 * 24 * 60 * 60 * 1000, now, now)
    db.prepare(`
      INSERT INTO memory_episodes(
        id, title, content, status, confidence, importance, created_at, updated_at,
        last_accessed_at, access_count, version, metadata_json
      ) VALUES ('episode-recent', '最近的共同进展', '用户和 Cyrene 最近一起完成了 QQ 聊天优化。',
        'active', 0.85, 0.8, ?, ?, ?, 0, 1, '{}')
    `).run(now, now, now)
    db.prepare(`
      INSERT INTO memory_sagas(
        id, theme, content, status, confidence, created_at, updated_at, version, metadata_json
      ) VALUES ('saga-growth', '长期成长', 'Cyrene 的陪伴能力一直在逐步完善。',
        'active', 0.65, ?, ?, 1, '{}')
    `).run(now, now)

    const recalled = await recallMemoryV2(db, "现在有什么适合自然关心的话题", {
      currentConversationId: "main",
      purpose: "proactive",
      now,
      maxItems: 6,
    })
    expect(recalled.items.map((item) => item.id)).toEqual(expect.arrayContaining([
      "state-plan",
      "episode-recent",
      "saga-growth",
    ]))
    expect(recalled.items.find((item) => item.id === "saga-growth")?.permission).toBe("association_only")
  })

  it("collapses State and Fragment projections of the same claim into one candidate", async () => {
    const db = createDatabase()
    const now = Date.UTC(2026, 6, 14)
    const content = "User is currently implementing the Cyrene claim graph"
    insertFragment(db, { id: "fragment-claim", content, conversationId: "main", now })
    db.prepare(`
      INSERT INTO memory_states(
        id, state_type, content, status, confidence, importance, starts_at,
        expires_at, pinned, created_at, updated_at, metadata_json
      ) VALUES ('state-claim', 'plan', ?, 'active', 0.95, 0.9, ?, ?, 0, ?, ?, '{}')
    `).run(content, now, now + 30 * 24 * 60 * 60 * 1000, now, now)
    const claimId = ensureMemoryClaim(db, { content, claimType: "plan", confidence: 0.95, now })
    attachFragmentToClaim(db, "fragment-claim", claimId, now)
    attachStateToClaim(db, "state-claim", claimId, now)

    const recalled = await recallMemoryV2(db, "What is the user currently implementing in Cyrene?", { now })
    const claimItems = recalled.items.filter((item) => item.claimId === claimId)

    expect(claimItems).toHaveLength(1)
    expect(["state-claim", "fragment-claim"]).toContain(claimItems[0].id)
  })

  it("rejects stale or unversioned Memory v2 vectors before using SQLite content", async () => {
    const db = createDatabase()
    const now = Date.UTC(2026, 6, 14)
    const content = "User prefers a quiet workspace"
    insertFragment(db, { id: "fragment-vector", content, conversationId: "main", now })
    const query = "semantically related but lexically absent vector probe"
    const baseHit = {
      id: "rag-vector",
      text: "old vector text",
      score: 0.99,
      metadata: {
        l2Id: "fragment-vector",
        memoryV2: true,
        memoryLayer: "fragment",
        indexKey: vectorIndexKey("fragment", "fragment-vector"),
        indexVersion: 2,
        targetRevision: 1,
      },
    }

    const stale = await recallMemoryV2(db, query, {
      now,
      vectorHits: [{ ...baseHit, metadata: { ...baseHit.metadata, contentHash: "stale" } }],
    })
    expect(stale.items.map((item) => item.id)).not.toContain("fragment-vector")
    expect(db.prepare("SELECT COUNT(*) AS count FROM memory_jobs WHERE job_type = 'rag-upsert'").get()?.count).toBe(1)
    expect(JSON.parse(String(db.prepare("SELECT candidate_counts_json FROM memory_recall_log ORDER BY created_at DESC LIMIT 1").get()?.candidate_counts_json)))
      .toMatchObject({ vectorRepairsQueued: 1 })

    const valid = await recallMemoryV2(db, query, {
      now,
      vectorHits: [{ ...baseHit, metadata: { ...baseHit.metadata, contentHash: vectorContentHash(content) } }],
    })
    expect(valid.items.map((item) => item.id)).toContain("fragment-vector")
  })

  it("enforces an explicit memory context token budget", async () => {
    const db = createDatabase()
    const now = Date.UTC(2026, 6, 14)
    insertFragment(db, {
      id: "fragment-long",
      content: `MemoryBudget ${"很长的记忆内容".repeat(30)}`,
      conversationId: "main",
      now,
    })
    const recalled = await recallMemoryV2(db, "MemoryBudget", { now, maxContextTokens: 100 })
    expect(recalled.items).toHaveLength(0)
    expect(JSON.parse(String(db.prepare("SELECT candidate_counts_json FROM memory_recall_log").get()?.candidate_counts_json)))
      .toMatchObject({ estimatedTokens: 0 })
  })
})
