import { describe, expect, it } from "vitest"
import { enqueueLLMTask, getLLMQueueStatus } from "./llm-queue"

describe("LLM background queue status", () => {
  it("reports queued and active work then returns to idle", async () => {
    let release: (() => void) | null = null
    const gate = new Promise<void>((resolve) => { release = resolve })
    const first = enqueueLLMTask("queue-status-first", async () => {
      await gate
      return "first"
    })
    const second = enqueueLLMTask("queue-status-second", async () => "second")

    expect(getLLMQueueStatus()).toMatchObject({ queued: 2, active: 0, idle: false })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(getLLMQueueStatus()).toMatchObject({ queued: 1, active: 1, idle: false })
    release!()
    await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"])
    expect(getLLMQueueStatus()).toEqual({ queued: 0, active: 0, idle: true })
  })

  it("clears active status after a non-rate-limit failure", async () => {
    await expect(enqueueLLMTask("queue-status-failure", async () => {
      throw new Error("ordinary failure")
    })).rejects.toThrow("ordinary failure")
    expect(getLLMQueueStatus()).toEqual({ queued: 0, active: 0, idle: true })
  })
})
