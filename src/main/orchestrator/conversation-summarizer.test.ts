import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: () => "C:\\tmp\\cyrene-summary-tests" },
}));

import {
  countMessagesAfterCachedTail,
  fingerprintConversationMessage,
  KEEP_RECENT,
} from "./conversation-summarizer";
import type { ChatMessage } from "./vendors";

describe("conversation summary sliding-window freshness", () => {
  it("counts new messages even when the total window length stays fixed", () => {
    const original: ChatMessage[] = Array.from({ length: 150 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `message-${index}`,
    }));
    const cachedTail = fingerprintConversationMessage(original[149]);
    const shifted = [
      ...original.slice(10),
      ...Array.from({ length: 10 }, (_, index): ChatMessage => ({
        role: index % 2 === 0 ? "user" : "assistant",
        content: `new-message-${index}`,
      })),
    ];

    expect(shifted).toHaveLength(150);
    expect(countMessagesAfterCachedTail(shifted, cachedTail)).toBe(10);
  });

  it("forces legacy caches without a fingerprint to refresh", () => {
    expect(countMessagesAfterCachedTail([{ role: "user", content: "hello" }])).toBe(10);
  });

  it("keeps fifty recent dialogue turns verbatim", () => {
    expect(KEEP_RECENT).toBe(100);
  });
});
