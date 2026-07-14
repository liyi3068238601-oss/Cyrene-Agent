import type { MemoryV2Database } from "./database"

export interface MemoryBackgroundMetrics {
  calls: number
  succeeded: number
  failed: number
  inputTokens: number
  outputTokens: number
  totalDurationMs: number
  averageDurationMs: number
  failureRate: number
  lastAt: number
  daily: { date: string; calls: number; inputTokens: number; outputTokens: number }
  byKind: Record<string, { calls: number; failed: number; inputTokens: number; outputTokens: number; totalDurationMs: number }>
}

function emptyMetrics(): MemoryBackgroundMetrics {
  return {
    calls: 0,
    succeeded: 0,
    failed: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalDurationMs: 0,
    averageDurationMs: 0,
    failureRate: 0,
    lastAt: 0,
    daily: { date: "", calls: 0, inputTokens: 0, outputTokens: 0 },
    byKind: {},
  }
}

export function loadMemoryBackgroundMetrics(db: MemoryV2Database): MemoryBackgroundMetrics {
  const raw = db.prepare("SELECT value FROM memory_meta WHERE key = 'backgroundModel.metrics'").get()?.value
  if (!raw) return emptyMetrics()
  try {
    const parsed = JSON.parse(String(raw)) as Partial<MemoryBackgroundMetrics>
    const calls = Number(parsed.calls ?? 0)
    const failed = Number(parsed.failed ?? 0)
    return {
      ...emptyMetrics(),
      ...parsed,
      calls,
      failed,
      averageDurationMs: calls > 0 ? Number(parsed.totalDurationMs ?? 0) / calls : 0,
      failureRate: calls > 0 ? failed / calls : 0,
      byKind: parsed.byKind && typeof parsed.byKind === "object" ? parsed.byKind : {},
      daily: parsed.daily && typeof parsed.daily === "object"
        ? parsed.daily
        : { date: "", calls: 0, inputTokens: 0, outputTokens: 0 },
    }
  } catch {
    return emptyMetrics()
  }
}

export function recordMemoryBackgroundCall(
  db: MemoryV2Database | null,
  input: { kind: string; durationMs: number; inputTokens?: number; outputTokens?: number; failed?: boolean; now?: number },
): void {
  if (!db) return
  try {
    db.transaction(() => {
      const metrics = loadMemoryBackgroundMetrics(db)
      const kind = input.kind.trim().slice(0, 80) || "unknown"
      const durationMs = Math.max(0, Math.round(input.durationMs))
      const inputTokens = Math.max(0, Math.round(input.inputTokens ?? 0))
      const outputTokens = Math.max(0, Math.round(input.outputTokens ?? 0))
      const failed = Boolean(input.failed)
      const date = new Date(input.now ?? Date.now()).toISOString().slice(0, 10)
      if (metrics.daily.date !== date) metrics.daily = { date, calls: 0, inputTokens: 0, outputTokens: 0 }
      const byKind = metrics.byKind[kind] ?? { calls: 0, failed: 0, inputTokens: 0, outputTokens: 0, totalDurationMs: 0 }
      byKind.calls += 1
      byKind.failed += failed ? 1 : 0
      byKind.inputTokens += inputTokens
      byKind.outputTokens += outputTokens
      byKind.totalDurationMs += durationMs
      metrics.calls += 1
      metrics.succeeded += failed ? 0 : 1
      metrics.failed += failed ? 1 : 0
      metrics.inputTokens += inputTokens
      metrics.outputTokens += outputTokens
      metrics.totalDurationMs += durationMs
      metrics.averageDurationMs = metrics.totalDurationMs / metrics.calls
      metrics.failureRate = metrics.failed / metrics.calls
      metrics.lastAt = input.now ?? Date.now()
      metrics.daily.calls += 1
      metrics.daily.inputTokens += inputTokens
      metrics.daily.outputTokens += outputTokens
      metrics.byKind[kind] = byKind
      db.prepare(`
        INSERT INTO memory_meta(key, value, updated_at) VALUES ('backgroundModel.metrics', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `).run(JSON.stringify(metrics), metrics.lastAt)
    })
  } catch {
    // Metrics must never turn a background model result into a task failure.
  }
}

export function isMemoryBackgroundBudgetAvailable(
  db: MemoryV2Database | null,
  now = Date.now(),
  limits: { maxCalls?: number; maxTokens?: number } = {},
): boolean {
  if (!db) return true
  const metrics = loadMemoryBackgroundMetrics(db)
  const date = new Date(now).toISOString().slice(0, 10)
  if (metrics.daily.date !== date) return true
  return metrics.daily.calls < (limits.maxCalls ?? 100) &&
    metrics.daily.inputTokens + metrics.daily.outputTokens < (limits.maxTokens ?? 500_000)
}
