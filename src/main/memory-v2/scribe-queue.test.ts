import { describe, expect, it } from "vitest"
import { MemoryV2Database } from "./database"
import {
  appendScribeTurn,
  claimPendingScribeEvents,
  completeScribeEvents,
  countPendingScribeEvents,
  failScribeEvents,
  resetInterruptedScribeEvents,
} from "./scribe-queue"

describe("persistent Scribe queue", () => {
  it("stores global turns with traceable user and assistant sources", () => {
    const db = new MemoryV2Database(":memory:")
    const event = appendScribeTurn(db, "用户消息", "Cyrene 回复", "branch-a", 100)

    expect(countPendingScribeEvents(db)).toBe(1)
    expect(db.prepare("SELECT conversation_id, status FROM memory_event_log WHERE id = ?").get(event.id))
      .toMatchObject({ conversation_id: "branch-a", status: "pending" })
    expect(db.prepare("SELECT id, quote FROM memory_sources WHERE id IN (?, ?)").all(event.userSourceId, event.assistantSourceId))
      .toHaveLength(2)
    db.close()
  })

  it("claims chronologically and marks a completed batch", () => {
    const db = new MemoryV2Database(":memory:")
    appendScribeTurn(db, "one", "reply one", "a", 100)
    appendScribeTurn(db, "two", "reply two", "b", 200)

    const claimed = claimPendingScribeEvents(db, 10)
    expect(claimed.map((event) => event.userText)).toEqual(["one", "two"])
    expect(countPendingScribeEvents(db)).toBe(0)
    expect(completeScribeEvents(db, claimed.map((event) => event.id), 300)).toBe(2)
    expect(db.prepare("SELECT status FROM memory_event_log").all().every((row) => row.status === "processed")).toBe(true)
    db.close()
  })

  it("retries failures twice, then keeps the event failed for inspection", () => {
    const db = new MemoryV2Database(":memory:")
    appendScribeTurn(db, "one", "reply", "a", 100)

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const [event] = claimPendingScribeEvents(db, 1)
      expect(event).toBeTruthy()
      failScribeEvents(db, [event.id], new Error(`failure ${attempt}`))
    }
    expect(countPendingScribeEvents(db)).toBe(0)
    expect(db.prepare("SELECT status, attempt_count FROM memory_event_log").get())
      .toMatchObject({ status: "failed", attempt_count: 3 })
    db.close()
  })

  it("recovers processing events after an interrupted application run", () => {
    const db = new MemoryV2Database(":memory:")
    appendScribeTurn(db, "one", "reply", "a", 100)
    claimPendingScribeEvents(db, 1)
    expect(resetInterruptedScribeEvents(db)).toBe(1)
    expect(countPendingScribeEvents(db)).toBe(1)
    db.close()
  })
})
