import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const electronMock = vi.hoisted(() => ({ userDataDir: "" }));

vi.mock("electron", () => ({
  app: { getPath: () => electronMock.userDataDir },
  shell: { openPath: vi.fn() },
}));

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
