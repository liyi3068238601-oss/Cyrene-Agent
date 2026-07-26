import { describe, expect, it, vi } from "vitest"
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

describe("enqueueLLMTask options", () => {
  it("can run a background observer without adding terminal noise", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await enqueueLLMTask("心情观察器", async () => "ok", { log: false });
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it("can disable the automatic rate-limit retry for one-shot extractors", async () => {
    vi.useFakeTimers();
    const task = vi.fn().mockRejectedValue(new Error("HTTP 429 rate limit"));
    try {
      const result = enqueueLLMTask("one-shot", task, {
        log: false,
        retryRateLimit: false,
      });
      await vi.runAllTimersAsync();
      await expect(result).rejects.toThrow("429");
      expect(task).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
