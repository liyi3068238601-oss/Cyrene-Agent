import fs from "fs";
import os from "os";
import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const electronMock = vi.hoisted(() => ({
  userDataDir: "",
}));

vi.mock("electron", () => ({
  app: {
    getPath: () => electronMock.userDataDir,
  },
  shell: {
    openPath: vi.fn(),
  },
}));

describe("chats store", () => {
  beforeEach(() => {
    vi.resetModules();
    electronMock.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-chats-store-"));
  });

  it("includes messageCount in paged session metadata", async () => {
    const { createSession, getSessionPage, initialize } = await import("./chats-store");
    initialize();

    const session = createSession({
      initialMessages: [
        { id: "1", role: "user", content: "one", at: 1 },
        { id: "2", role: "model", content: "two", at: 2 },
        { id: "3", role: "user", content: "three", at: 3 },
      ],
    });

    const page = getSessionPage(session.id, null, 2);

    expect(page?.messages).toHaveLength(2);
    expect(page?.session.messageCount).toBe(3);
  });

  it("persists and indexes a session purpose", async () => {
    let store = await import("./chats-store");
    store.initialize();

    const created = store.createSession({
      title: "昔涟的主动消息",
      purpose: "proactive-chat",
    });

    expect(store.listSessions()).toContainEqual(expect.objectContaining({
      id: created.id,
      purpose: "proactive-chat",
    }));

    vi.resetModules();
    store = await import("./chats-store");
    store.initialize();

    expect(store.getSessionByPurpose("proactive-chat")?.id).toBe(created.id);
    expect(store.getSession(created.id)?.purpose).toBe("proactive-chat");
  });

  it("returns one proactive session for repeated singleton requests", async () => {
    const store = await import("./chats-store");
    store.initialize();

    const sessions = await Promise.all(Array.from({ length: 8 }, async () => (
      store.getOrCreateSessionByPurpose("proactive-chat", { title: "昔涟的主动消息" })
    )));

    expect(new Set(sessions.map((session) => session.id)).size).toBe(1);
    expect(store.listSessions().filter((session) => session.purpose === "proactive-chat")).toHaveLength(1);

    store.appendMessage(sessions[0].id, { id: "p1", role: "model", content: "主动问候", at: 1 });
    expect(store.getSession(sessions[0].id)?.title).toBe("昔涟的主动消息");
  });

  it("recreates the proactive singleton after it is deleted", async () => {
    const store = await import("./chats-store");
    store.initialize();

    const first = store.getOrCreateSessionByPurpose("proactive-chat", { title: "昔涟的主动消息" });
    expect(store.deleteSession(first.id)).toBe(true);

    const second = store.getOrCreateSessionByPurpose("proactive-chat", { title: "昔涟的主动消息" });
    expect(second.id).not.toBe(first.id);
    expect(store.getSessionByPurpose("proactive-chat")?.id).toBe(second.id);
  });
});

describe("deleted chat retention", () => {
  beforeEach(() => {
    electronMock.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-store-"));
    vi.resetModules();
  });

  it("hides a deleted branch immediately and removes its file only after archival", async () => {
    const store = await import("./chats-store");
    const archived: string[] = [];
    store.setDeletedSessionArchiver((session) => {
      archived.push(session.id);
      return true;
    });
    store.initialize();
    const session = store.createSession({
      title: "temporary branch",
      initialMessages: [{ id: "m1", role: "user", content: "保留这段普通聊天", at: 1 }],
    });
    const deletedAt = Date.now();

    expect(store.deleteSession(session.id, deletedAt)).toBe(true);
    expect(store.listSessions().some((item) => item.id === session.id)).toBe(false);
    expect(store.getSession(session.id)).toBeNull();

    const filePath = path.join(electronMock.userDataDir, "cyrene-chats", "sessions", `${session.id}.json`);
    const retained = JSON.parse(fs.readFileSync(filePath, "utf8")) as { deletedAt: number; messages: unknown[] };
    expect(retained.deletedAt).toBe(deletedAt);
    expect(retained.messages).toHaveLength(1);

    expect(store.cleanupExpiredDeletedSessions(
      deletedAt + store.DELETED_SESSION_RETENTION_MS - 1,
    )).toBe(0);
    expect(fs.existsSync(filePath)).toBe(true);
    expect(store.cleanupExpiredDeletedSessions(
      deletedAt + store.DELETED_SESSION_RETENTION_MS,
    )).toBe(1);
    expect(archived).toEqual([session.id]);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it("never soft-deletes the main session", async () => {
    const store = await import("./chats-store");
    store.initialize();
    expect(store.deleteSession(store.MAIN_SESSION_ID)).toBe(false);
    expect(store.getSession(store.MAIN_SESSION_ID)?.isMain).toBe(true);
  });

  it("retains an expired deleted session when archival is unavailable", async () => {
    const store = await import("./chats-store");
    store.initialize();
    const session = store.createSession({
      title: "must survive",
      initialMessages: [{ id: "m1", role: "user", content: "不要直接删除", at: 1 }],
    });
    const deletedAt = Date.now();
    store.deleteSession(session.id, deletedAt);

    expect(store.cleanupExpiredDeletedSessions(
      deletedAt + store.DELETED_SESSION_RETENTION_MS,
    )).toBe(0);
    expect(fs.existsSync(path.join(
      electronMock.userDataDir,
      "cyrene-chats",
      "sessions",
      `${session.id}.json`,
    ))).toBe(true);
  });
});
