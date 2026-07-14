import { createHash, randomUUID } from "crypto"
import type { MemoryV2Database } from "./database"
import type { MemoryRecallResult } from "./librarian"

export interface ShadowRecallComparison {
  id: string
  overlapCount: number
  legacyCount: number
  v2Count: number
  overlapRatio: number
}

export function memoryLogPreview(text: string, limit = 120): string {
  return text
    .replace(/(authorization\s*:\s*)([^\s,;]+)/gi, "$1[REDACTED]")
    .replace(/(cookie\s*:\s*)([^\n]+)/gi, "$1[REDACTED]")
    .replace(/\bsk-[a-z0-9_-]{12,}\b/gi, "[REDACTED_API_KEY]")
    .replace(/((?:api[ _-]?key|access[ _-]?token|refresh[ _-]?token|password|密码|验证码)\s*[=:：]\s*)([^\s,;，。]+)/gi, "$1[REDACTED]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit)
}

export function recordShadowRecallComparison(
  db: MemoryV2Database,
  input: {
    query: string
    legacyIds: string[]
    v2: MemoryRecallResult
    legacyDurationMs: number
    now?: number
  },
): ShadowRecallComparison {
  const now = input.now ?? Date.now()
  const legacyIds = [...new Set(input.legacyIds.filter(Boolean))]
  const v2Items = input.v2.items.map((item) => ({
    id: item.id,
    layer: item.layer,
    permission: item.permission,
    score: item.score,
  }))
  const legacySet = new Set(legacyIds)
  const overlapCount = v2Items.filter((item) => legacySet.has(item.id)).length
  const denominator = Math.max(legacyIds.length, v2Items.length, 1)
  const id = `shadow_recall_${randomUUID()}`

  db.transaction(() => {
    db.prepare(`
      INSERT INTO memory_shadow_recall_log(
        id, query_hash, query_preview, intent, legacy_items_json, v2_items_json,
        overlap_count, legacy_duration_ms, v2_duration_ms, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      createHash("sha256").update(input.query).digest("hex"),
      memoryLogPreview(input.query),
      input.v2.intent,
      JSON.stringify(legacyIds),
      JSON.stringify(v2Items),
      overlapCount,
      Math.max(0, Math.round(input.legacyDurationMs)),
      Math.max(0, Math.round(input.v2.durationMs)),
      now,
    )
    db.prepare(`
      DELETE FROM memory_shadow_recall_log
      WHERE id IN (
        SELECT id FROM memory_shadow_recall_log
        ORDER BY created_at DESC, id DESC
        LIMIT -1 OFFSET 2000
      )
    `).run()
  })

  return {
    id,
    overlapCount,
    legacyCount: legacyIds.length,
    v2Count: v2Items.length,
    overlapRatio: overlapCount / denominator,
  }
}

export function loadShadowRecallSummary(db: MemoryV2Database): {
  count: number
  averageOverlapRatio: number
  averageLegacyDurationMs: number
  averageV2DurationMs: number
  lastAt: number
} {
  const rows = db.prepare(`
    SELECT legacy_items_json, v2_items_json, overlap_count,
      legacy_duration_ms, v2_duration_ms, created_at
    FROM memory_shadow_recall_log
    ORDER BY created_at DESC
    LIMIT 500
  `).all()
  if (rows.length === 0) {
    return { count: 0, averageOverlapRatio: 0, averageLegacyDurationMs: 0, averageV2DurationMs: 0, lastAt: 0 }
  }
  const ratios = rows.map((row) => {
    let legacyCount = 0
    let v2Count = 0
    try { legacyCount = (JSON.parse(String(row.legacy_items_json)) as unknown[]).length } catch { /* invalid historical row */ }
    try { v2Count = (JSON.parse(String(row.v2_items_json)) as unknown[]).length } catch { /* invalid historical row */ }
    return Number(row.overlap_count) / Math.max(legacyCount, v2Count, 1)
  })
  return {
    count: rows.length,
    averageOverlapRatio: ratios.reduce((sum, value) => sum + value, 0) / rows.length,
    averageLegacyDurationMs: rows.reduce((sum, row) => sum + Number(row.legacy_duration_ms), 0) / rows.length,
    averageV2DurationMs: rows.reduce((sum, row) => sum + Number(row.v2_duration_ms), 0) / rows.length,
    lastAt: Number(rows[0]?.created_at ?? 0),
  }
}
