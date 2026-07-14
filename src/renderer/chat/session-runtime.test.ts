import { describe, expect, it } from "vitest";
import { hideVisibleMessages, SessionMessageCache } from "./session-runtime";

interface TestMessage { id: string; content: string; thinking?: boolean; hidden?: boolean }

describe("SessionMessageCache", () => {
  it("preserves an in-flight thinking message when a session is reopened", () => {
    const cache = new SessionMessageCache<TestMessage>();
    const live = [{ id: "user", content: "hello" }, { id: "reply", content: "", thinking: true }];
    cache.remember("a", live);

    const reopened = cache.load("a", [{ id: "user", content: "hello" }]);
    expect(reopened).toBe(live);
    expect(reopened[1]).toMatchObject({ id: "reply", thinking: true });
  });

  it("keeps partial streamed content and isolates different sessions", () => {
    const cache = new SessionMessageCache<TestMessage>();
    const first = cache.remember("a", [{ id: "reply", content: "正在慢慢输出" }]);
    const second = cache.load("b", [{ id: "other", content: "另一个会话" }]);

    expect(cache.load("a", [])).toBe(first);
    expect(cache.load("a", [])[0].content).toBe("正在慢慢输出");
    expect(second).toEqual([{ id: "other", content: "另一个会话" }]);
  });

  it("merges messages persisted externally without dropping transient state", () => {
    const cache = new SessionMessageCache<TestMessage>();
    cache.remember("main", [{ id: "stream", content: "partial" }]);
    const result = cache.load("main", [{ id: "proactive", content: "new persisted message" }]);

    expect(result.map((message) => message.id)).toEqual(["stream", "proactive"]);
  });
});

describe("hideVisibleMessages", () => {
  it("marks messages as window-hidden without removing their content", () => {
    const messages = [
      { id: "user", content: "普通聊天细节" },
      { id: "reply", content: "仍然保留的回复" },
    ];

    expect(hideVisibleMessages(messages)).toBe(2);
    expect(messages).toEqual([
      { id: "user", content: "普通聊天细节", hidden: true },
      { id: "reply", content: "仍然保留的回复", hidden: true },
    ]);
    expect(hideVisibleMessages(messages)).toBe(0);
  });
});
