import { describe, expect, it } from "vitest";
import { ChannelManager } from "./manager";
import type { ChannelAdapter } from "./adapters/base";

function fakeAdapter(id: string): ChannelAdapter {
  let started = false;
  return {
    id: id as never,
    displayName: id,
    capability: {} as never,
    onMessage: null,
    start: async () => {
      started = true;
    },
    stop: async () => {
      started = false;
    },
    send: async () => ({ ok: true }),
    getStatus: () => ({ enabled: started, phase: started ? "running" : "offline" }),
  };
}

describe("ChannelManager", () => {
  it("startOne 启动单个 adapter；unregister 先 stop 再移除", async () => {
    const mgr = new ChannelManager();
    const adapter = fakeAdapter("qq");
    mgr.register(adapter);
    await mgr.startOne("qq" as never);
    expect(mgr.getAdapter("qq" as never)).toBeDefined();
    expect(adapter.getStatus().phase).toBe("running");

    const removed = await mgr.unregister("qq" as never);
    expect(removed).toBe(true);
    expect(mgr.getAdapter("qq" as never)).toBeUndefined();
    expect(adapter.getStatus().phase).toBe("offline");
  });

  it("unregister 不存在的 id 返回 false", async () => {
    const mgr = new ChannelManager();
    expect(await mgr.unregister("nope" as never)).toBe(false);
  });
});
