import { afterEach, describe, expect, it } from "vitest"
import type { MemoryCandidate } from "../memory/memory-types"
import { MemoryV2Database } from "./database"
import { appendScribeTurn } from "./scribe-queue"
import { sanitizeMemoryModelText, writeMemoryCandidatesV2 } from "./scribe-writer"

const databases: MemoryV2Database[] = []

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

function setup(userText: string, assistantText = "知道了"): { db: MemoryV2Database; event: ReturnType<typeof appendScribeTurn>; now: number } {
  const db = new MemoryV2Database(":memory:")
  databases.push(db)
  const now = Date.UTC(2026, 6, 14)
  return { db, event: appendScribeTurn(db, userText, assistantText, "branch-a", now), now }
}

function candidate(patch: Partial<MemoryCandidate> = {}): MemoryCandidate {
  return {
    layer: "L2",
    content: "用户希望 QQ 只用于日常聊天",
    confidence: 0.95,
    triggerText: "QQ 只用于日常聊天",
    importance: "high",
    stability: "stable",
    certainty: "explicit",
    attribution: "user_explicit",
    evidenceQuotes: ["QQ 只用于日常聊天"],
    shouldWrite: true,
    ...patch,
  }
}

describe("Memory v2 Scribe writer", () => {
  it("writes explicit Core Profile updates with an immutable source revision", () => {
    const { db, event, now } = setup("以后叫我主人")
    const result = writeMemoryCandidatesV2(db, [candidate({
      layer: "L0",
      field: "preferredName",
      content: "主人",
      triggerText: "以后叫我主人",
      evidenceQuotes: ["以后叫我主人"],
    })], [event], now)

    expect(result.coreUpdates).toBe(1)
    expect(db.prepare("SELECT preferred_name FROM core_profile WHERE id = 1").get()?.preferred_name).toBe("主人")
    expect(db.prepare("SELECT actor, source_id FROM memory_revisions WHERE target_type = 'core_profile'").get())
      .toMatchObject({ actor: "assistant", source_id: event.userSourceId })
  })

  it("never promotes assistant-only text into a user Core fact", () => {
    const { db, event, now } = setup("你好", "我觉得你可以叫主人")
    const result = writeMemoryCandidatesV2(db, [candidate({
      layer: "L0",
      field: "preferredName",
      content: "主人",
      triggerText: "我觉得你可以叫主人",
      evidenceQuotes: ["我觉得你可以叫主人"],
      attribution: "assistant_inferred",
      certainty: "inferred",
    })], [event], now)

    expect(result.coreUpdates).toBe(0)
    expect(db.prepare("SELECT preferred_name FROM core_profile WHERE id = 1").get()?.preferred_name ?? "").toBe("")
  })

  it("activates registered Core facts and leaves unknown keys pending", () => {
    const known = setup("My primary device is a desktop PC")
    writeMemoryCandidatesV2(known.db, [candidate({
      layer: "L0",
      field: "primaryDevice",
      content: "desktop PC",
      triggerText: "My primary device is a desktop PC",
      evidenceQuotes: ["My primary device is a desktop PC"],
    })], [known.event], known.now)
    const unknownEvent = appendScribeTurn(known.db, "My custom stable fact is X", "Okay", "branch-b", known.now + 1)
    writeMemoryCandidatesV2(known.db, [candidate({
      layer: "L0",
      field: "inventedField",
      content: "X",
      triggerText: "My custom stable fact is X",
      evidenceQuotes: ["My custom stable fact is X"],
    })], [unknownEvent], known.now + 1)

    expect(known.db.prepare("SELECT status FROM core_facts WHERE key = 'primary_device'").get()?.status).toBe("active")
    expect(known.db.prepare("SELECT status FROM core_facts WHERE key = 'inventedField'").get()?.status).toBe("pending")
  })

  it("writes Current State with bounded expiry and linked evidence", () => {
    const { db, event, now } = setup("我这周正在完成 Memory v2")
    const result = writeMemoryCandidatesV2(db, [candidate({
      layer: "L1",
      field: "goal",
      content: "用户这周正在完成 Memory v2",
      triggerText: "这周正在完成 Memory v2",
      evidenceQuotes: ["这周正在完成 Memory v2"],
    })], [event], now)

    expect(result.states).toBe(1)
    const state = db.prepare("SELECT id, expires_at FROM memory_states").get()
    expect(Number(state?.expires_at) - now).toBe(7 * 24 * 60 * 60 * 1000)
    expect(db.prepare("SELECT source_id FROM memory_state_sources WHERE state_id = ?").get(state?.id)?.source_id).toBe(event.userSourceId)
  })

  it("merges exact Fragment evidence instead of creating duplicates", () => {
    const first = setup("QQ 只用于日常聊天")
    const firstResult = writeMemoryCandidatesV2(first.db, [candidate()], [first.event], first.now)
    const secondEvent = appendScribeTurn(first.db, "我再确认一次，QQ 只用于日常聊天", "好", "branch-b", first.now + 1)
    const secondResult = writeMemoryCandidatesV2(first.db, [candidate()], [secondEvent], first.now + 1)

    expect(firstResult.fragments).toBe(1)
    expect(secondResult.mergedEvidence).toBe(1)
    expect(first.db.prepare("SELECT * FROM memory_fragments").all()).toHaveLength(1)
    expect(first.db.prepare("SELECT * FROM memory_fragment_sources").all()).toHaveLength(2)
    expect(first.db.prepare("SELECT job_type FROM memory_jobs").get()?.job_type).toBe("rag-upsert")
  })

  it("redacts credentials before model calls and rejects sensitive candidates", () => {
    expect(sanitizeMemoryModelText("Authorization: Bearer secret Cookie: sid=abc api_key=sk-abcdefghijklmnop"))
      .not.toContain("abcdefghijklmnop")
    const { db, event, now } = setup("我的 API Key 是 sk-abcdefghijklmnop")
    const result = writeMemoryCandidatesV2(db, [candidate({
      content: "用户的 API Key 是 sk-abcdefghijklmnop",
      triggerText: "API Key",
      evidenceQuotes: ["API Key"],
    })], [event], now)
    expect(result.rejected[0]?.reason).toBe("sensitive_or_empty")
    expect(db.prepare("SELECT * FROM memory_fragments").all()).toHaveLength(0)
  })

  it("supersedes an opposite preference only when the user correction is explicit", () => {
    const first = setup("I like coffee")
    writeMemoryCandidatesV2(first.db, [candidate({ content: "I like coffee", triggerText: "I like coffee", evidenceQuotes: ["I like coffee"] })], [first.event], first.now)
    const correction = appendScribeTurn(first.db, "I dislike coffee", "Understood", "branch-b", first.now + 1)
    writeMemoryCandidatesV2(first.db, [candidate({ content: "I dislike coffee", triggerText: "I dislike coffee", evidenceQuotes: ["I dislike coffee"] })], [correction], first.now + 1)

    expect(first.db.prepare("SELECT status FROM memory_fragments WHERE content = 'I like coffee'").get()?.status).toBe("superseded")
    expect(first.db.prepare("SELECT status FROM memory_fragments WHERE content = 'I dislike coffee'").get()?.status).toBe("active")
    expect(first.db.prepare("SELECT action FROM memory_revisions WHERE action = 'supersede'").get()?.action).toBe("supersede")
  })

  it("keeps inferred contradictions pending for user confirmation", () => {
    const first = setup("I like coffee")
    writeMemoryCandidatesV2(first.db, [candidate({ content: "I like coffee", triggerText: "I like coffee", evidenceQuotes: ["I like coffee"] })], [first.event], first.now)
    const inferred = appendScribeTurn(first.db, "Maybe", "You dislike coffee", "branch-b", first.now + 1)
    writeMemoryCandidatesV2(first.db, [candidate({
      content: "I dislike coffee",
      triggerText: "You dislike coffee",
      evidenceQuotes: ["You dislike coffee"],
      attribution: "assistant_inferred",
      certainty: "inferred",
    })], [inferred], first.now + 1)

    expect(first.db.prepare("SELECT status FROM memory_fragments WHERE content = 'I like coffee'").get()?.status).toBe("active")
    expect(first.db.prepare("SELECT status FROM memory_fragments WHERE content = 'I dislike coffee'").get()?.status).toBe("pending")
  })
})
