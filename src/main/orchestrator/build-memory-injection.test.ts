import { beforeEach, describe, expect, it, vi } from "vitest"
import { clearRecentMemoryInjections, wasRecentlyInjectedMemory } from "../memory/recent-injected-memory"

const ragMock = vi.hoisted(() => ({
  searchMemory: vi.fn(),
  searchMemoryEntries: vi.fn(),
  updateWorldbookActivation: vi.fn(),
  getPermanentWorldbookEntries: vi.fn(),
  getActiveWorldbookEntries: vi.fn(),
  getCascadeWorldbookEntries: vi.fn(),
  INJECTION_HEADER: "HEADER",
  INJECTION_PREAMBLE: "PREAMBLE",
}))

const memoryStoreMock = vi.hoisted(() => ({
  getAllL2: vi.fn(),
  getL0: vi.fn(),
  getL1: vi.fn(),
  updateL2RecallStats: vi.fn(),
}))

const entityGraphMock = vi.hoisted(() => ({
  search: vi.fn(),
}))

vi.mock("../rag", () => ragMock)
vi.mock("../memory/memory-store", () => ({ memoryStore: memoryStoreMock }))
vi.mock("../memory/entity-graph", () => ({ entityGraph: entityGraphMock }))
vi.mock("./tool-registry", () => ({ toolRegistry: { getEnabledTools: vi.fn(() => []) } }))

describe("buildMemoryInjection", () => {
  beforeEach(() => {
    clearRecentMemoryInjections()
    ragMock.searchMemory.mockReset()
    ragMock.searchMemoryEntries.mockReset()
    ragMock.searchMemory.mockResolvedValue([])
    ragMock.searchMemoryEntries.mockResolvedValue([])
    memoryStoreMock.getAllL2.mockReset()
    memoryStoreMock.getAllL2.mockResolvedValue([])
    memoryStoreMock.updateL2RecallStats.mockReset()
    memoryStoreMock.updateL2RecallStats.mockResolvedValue(undefined)
    entityGraphMock.search.mockReset()
    entityGraphMock.search.mockReturnValue("")
  })

  it("records injected user memory l2 ids from RAG metadata", async () => {
    ragMock.searchMemoryEntries.mockResolvedValue([{
      id: "rag_run",
      text: "用户喜欢跑步",
      createdAt: Date.now(),
      score: 0.8,
      metadata: { l2Id: "l2_run" },
    }])
    const { buildMemoryInjection } = await import("./index")

    const context = await buildMemoryInjection("跑步")

    expect(context).toContain("用户喜欢跑步")
    expect(wasRecentlyInjectedMemory("l2_run")).toBe(true)
    expect(ragMock.searchMemoryEntries).toHaveBeenCalledWith("跑步", "user_memory", 40, { recordRecall: false })
  })

  it("keeps branch memories isolated while the main session can read all", async () => {
    ragMock.searchMemoryEntries.mockResolvedValue([
      { id: "a", text: "A memory", createdAt: 1, score: 0.9, metadata: { l2Id: "l2a", sessionId: "branch-a" } },
      { id: "b", text: "B memory", createdAt: 1, score: 0.8, metadata: { l2Id: "l2b", sessionId: "branch-b" } },
      { id: "legacy", text: "Legacy memory", createdAt: 1, score: 0.7, metadata: { l2Id: "legacy" } },
    ])
    const { buildMemoryInjection } = await import("./index")

    const branch = await buildMemoryInjection("memory", { sessionId: "branch-a" })
    expect(branch).toContain("A memory")
    expect(branch).toContain("Legacy memory")
    expect(branch).not.toContain("B memory")

    const main = await buildMemoryInjection("memory", { sessionId: "main", includeAllSessions: true })
    expect(main).toContain("A memory")
    expect(main).toContain("B memory")
  })
})
