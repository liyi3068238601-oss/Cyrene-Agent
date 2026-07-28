import { randomUUID } from "crypto"
import { enqueueLLMTask } from "../llm-queue"
import {
  claimMemoryScribeEvents,
  completeMemoryScribeEvents,
  enqueueMemoryScribeTurn,
  failMemoryScribeEvents,
  getPendingMemoryScribeCount,
  getMemoryV2BridgeStatus,
  getMemoryV2Database,
} from "../memory-v2/bridge"
import type { MemoryScribeEvent } from "../memory-v2/scribe-queue"
import { sanitizeMemoryModelText, writeMemoryCandidatesV2 } from "../memory-v2/scribe-writer"
import { isMemoryAutomationPaused } from "../memory-v2/memory-runtime"
import { runReflectionAndCompression } from "./memory-compressor"
import { entityGraph } from "./entity-graph"
import { memoryJudge } from "./memory-judge"
import { memoryManager } from "./memory-manager"
import { runResolverQueueOnce } from "./memory-resolver"
import { memoryStore } from "./memory-store"
import type { L1Profile, MemoryCandidate, MemoryJudgeTurn, MemoryJudgeResult, ExtractedEntity } from "./memory-types"

const SCRIBE_MIN_PENDING_TURNS = 6
const SCRIBE_MAX_BACKLOG_TURNS = 30
const SCRIBE_CONTEXT_TURNS = 8
const SCRIBE_IDLE_MS = 10 * 60 * 1000

interface SchedulerEvent extends MemoryScribeEvent {
  persistent: boolean
}

export interface MemorySchedulerDeps {
  ingestEntity: (text: string) => void
  ingestEntities: (entities: ExtractedEntity[]) => void
  enqueueTask: <T>(label: string, task: () => Promise<T>) => Promise<T>
  judgeMemory: (turns: MemoryJudgeTurn[], conversationId: string) => Promise<MemoryJudgeResult>
  writeMemory: (candidates: MemoryCandidate[], conversationId: string, events: MemoryScribeEvent[]) => Promise<void>
  getL1: () => Promise<L1Profile>
  replaceL1Field: (field: "roundCount", value: number) => Promise<void>
  runReflectionAndCompression: () => Promise<void>
  runResolverQueueOnce: () => Promise<unknown>
  enqueueScribeTurn: (userInput: string, assistantReply: string, conversationId: string) => MemoryScribeEvent | null
  getPendingScribeCount: () => number
  claimPendingScribeEvents: (limit: number) => MemoryScribeEvent[]
  completeScribeEvents: (ids: string[]) => number
  failScribeEvents: (ids: string[], error: unknown) => number
  setIdleTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  clearIdleTimer?: (timer: ReturnType<typeof setTimeout>) => void
}

function chunk<T>(items: T[], size: number): T[][] {
  const groups: T[][] = []
  for (let index = 0; index < items.length; index += size) groups.push(items.slice(index, index + size))
  return groups
}

function sourceConversationForCandidate(candidate: MemoryCandidate, events: SchedulerEvent[]): string {
  const quotes = [candidate.triggerText, ...(candidate.evidenceQuotes ?? [])]
    .map((item) => item.trim())
    .filter(Boolean)
  for (const event of events) {
    if (quotes.some((quote) => event.userText.includes(quote) || quote.includes(event.userText))) {
      return event.conversationId
    }
  }
  return events[events.length - 1]?.conversationId ?? "global"
}

export class MemoryScheduler {
  private fallbackEvents: SchedulerEvent[] = []
  private idleTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly deps: MemorySchedulerDeps) {}

  scheduleMemoryWrite(userInput: string, assistantReply: string, conversationId = "default"): void {
    if (isMemoryAutomationPaused()) return
    const persisted = this.deps.enqueueScribeTurn(userInput, assistantReply, conversationId)
    if (!persisted) {
      this.fallbackEvents.push({
        id: `fallback_${randomUUID()}`,
        conversationId,
        userText: userInput,
        assistantText: assistantReply,
        occurredAt: Date.now(),
        attemptCount: 0,
        userSourceId: "",
        assistantSourceId: "",
        persistent: false,
      })
    }

    try {
      this.deps.ingestEntity(userInput)
      this.deps.ingestEntity(assistantReply)
    } catch (error) {
      console.warn("[Memory] 实体图谱提取失败:", error)
    }

    this.armIdleFlush()
    this.deps.enqueueTask("MemoryMaintenance", async () => {
      await this.runQueuedMaintenance(false)
    }).catch((error) => {
      console.error("[Memory] 记忆维护失败，不影响主流程:", error)
    })
  }

  async flushIdleNow(): Promise<void> {
    await this.deps.enqueueTask("MemoryScribeIdle", async () => {
      await this.runScribeIfNeeded(true)
    })
  }

  dispose(): void {
    if (this.idleTimer) this.clearTimer(this.idleTimer)
    this.idleTimer = null
  }

  private armIdleFlush(): void {
    if (this.idleTimer) this.clearTimer(this.idleTimer)
    const setTimer = this.deps.setIdleTimer ?? setTimeout
    this.idleTimer = setTimer(() => {
      this.idleTimer = null
      void this.flushIdleNow().catch((error) => {
        console.warn("[Memory] 空闲 Scribe 执行失败:", error)
      })
    }, SCRIBE_IDLE_MS)
    this.idleTimer.unref?.()
  }

  private clearTimer(timer: ReturnType<typeof setTimeout>): void {
    const clearTimer = this.deps.clearIdleTimer ?? clearTimeout
    clearTimer(timer)
  }

  private pendingCount(): number {
    return this.deps.getPendingScribeCount() + this.fallbackEvents.length
  }

  private claimEvents(limit: number): SchedulerEvent[] {
    const persistent = this.deps.claimPendingScribeEvents(limit).map((event) => ({ ...event, persistent: true }))
    const remaining = Math.max(0, limit - persistent.length)
    const fallback = this.fallbackEvents.splice(0, remaining)
    return [...persistent, ...fallback]
  }

  private async runQueuedMaintenance(forceScribe: boolean): Promise<void> {
    const l1 = await this.deps.getL1()
    const newCount = (l1.roundCount || 0) + 1

    await this.runScribeIfNeeded(forceScribe)
    await this.deps.replaceL1Field("roundCount", newCount)

    if (newCount % 5 === 0) {
      try {
        await this.deps.runResolverQueueOnce()
      } catch (error) {
        console.warn("[Memory] Resolver 队列处理失败，不影响主流程:", error)
      }
    }

    if (newCount % 20 === 0) {
      console.log("[Memory] 达到 20 轮，触发 Reflection + 记忆压缩")
      await this.deps.runReflectionAndCompression()
    }
  }

  private async runScribeIfNeeded(force: boolean): Promise<void> {
    if (isMemoryAutomationPaused()) return
    const pending = this.pendingCount()
    if (pending === 0 || (!force && pending < SCRIBE_MIN_PENDING_TURNS)) return

    const events = this.claimEvents(Math.min(pending, SCRIBE_MAX_BACKLOG_TURNS))
    if (events.length === 0) return
    const persistentIds = events.filter((event) => event.persistent).map((event) => event.id)
    const fallback = events.filter((event) => !event.persistent)

    try {
      for (const group of chunk(events, SCRIBE_CONTEXT_TURNS)) {
        const turns = group.map((event) => ({
          userInput: sanitizeMemoryModelText(event.userText),
          assistantReply: sanitizeMemoryModelText(event.assistantText),
        }))
        const { candidates, entities } = await this.deps.judgeMemory(turns, "global")
        for (const candidate of candidates) {
          await this.deps.writeMemory([candidate], sourceConversationForCandidate(candidate, group), group)
        }
        if (entities.length > 0) {
          try {
            this.deps.ingestEntities(entities)
          } catch (error) {
            console.warn("[Memory] LLM 实体注入失败:", error)
          }
        }
      }
      this.deps.completeScribeEvents(persistentIds)
      const database = getMemoryV2Database()
      const now = Date.now()
      database?.prepare(`
        INSERT INTO memory_meta(key, value, updated_at) VALUES ('scribe.lastAt', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `).run(String(now), now)
    } catch (error) {
      this.deps.failScribeEvents(persistentIds, error)
      this.fallbackEvents.unshift(...fallback)
      throw error
    }
  }
}

export const memoryScheduler = new MemoryScheduler({
  ingestEntity: (text) => entityGraph.ingest(text),
  ingestEntities: (entities) => entityGraph.ingestEntities(entities),
  enqueueTask: enqueueLLMTask,
  judgeMemory: (turns, conversationId) => memoryJudge.judgeRecentTurns(turns, conversationId),
  writeMemory: async (candidates, conversationId, events) => {
    const status = getMemoryV2BridgeStatus()
    const database = getMemoryV2Database()
    if (status.mode === "v2" && database) {
      writeMemoryCandidatesV2(database, candidates, events)
      return
    }
    await memoryManager.writeMemory(candidates, conversationId)
  },
  getL1: () => memoryStore.getL1(),
  replaceL1Field: (field, value) => memoryStore.replaceL1Field(field, value),
  runReflectionAndCompression,
  runResolverQueueOnce,
  enqueueScribeTurn: enqueueMemoryScribeTurn,
  getPendingScribeCount: getPendingMemoryScribeCount,
  claimPendingScribeEvents: claimMemoryScribeEvents,
  completeScribeEvents: completeMemoryScribeEvents,
  failScribeEvents: failMemoryScribeEvents,
})
