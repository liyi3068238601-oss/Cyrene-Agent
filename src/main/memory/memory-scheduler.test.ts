import { describe, expect, it, vi } from "vitest"
import type { MemoryScribeEvent } from "../memory-v2/scribe-queue"
import { MemoryScheduler, type MemorySchedulerDeps } from "./memory-scheduler"
import type { MemoryCandidate, MemoryJudgeTurn } from "./memory-types"

function createScheduler(overrides: Partial<MemorySchedulerDeps> = {}) {
  const calls: string[] = []
  const enqueueLabels: string[] = []
  const pending: MemoryScribeEvent[] = []
  const completed: string[] = []
  let roundCount = 0
  let queue = Promise.resolve()
  let sequence = 0
  const deps: MemorySchedulerDeps = {
    ingestEntity: vi.fn((text: string) => calls.push(`ingest:${text}`)),
    enqueueTask: <T>(label: string, task: () => Promise<T>) => {
      enqueueLabels.push(label)
      const run = queue.then(task)
      queue = run.then(() => undefined, () => undefined)
      return run
    },
    judgeMemory: vi.fn(async () => [] as MemoryCandidate[]),
    writeMemory: vi.fn(async () => { calls.push("write") }),
    getL1: vi.fn(async () => ({
      recentGoals: "",
      recentPreferences: "",
      currentProject: "",
      generatedAt: 0,
      roundCount,
    })),
    replaceL1Field: vi.fn(async (_field: "roundCount", value: number) => {
      roundCount = value
      calls.push(`round:${value}`)
    }),
    runReflectionAndCompression: vi.fn(async () => { calls.push("reflection") }),
    runResolverQueueOnce: vi.fn(async () => { calls.push("resolver") }),
    enqueueScribeTurn: vi.fn((userText, assistantText, conversationId) => {
      const id = `event-${++sequence}`
      const event: MemoryScribeEvent = {
        id,
        conversationId,
        userText,
        assistantText,
        occurredAt: sequence,
        attemptCount: 0,
        userSourceId: `${id}:user`,
        assistantSourceId: `${id}:assistant`,
      }
      pending.push(event)
      return event
    }),
    getPendingScribeCount: vi.fn(() => pending.length),
    claimPendingScribeEvents: vi.fn((limit) => pending.splice(0, limit)),
    completeScribeEvents: vi.fn((ids) => {
      completed.push(...ids)
      return ids.length
    }),
    failScribeEvents: vi.fn(() => 0),
    setIdleTimer: vi.fn(() => ({ unref: vi.fn() }) as unknown as ReturnType<typeof setTimeout>),
    clearIdleTimer: vi.fn(),
    ...overrides,
  }

  return { scheduler: new MemoryScheduler(deps), deps, calls, enqueueLabels, pending, completed }
}

function candidate(triggerText = "user 6"): MemoryCandidate {
  return {
    layer: "L2",
    summary: "用户喜欢香菇",
    content: "用户喜欢香菇",
    confidence: 0.9,
    triggerText,
    importance: "medium",
    stability: "situational",
    certainty: "explicit",
    attribution: "user_explicit",
    evidenceQuotes: [triggerText],
    contextSummary: "用户表达食物偏好",
    shouldWrite: true,
    reason: "用户明确表达",
    forbiddenOverclaims: [],
  }
}

describe("MemoryScheduler global Scribe", () => {
  it("persists turns but defers Scribe before six pending turns", async () => {
    const { scheduler, deps, enqueueLabels, pending } = createScheduler()
    for (let index = 1; index <= 5; index += 1) {
      scheduler.scheduleMemoryWrite(`user ${index}`, `assistant ${index}`)
    }
    await vi.waitFor(() => expect(deps.replaceL1Field).toHaveBeenCalledWith("roundCount", 5))

    expect(pending).toHaveLength(5)
    expect(deps.ingestEntity).toHaveBeenCalledTimes(10)
    expect(enqueueLabels).toEqual(Array(5).fill("MemoryMaintenance"))
    expect(deps.judgeMemory).not.toHaveBeenCalled()
  })

  it("processes six globally pending turns and marks them complete", async () => {
    const memory = candidate()
    const { scheduler, deps, completed } = createScheduler({
      judgeMemory: vi.fn(async () => [memory]),
    })
    for (let index = 1; index <= 6; index += 1) {
      scheduler.scheduleMemoryWrite(`user ${index}`, `assistant ${index}`)
    }
    await vi.waitFor(() => expect(deps.writeMemory).toHaveBeenCalledWith(
      [memory],
      "default",
      expect.arrayContaining([
        expect.objectContaining({ id: "event-1" }),
        expect.objectContaining({ id: "event-6" }),
      ]),
    ))

    const turns = vi.mocked(deps.judgeMemory).mock.calls[0][0]
    expect(turns.map((turn: MemoryJudgeTurn) => turn.userInput)).toEqual([
      "user 1", "user 2", "user 3", "user 4", "user 5", "user 6",
    ])
    expect(vi.mocked(deps.judgeMemory).mock.calls[0][1]).toBe("global")
    expect(completed).toHaveLength(6)
  })

  it("treats conversations as one global long-term memory stream", async () => {
    const { scheduler, deps } = createScheduler()
    for (let index = 1; index <= 3; index += 1) {
      scheduler.scheduleMemoryWrite(`a${index}`, `reply a${index}`, "branch-a")
      scheduler.scheduleMemoryWrite(`b${index}`, `reply b${index}`, "branch-b")
    }
    await vi.waitFor(() => expect(deps.judgeMemory).toHaveBeenCalledTimes(1))
    const turns = vi.mocked(deps.judgeMemory).mock.calls[0][0]
    expect(turns.map((turn) => turn.userInput)).toEqual(["a1", "b1", "a2", "b2", "a3", "b3"])
    expect(deps.judgeMemory).toHaveBeenCalledWith(expect.any(Array), "global")
  })

  it("processes a backlog in non-overlapping eight-turn chunks", async () => {
    const { scheduler, deps } = createScheduler()
    for (let index = 1; index <= 12; index += 1) {
      scheduler.scheduleMemoryWrite(`user ${index}`, `assistant ${index}`)
    }
    await vi.waitFor(() => expect(deps.judgeMemory).toHaveBeenCalledTimes(2))

    expect(vi.mocked(deps.judgeMemory).mock.calls[0][0].map((turn) => turn.userInput))
      .toEqual(["user 1", "user 2", "user 3", "user 4", "user 5", "user 6", "user 7", "user 8"])
    expect(vi.mocked(deps.judgeMemory).mock.calls[1][0].map((turn) => turn.userInput))
      .toEqual(["user 9", "user 10", "user 11", "user 12"])
  })

  it("flushes even a single pending turn after the idle trigger", async () => {
    const { scheduler, deps } = createScheduler()
    scheduler.scheduleMemoryWrite("single user", "single assistant", "branch")
    await scheduler.flushIdleNow()
    expect(deps.judgeMemory).toHaveBeenCalledWith([
      { userInput: "single user", assistantReply: "single assistant" },
    ], "global")
  })

  it("releases claimed events for retry when judging fails", async () => {
    const { scheduler, deps } = createScheduler({
      judgeMemory: vi.fn(async () => { throw new Error("judge failed") }),
    })
    for (let index = 1; index <= 6; index += 1) {
      scheduler.scheduleMemoryWrite(`user ${index}`, `assistant ${index}`)
    }
    await vi.waitFor(() => expect(deps.failScribeEvents).toHaveBeenCalled())
    expect(deps.completeScribeEvents).not.toHaveBeenCalled()
  })

  it("keeps resolver and reflection maintenance cadence", async () => {
    const { scheduler, deps } = createScheduler({
      getL1: vi.fn(async () => ({
        recentGoals: "",
        recentPreferences: "",
        currentProject: "",
        generatedAt: 0,
        roundCount: 19,
      })),
    })
    scheduler.scheduleMemoryWrite("user", "assistant")
    await vi.waitFor(() => expect(deps.runReflectionAndCompression).toHaveBeenCalled())
    expect(deps.replaceL1Field).toHaveBeenCalledWith("roundCount", 20)
    expect(deps.runResolverQueueOnce).toHaveBeenCalled()
  })
})
