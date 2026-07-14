import {
  deleteMemoryEntries,
  deleteMemoryIndexEntries,
  isRAGInitialized,
  listMemoryIndexEntries,
  upsertMemoryIndex,
} from "../rag"
import { entityGraph } from "../memory/entity-graph"
import { memoryStore } from "../memory/memory-store"
import { callMemoryBackgroundModel } from "../memory/memory-compressor"
import { listSessions } from "../chats/chats-store"
import { enqueueLLMTask, getLLMQueueStatus } from "../llm-queue"
import { hasActiveAgUiRuns } from "../agui-bridge"
import { getMemoryEngineMode, getMemoryV2Database } from "./bridge"
import { processArchivistRagJobs, runLightArchivist, type ArchivistLightResult } from "./archivist"
import { findEpisodeCandidateGroups, runDeepArchivist, type DeepArchivistResult } from "./deep-archivist"
import { findSagaCandidateGroups, runSagaArchivist, type SagaArchivistResult } from "./saga-archivist"
import { linkKnownEntities, refreshEntityOverviews, syncLegacyEntityGraph } from "./entity-linker"
import { mergeExactDuplicateEntities } from "./entity-merge"
import { processLegacySnapshotRepair, type LegacySnapshotRepairResult } from "./legacy-repair"
import { isMemoryAutomationPaused } from "./memory-runtime"
import { reconcileVectorIndex, type VectorReconcileResult } from "./vector-sync"

const LIGHT_INTERVAL_MS = 5 * 60 * 1000
const DEEP_IDLE_MS = 30 * 60 * 1000
const DEEP_MIN_INTERVAL_MS = 12 * 60 * 60 * 1000
const DEEP_FAILURE_RETRY_MS = 60 * 60 * 1000
const DEEP_DAILY_LIMIT = 2
const VECTOR_RECONCILE_INTERVAL_MS = 6 * 60 * 60 * 1000

export interface ArchivistCycleResult {
  lifecycle: ArchivistLightResult
  importedEntities: number
  importedRelations: number
  linkedFragments: number
  mergedEntities: number
  refreshedEntityOverviews: number
  legacyRepair: LegacySnapshotRepairResult | null
  ragJobsCompleted: number
  ragJobsFailed: number
  vectorReconcile: VectorReconcileResult | null
  durationMs: number
  deep: { kind: "episode"; result: DeepArchivistResult } | { kind: "saga"; result: SagaArchivistResult } | null
}

export class MemoryV2ArchivistScheduler {
  private timer: ReturnType<typeof setInterval> | null = null
  private running: Promise<ArchivistCycleResult | null> | null = null

  start(): void {
    if (this.timer) return
    void this.runNow().catch((error) => {
      console.warn("[Memory v2] initial Archivist cycle failed:", error)
    })
    this.timer = setInterval(() => {
      void this.runNow().catch((error) => {
        console.warn("[Memory v2] Archivist cycle failed:", error)
      })
    }, LIGHT_INTERVAL_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  runNow(now = Date.now()): Promise<ArchivistCycleResult | null> {
    if (this.running) return this.running
    this.running = this.execute(now).finally(() => {
      this.running = null
    })
    return this.running
  }

  private async execute(now: number): Promise<ArchivistCycleResult | null> {
    if (isMemoryAutomationPaused()) return null
    const engineMode = getMemoryEngineMode()
    if (engineMode === "legacy") return null
    const db = getMemoryV2Database()
    if (!db) return null
    const startedAt = Date.now()
    const legacyRepair = engineMode === "v2-shadow"
      ? processLegacySnapshotRepair(db, await memoryStore.load(), now)
      : null
    const graph = entityGraph.load()
    const imported = syncLegacyEntityGraph(db, graph, now)
    const linkedFragments = linkKnownEntities(db)
    const mergedEntities = mergeExactDuplicateEntities(db, now)
    const refreshedEntityOverviews = refreshEntityOverviews(db, now)
    const lifecycle = runLightArchivist(db, now)
    const lastVectorReconcileAt = Number(this.getMeta("archivist.lastVectorReconcileAt") ?? 0)
    const vectorReconcile = lastVectorReconcileAt === 0 || now - lastVectorReconcileAt >= VECTOR_RECONCILE_INTERVAL_MS
      ? reconcileVectorIndex(db, { listEntries: listMemoryIndexEntries, deleteEntries: deleteMemoryEntries }, now)
      : null
    if (vectorReconcile) {
      this.setMeta("archivist.lastVectorReconcileAt", String(now), now)
      this.setMeta("archivist.lastVectorReconcile", JSON.stringify(vectorReconcile), now)
    }
    const rag = await processArchivistRagJobs(db, {
      isReady: isRAGInitialized,
      deleteEntries: deleteMemoryEntries,
      deleteIndexEntries: deleteMemoryIndexEntries,
      upsertEntry: upsertMemoryIndex,
    }, now)
    const deep = await this.maybeRunDeep(now)
    this.setMeta("archivist.lastLightAt", String(now), now)
    const result: ArchivistCycleResult = {
      lifecycle,
      importedEntities: imported.entities,
      importedRelations: imported.relations,
      linkedFragments,
      mergedEntities,
      refreshedEntityOverviews,
      legacyRepair,
      ragJobsCompleted: rag.completed,
      ragJobsFailed: rag.failed,
      vectorReconcile,
      durationMs: Math.max(0, Date.now() - startedAt),
      deep,
    }
    const changed = Object.values(lifecycle).some((value) => value > 0) ||
      linkedFragments > 0 || mergedEntities > 0 || refreshedEntityOverviews > 0 || Boolean(legacyRepair?.processed) || rag.completed > 0 || rag.failed > 0 ||
      Boolean(vectorReconcile && (
        vectorReconcile.queuedUpserts > 0 || vectorReconcile.queuedDeletes > 0 ||
        vectorReconcile.orphanEntries > 0 || vectorReconcile.staleEntries > 0 ||
        vectorReconcile.duplicateEntries > 0
      )) || Boolean(deep)
    if (changed) console.log("[Memory v2] Archivist cycle:", result)
    return result
  }

  private getMeta(key: string): string | null {
    const db = getMemoryV2Database()
    return db ? String(db.prepare("SELECT value FROM memory_meta WHERE key = ?").get(key)?.value ?? "") || null : null
  }

  private setMeta(key: string, value: string, now: number): void {
    const db = getMemoryV2Database()
    db?.prepare(`
      INSERT INTO memory_meta(key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, value, now)
  }

  private async maybeRunDeep(now: number): Promise<ArchivistCycleResult["deep"]> {
    const db = getMemoryV2Database()
    if (!db || hasActiveAgUiRuns() || !getLLMQueueStatus().idle) return null
    const latestActivity = Math.max(0, ...listSessions().map((session) => session.updatedAt))
    if (latestActivity > 0 && now - latestActivity < DEEP_IDLE_MS) return null
    const lastDeepAt = Number(this.getMeta("archivist.lastDeepAt") ?? 0)
    if (lastDeepAt > 0 && now - lastDeepAt < DEEP_MIN_INTERVAL_MS) return null
    const lastAttemptAt = Number(this.getMeta("archivist.lastDeepAttemptAt") ?? 0)
    if (lastAttemptAt > 0 && now - lastAttemptAt < DEEP_FAILURE_RETRY_MS) return null
    const episodeGroups = findEpisodeCandidateGroups(db)
    const sagaGroups = episodeGroups.length === 0 ? findSagaCandidateGroups(db) : []
    if (episodeGroups.length === 0 && sagaGroups.length === 0) return null

    const date = new Date(now).toISOString().slice(0, 10)
    const budgetDate = this.getMeta("archivist.deepBudgetDate")
    const budgetUsed = budgetDate === date ? Number(this.getMeta("archivist.deepBudgetUsed") ?? 0) : 0
    if (budgetUsed >= DEEP_DAILY_LIMIT) return null

    this.setMeta("archivist.lastDeepAttemptAt", String(now), now)
    this.setMeta("archivist.deepBudgetDate", date, now)
    this.setMeta("archivist.deepBudgetUsed", String(budgetUsed + 1), now)
    try {
      const result: ArchivistCycleResult["deep"] = episodeGroups.length > 0
        ? {
            kind: "episode",
            result: await enqueueLLMTask("MemoryV2DeepArchivistEpisode", () => (
              runDeepArchivist(db, callMemoryBackgroundModel, now)
            )),
          }
        : {
            kind: "saga",
            result: await enqueueLLMTask("MemoryV2DeepArchivistSaga", () => (
              runSagaArchivist(db, callMemoryBackgroundModel, now)
            )),
          }
      this.setMeta("archivist.lastDeepAt", String(now), now)
      return result
    } catch (error) {
      db.prepare(`
        INSERT INTO memory_jobs(
          id, job_type, idempotency_key, payload_json, status, priority,
          attempt_count, next_run_at, last_error, created_at, updated_at
        ) VALUES (?, 'deep-archivist-retry', ?, '{}', 'failed', 5, 1, ?, ?, ?, ?)
        ON CONFLICT(idempotency_key) DO UPDATE SET
          status = 'failed', attempt_count = memory_jobs.attempt_count + 1,
          next_run_at = excluded.next_run_at, last_error = excluded.last_error,
          updated_at = excluded.updated_at
      `).run(
        `job_deep_${now}`,
        `deep-archivist:${date}`,
        now + DEEP_FAILURE_RETRY_MS,
        error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000),
        now,
        now,
      )
      console.warn("[Memory v2] deep Archivist deferred after failure:", error)
      return null
    }
  }
}

export const memoryV2ArchivistScheduler = new MemoryV2ArchivistScheduler()
