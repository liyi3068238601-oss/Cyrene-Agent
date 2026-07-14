import { describe, expect, it, vi } from "vitest";
import type { L2Memory } from "./memory-types";
import { commitCompressedSummary, type CompressionSyncDeps } from "./memory-compressor";

function source(id: string, sessionId: string): L2Memory {
  return {
    id,
    content: `memory ${id}`,
    triggerText: `trigger ${id}`,
    sourceConversationId: sessionId,
    createdAt: 1,
    lastAccessedAt: 1,
    accessCount: 0,
    weight: 30,
    isPinned: false,
    status: "active",
    syncStatus: "synced",
    ragId: `rag_${id}`,
    evidenceIds: [`ev_${id}`],
    sourceMessageIds: [`msg_${id}`],
  };
}

function createDeps(options?: { failRag?: boolean }) {
  const calls: string[] = [];
  let created: L2Memory | null = null;
  let metadata: Record<string, unknown> | undefined;
  const deps: CompressionSyncDeps = {
    addL2Memory: vi.fn(async (input) => {
      calls.push("add-l2");
      const memory: L2Memory = {
        ...input,
        id: "summary_l2",
        createdAt: 2,
        lastAccessedAt: 2,
        accessCount: 0,
        weight: 30,
        status: "active",
      };
      created = memory;
      return memory;
    }),
    addMemory: vi.fn(async (_text, _source, value) => {
      calls.push("add-rag");
      metadata = value;
      if (options?.failRag) throw new Error("embedding unavailable");
      return "rag_summary";
    }),
    markL2SyncStatus: vi.fn(async (_id, status, ragId) => {
      calls.push(`mark-${status}`);
      if (created) {
        created.syncStatus = status;
        if (ragId) created.ragId = ragId;
      }
      return created;
    }),
    archiveL2Batch: vi.fn(async () => { calls.push("archive"); }),
  };
  return { deps, calls, getMetadata: () => metadata };
}

describe("compressed memory RAG synchronization", () => {
  it("indexes a same-session summary before archiving its source memories", async () => {
    const fake = createDeps();
    const result = await commitCompressedSummary(
      "用户持续在改进 Agent",
      [source("a", "branch-a"), source("b", "branch-a"), source("c", "branch-a")],
      fake.deps,
    );

    expect(result.ok).toBe(true);
    expect(fake.calls).toEqual(["add-l2", "add-rag", "mark-synced", "archive"]);
    expect(fake.getMetadata()).toMatchObject({
      l2Id: "summary_l2",
      sessionId: "branch-a",
      isSummary: true,
      sourceSessionIds: ["branch-a"],
    });
    expect(result.summary?.evidenceIds).toEqual(["ev_a", "ev_b", "ev_c"]);
    expect(result.summary?.sourceMessageIds).toEqual(["msg_a", "msg_b", "msg_c"]);
  });

  it("marks cross-session summaries as main-only global memories", async () => {
    const fake = createDeps();
    const result = await commitCompressedSummary(
      "用户在多个话题里持续开发 Agent",
      [source("a", "branch-a"), source("b", "branch-b")],
      fake.deps,
    );

    expect(result.summary?.sourceConversationId).toBe("main");
    expect(result.summary?.sourceConversationIds).toEqual(["branch-a", "branch-b"]);
    expect(fake.getMetadata()).toMatchObject({ globalSummary: true });
    expect(fake.getMetadata()).not.toHaveProperty("sessionId");
  });

  it("keeps source memories active when RAG synchronization fails", async () => {
    const fake = createDeps({ failRag: true });
    const result = await commitCompressedSummary(
      "暂时无法索引的总结",
      [source("a", "branch-a"), source("b", "branch-a")],
      fake.deps,
    );

    expect(result.ok).toBe(false);
    expect(fake.calls).toEqual(["add-l2", "add-rag", "mark-sync_failed"]);
    expect(fake.deps.archiveL2Batch).not.toHaveBeenCalled();
  });
});
