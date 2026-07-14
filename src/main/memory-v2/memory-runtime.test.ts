import { describe, expect, it } from "vitest"
import { MemoryV2Database } from "./database"
import { initializeMemoryAutomationRuntime, isMemoryAutomationPaused, setMemoryAutomationPaused } from "./memory-runtime"

describe("memory automation pause", () => {
  it("persists and restores the privacy pause state", () => {
    const db = new MemoryV2Database(":memory:")
    setMemoryAutomationPaused(true, db, 100)
    expect(isMemoryAutomationPaused()).toBe(true)
    setMemoryAutomationPaused(false)
    expect(initializeMemoryAutomationRuntime(db)).toBe(true)
    expect(db.prepare("SELECT value FROM memory_meta WHERE key = 'automation.paused'").get()?.value).toBe("true")
    setMemoryAutomationPaused(false, db, 200)
    db.close()
  })
})
