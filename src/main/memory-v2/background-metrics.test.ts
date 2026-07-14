import { describe, expect, it } from "vitest"
import { MemoryV2Database } from "./database"
import { isMemoryBackgroundBudgetAvailable, loadMemoryBackgroundMetrics, recordMemoryBackgroundCall } from "./background-metrics"

describe("memory background model metrics", () => {
  it("aggregates success, failure, token usage and latency without storing prompts", () => {
    const db = new MemoryV2Database(":memory:")
    recordMemoryBackgroundCall(db, { kind: "scribe", durationMs: 120, inputTokens: 10, outputTokens: 4, now: 100 })
    recordMemoryBackgroundCall(db, { kind: "scribe", durationMs: 80, failed: true, now: 200 })
    const metrics = loadMemoryBackgroundMetrics(db)
    expect(metrics).toMatchObject({ calls: 2, succeeded: 1, failed: 1, inputTokens: 10, outputTokens: 4, averageDurationMs: 100, failureRate: 0.5, lastAt: 200 })
    expect(metrics.byKind.scribe).toMatchObject({ calls: 2, failed: 1, totalDurationMs: 200 })
    expect(metrics.daily).toMatchObject({ calls: 2, inputTokens: 10, outputTokens: 4 })
    expect(isMemoryBackgroundBudgetAvailable(db, 200, { maxCalls: 2 })).toBe(false)
    expect(String(db.prepare("SELECT value FROM memory_meta WHERE key = 'backgroundModel.metrics'").get()?.value)).not.toContain("prompt")
    db.close()
  })
})
