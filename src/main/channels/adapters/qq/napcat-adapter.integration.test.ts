import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { IncomingMessage, OutgoingMessage } from "../../types";

const mockedSettings = vi.hoisted(() => ({
  wechat: { enabled: false },
  feishu: { enabled: false },
  qq: {
    enabled: true,
    listenMode: "loopback" as const,
    port: 0,
    allowedPrivateUserIds: ["1000"],
    allowedGroupIds: ["2000", "2001"],
    groupRequireMention: true as const,
    groupReplyStyle: "reply-and-mention" as const,
    groupToolPolicy: "off" as const,
    groupMemoryPolicy: "shared-personal" as const,
  },
  inboundPort: 0,
  sharedSecret: "",
  rateLimitPerUser: 10,
  rateLimitPerChannel: 100,
  ttsEnabled: false,
  stickerEnabled: false,
  mirrorToDesktop: false,
  toolSandbox: "all" as const,
}));

const managed = vi.hoisted(() => ({ instance: null as null | { backend: "snowluma"; accountId: string; autoStart: boolean }, start: vi.fn(), stop: vi.fn() }));
vi.mock("../../qq-instance", () => ({
  readQqInstance: () => managed.instance,
  getSnowLumaRuntime: () => ({ start: managed.start, stop: managed.stop }),
  setQqInstancePhase: vi.fn(),
}));

vi.mock("electron", () => ({
  app: { getPath: () => process.env.TEMP ?? process.cwd() },
}));

vi.mock("../../settings-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../settings-store")>();
  return { ...actual, loadChannelsSettings: () => mockedSettings };
});

import { NapCatAdapter } from "./napcat-adapter";
import { buildSnowLumaConfig } from "../../snowluma-runtime";

const sockets: WebSocket[] = [];
const adapters: NapCatAdapter[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  for (const adapter of adapters.splice(0)) await adapter.stop();
  managed.instance = null;
  managed.start.mockClear();
});

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for fake NapCat flow");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("NapCatAdapter fake reverse WebSocket integration", () => {
  it("does not autostart a managed instance unless explicitly requested", async () => {
    managed.instance = { backend: "snowluma", accountId: "123456", autoStart: false };
    const adapter = new NapCatAdapter(); adapters.push(adapter);
    await adapter.start();
    expect(managed.start).not.toHaveBeenCalled();
    await adapter.start(true);
    expect(managed.start).toHaveBeenCalledWith("123456", expect.any(Number), "");
    expect(managed.start.mock.calls[0][1]).toBeGreaterThan(0);
  });

  it.each(["123456", "999999"])("checks bound SL account during handshake (%s)", async (loginId) => {
    managed.instance = { backend: "snowluma", accountId: "123456", autoStart: true };
    const adapter = new NapCatAdapter(); adapters.push(adapter);
    await adapter.start();
    // Exercise the generated SL URL against the real listener, not a duplicated test URL.
    const port = Number(new URL(String(adapter.getConnectionInfo().listenUrl)).port);
    const url = buildSnowLumaConfig("123456", port, "test-token").networks.wsClients[0].url;
    const socket = new WebSocket(url, { headers: { "X-Self-ID": loginId } });
    sockets.push(socket);
    socket.on("message", raw => {
      const request = JSON.parse(raw.toString());
      socket.send(JSON.stringify({ status: "ok", retcode: 0, echo: request.echo,
        data: request.action === "get_login_info" ? { user_id: loginId } : { app_name: "SnowLuma", app_version: "1.14.15" },
      }));
    });
    if (loginId !== "123456") {
      await new Promise<void>(resolve => socket.once("close", () => resolve()));
      expect(adapter.getConnectionInfo().selfId).toBeFalsy();
    } else {
      await waitFor(() => adapter.getStatus().phase === "running");
      expect(adapter.getConnectionInfo()).toMatchObject({ selfId: "123456", supportsStream: true });
      const received: IncomingMessage[] = [];
      adapter.onMessage = async message => { received.push(message); return null; };
      // This sender is not in NapCat's allowlist, but SL's empty denylist permits it.
      socket.send(JSON.stringify({ post_type: "message", message_type: "private", self_id: loginId,
        user_id: "1002", message_id: "sl-message", time: 1, message: [{ type: "text", data: { text: "test" } }] }));
      await waitFor(() => received.length === 1);
      expect(received[0].accountId).toBe("123456");
    }
  });

  it("handshakes, filters events, deduplicates, and sends private/group replies", async () => {
    const adapter = new NapCatAdapter();
    adapters.push(adapter);
    await adapter.start();
    const url = String(adapter.getConnectionInfo().listenUrl);
    const socket = new WebSocket(url, { headers: { "X-Self-ID": "9000" } });
    sockets.push(socket);
    const actions: Array<{ action: string; params: Record<string, unknown>; echo: string }> = [];

    socket.on("message", (raw) => {
      const request = JSON.parse(raw.toString()) as { action: string; params: Record<string, unknown>; echo: string };
      actions.push(request);
      const data = request.action === "get_login_info"
        ? { user_id: "9000", nickname: "昔涟测试号" }
        : request.action === "get_version_info"
          ? { app_name: "NapCat", app_version: "4.8.115", protocol_version: "v11" }
          : request.action === "get_status"
            ? { online: true, good: true }
          : { message_id: `sent-${actions.length}` };
      socket.send(JSON.stringify({ status: "ok", retcode: 0, data, echo: request.echo }));
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    await waitFor(() => adapter.getStatus().phase === "running");
    expect(adapter.getConnectionInfo()).toMatchObject({
      selfId: "9000",
      nickname: "昔涟测试号",
      appVersion: "4.8.115",
      supportsStream: true,
    });
    await expect(adapter.testConnection()).resolves.toMatchObject({
      ok: true,
      detail: { selfId: "9000", nickname: "昔涟测试号", appVersion: "4.8.115", supportsStream: true },
    });

    const incoming: IncomingMessage[] = [];
    adapter.onMessage = async (message) => {
      incoming.push(message);
      const outgoing: OutgoingMessage = {
        channel: "qq",
        chatType: message.chatType,
        targetId: message.chatId,
        replyContext: message.chatType === "group"
          ? { messageId: message.messageId!, mentionUserId: message.senderId }
          : undefined,
        parts: message.chatType === "group"
          ? [{ kind: "text", text: `收到：${message.text}` }, { kind: "text", text: "第二段" }]
          : [{ kind: "text", text: `收到：${message.text}` }],
      };
      await adapter.send(outgoing);
      return outgoing;
    };

    const groupEvent = {
      time: 1_700_000_000,
      self_id: "9000",
      post_type: "message",
      message_type: "group",
      message_id: "group-1",
      user_id: "1000",
      group_id: "2000",
      sender: { user_id: "1000", card: "群成员" },
      message: [
        { type: "at", data: { qq: "9000" } },
        { type: "text", data: { text: "你好" } },
      ],
    };
    socket.send(JSON.stringify(groupEvent));
    await waitFor(() => actions.filter((item) => item.action === "send_group_msg").length === 2);
    const groupSends = actions.filter((item) => item.action === "send_group_msg");
    const groupSend = groupSends[0];
    expect(groupSend.params.group_id).toBe("2000");
    expect(groupSend.params.message).toEqual([
      { type: "reply", data: { id: "group-1" } },
      { type: "at", data: { qq: "1000" } },
      { type: "text", data: { text: " " } },
      { type: "text", data: { text: "收到：你好" } },
    ]);
    expect(groupSends[1].params.message).toEqual([{ type: "text", data: { text: "第二段" } }]);

    socket.send(JSON.stringify(groupEvent));
    socket.send(JSON.stringify({ ...groupEvent, message_id: "group-no-at", message: [{ type: "text", data: { text: "不应回复" } }] }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(actions.filter((item) => item.action === "send_group_msg")).toHaveLength(2);

    socket.send(JSON.stringify({
      ...groupEvent,
      message_type: "private",
      message_id: "private-1",
      group_id: undefined,
      message: [{ type: "text", data: { text: "私聊" } }],
    }));
    await waitFor(() => actions.some((item) => item.action === "send_private_msg"));
    expect(actions.find((item) => item.action === "send_private_msg")?.params).toMatchObject({
      user_id: "1000",
      message: [{ type: "text", data: { text: "收到：私聊" } }],
    });

    socket.send(JSON.stringify({
      ...groupEvent,
      message_type: "private",
      message_id: "private-denied",
      user_id: "1001",
      group_id: undefined,
      message: [{ type: "text", data: { text: "不在白名单" } }],
    }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(incoming).toHaveLength(2);

    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const handedOff: string[] = [];
    adapter.onMessage = async (message) => {
      handedOff.push(message.messageId!);
      if (message.messageId === "handoff-1") await firstGate;
      return null;
    };
    socket.send(JSON.stringify({ ...groupEvent, message_id: "handoff-1" }));
    socket.send(JSON.stringify({ ...groupEvent, message_id: "handoff-2" }));
    await waitFor(() => handedOff.length === 2);
    expect(handedOff).toEqual(["handoff-1", "handoff-2"]);
    releaseFirst();
  });
});
