import { describe, expect, it } from "vitest"
import { MemoryV2Database } from "./database"
import { loadShadowRecallSummary, memoryLogPreview, recordShadowRecallComparison } from "./shadow-recall"

describe("Memory v2 shadow recall telemetry", () => {
  it("records only a redacted preview plus IDs and latency", () => {
    const db = new MemoryV2Database(":memory:")
    const comparison = recordShadowRecallComparison(db, {
      query: "查一下 apiKey=sk-secretsecretsecret 的项目记忆",
      legacyIds: ["same", "legacy-only"],
      legacyDurationMs: 12.4,
      now: 100,
      v2: {
        intent: "semantic",
        durationMs: 8.6,
        context: "",
        items: [
          { id: "same", layer: "fragment", content: "x", permission: "can_quote", score: 1, confidence: 1, createdAt: 1, sources: [], scoreParts: { rrf: 1, evidence: 1, importance: 1, recency: 1, topic: 0, lifecycle: 1, intent: 1 } },
          { id: "v2-only", layer: "state", content: "y", permission: "cautious", score: .5, confidence: .7, createdAt: 1, sources: [], scoreParts: { rrf: 1, evidence: 1, importance: 1, recency: 1, topic: 0, lifecycle: 1, intent: 1 } },
        ],
      },
    })

    expect(comparison).toMatchObject({ overlapCount: 1, legacyCount: 2, v2Count: 2, overlapRatio: 0.5 })
    const row = db.prepare("SELECT * FROM memory_shadow_recall_log").get()!
    expect(row.query_preview).not.toContain("sk-secretsecretsecret")
    expect(row.query_hash).toMatch(/^[a-f0-9]{64}$/)
    expect(row.legacy_duration_ms).toBe(12)
    expect(row.v2_duration_ms).toBe(9)
    expect(loadShadowRecallSummary(db)).toMatchObject({ count: 1, averageOverlapRatio: 0.5, lastAt: 100 })
    db.close()
  })

  it("redacts credentials before truncating a query preview", () => {
    expect(memoryLogPreview("Authorization: bearer-secret password=hello"))
      .toBe("Authorization: [REDACTED] password=[REDACTED]")
  })
})
