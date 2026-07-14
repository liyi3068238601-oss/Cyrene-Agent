import { afterEach, describe, expect, it } from "vitest"
import { MemoryV2Database } from "./database"
import { recallMemoryV2 } from "./librarian"
import { RECALL_BENCHMARK_CASES, RECALL_BENCHMARK_MEMORIES } from "./recall-benchmark"

const databases: MemoryV2Database[] = []
afterEach(() => databases.splice(0).forEach((db) => db.close()))

describe("Memory v2 100-question recall benchmark", () => {
  it("meets recall, precision, permission, irrelevant injection, and latency baselines", async () => {
    const db = new MemoryV2Database(":memory:")
    databases.push(db)
    const now = Date.UTC(2026, 6, 14)
    for (const [id, content] of RECALL_BENCHMARK_MEMORIES) {
      db.prepare(`INSERT INTO memory_sources(
        id, source_type, conversation_id, occurred_at, quote, status, metadata_json
      ) VALUES (?, 'chat', 'anonymous', ?, ?, 'active', '{"role":"user"}')`).run(`source_${id}`, now, content)
      db.prepare(`INSERT INTO memory_fragments(
        id, content, kind, certainty, attribution, confidence, importance,
        emotional_weight, status, created_at, updated_at, last_accessed_at,
        access_count, pinned, metadata_json
      ) VALUES (?, ?, 'fact', 'explicit', 'user', .95, .75, .3,
        'active', ?, ?, ?, 0, 0, '{}')`).run(`benchmark_${id}`, content, now, now, now)
      db.prepare("INSERT INTO memory_fragment_sources(fragment_id, source_id, evidence_role) VALUES (?, ?, 'support')")
        .run(`benchmark_${id}`, `source_${id}`)
    }

    let recalled = 0
    let precisionHits = 0
    let returned = 0
    let reciprocalRank = 0
    let irrelevant = 0
    let permissionMatches = 0
    const durations: number[] = []
    const noisyCases: Array<{ id: string; ids: string[] }> = []
    for (const benchmark of RECALL_BENCHMARK_CASES) {
      const result = await recallMemoryV2(db, benchmark.query, { now, maxItems: 5 })
      durations.push(result.durationMs)
      const ids = result.items.map((item) => item.id)
      const rank = ids.indexOf(benchmark.mustRecall[0])
      if (rank >= 0) {
        recalled += 1
        reciprocalRank += 1 / (rank + 1)
        if (result.items[rank]?.permission === benchmark.expectedPermission) permissionMatches += 1
      }
      precisionHits += ids.filter((id) => benchmark.mustRecall.includes(id) || benchmark.mayRecall.includes(id)).length
      irrelevant += ids.filter((id) => benchmark.mustNotRecall.includes(id)).length
      if (ids.some((id) => benchmark.mustNotRecall.includes(id))) noisyCases.push({ id: benchmark.id, ids })
      returned += ids.length
    }

    const recallAt5 = recalled / RECALL_BENCHMARK_CASES.length
    const precisionAt5 = returned > 0 ? precisionHits / returned : 0
    const mrr = reciprocalRank / RECALL_BENCHMARK_CASES.length
    const irrelevantRate = returned > 0 ? irrelevant / returned : 0
    const p95 = [...durations].sort((a, b) => a - b)[Math.floor(durations.length * 0.95)] ?? Infinity

    expect(RECALL_BENCHMARK_CASES).toHaveLength(100)
    expect(recallAt5).toBeGreaterThanOrEqual(0.98)
    expect(precisionAt5, JSON.stringify(noisyCases.slice(0, 12))).toBeGreaterThanOrEqual(0.9)
    expect(mrr).toBeGreaterThanOrEqual(0.95)
    expect(irrelevantRate).toBeLessThanOrEqual(0.02)
    expect(permissionMatches).toBeGreaterThanOrEqual(98)
    expect(p95).toBeLessThan(150)
  })
})
