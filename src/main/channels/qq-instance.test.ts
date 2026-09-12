import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const state = vi.hoisted(() => ({ root: "", qq: {} as Record<string, unknown>, install: vi.fn(), stop: vi.fn() }));
vi.mock("electron", () => ({ app: { getPath: () => state.root } }));
vi.mock("./settings-store", () => ({
  loadChannelsSettings: () => ({ qq: state.qq }),
  saveChannelsSettings: (config: { qq: Record<string, unknown> }) => { state.qq = config.qq; },
}));
vi.mock("./snowluma-runtime", () => ({
  SNOWLUMA_VERSION: "test", freeLoopbackPort: async () => 16321,
  SnowLumaRuntime: class { install = state.install; stop = state.stop; },
}));

beforeEach(async () => {
  vi.resetModules();
  state.root = await fs.mkdtemp(path.join(os.tmpdir(), "cyrene-instance-test-"));
  state.qq = { enabled: false, allowedPrivateUserIds: ["old"], allowedGroupIds: ["old"] };
  state.install.mockReset().mockResolvedValue(undefined);
  state.stop.mockReset().mockResolvedValue(undefined);
});
afterEach(async () => { await fs.rm(state.root, { recursive: true, force: true }); });

describe("single managed QQ instance", () => {
  it("installs once, resets allowlists and rejects a second account", async () => {
    const api = await import("./qq-instance");
    await api.createQqInstance({ action: "create", backend: "snowluma", accountId: "123456" });
    expect(state.install).toHaveBeenCalledTimes(1);
    expect(api.readQqInstance()).toEqual({ backend: "snowluma", accountId: "123456", autoStart: false });
    expect(state.qq).toMatchObject({ enabled: false, listenMode: "loopback", allowedGroupIds: [], allowedPrivateUserIds: [], groupRequireMention: true });
    expect(state.qq.accessToken).toMatch(/^[a-f0-9]{64}$/);
    await expect(api.createQqInstance({ action: "create", backend: "snowluma", accountId: "234567" })).rejects.toThrow("只允许一个");
    api.configureQqInstance(true);
    expect(api.readQqInstance()?.autoStart).toBe(true);
  });
  it("leaves no manifest on download failure and allows a retry", async () => {
    const api = await import("./qq-instance");
    state.install.mockRejectedValueOnce(new Error("download failed"));
    const request = { action: "create", backend: "snowluma", accountId: "123456" } as const;
    await expect(api.withQqInstanceOperation(() => api.createQqInstance(request))).rejects.toThrow("download failed");
    expect(api.readQqInstance()).toBeNull();
    await api.withQqInstanceOperation(() => api.createQqInstance(request));
    expect(api.readQqInstance()?.accountId).toBe("123456");
  });
  it("blocks concurrent operations, then releases the lock", async () => {
    const api = await import("./qq-instance");
    let release!: () => void;
    const first = api.withQqInstanceOperation(() => new Promise<void>(resolve => { release = resolve; }));
    await expect(api.withQqInstanceOperation(async () => {})).rejects.toThrow("进行中");
    release(); await first;
    await expect(api.withQqInstanceOperation(async () => "ok")).resolves.toBe("ok");
  });
  it("retains data on delete and can explicitly clear it without a manifest", async () => {
    const api = await import("./qq-instance");
    await api.createQqInstance({ action: "create", backend: "snowluma", accountId: "123456" });
    const runtime = path.join(api.qqInstanceRoot(), "snowluma", "runtime");
    await fs.mkdir(runtime, { recursive: true });
    await fs.writeFile(path.join(runtime, "sentinel"), "owned");
    await api.deleteQqInstance(false);
    expect(api.readQqInstance()).toBeNull();
    expect(await fs.readFile(path.join(runtime, "sentinel"), "utf8")).toBe("owned");
    await expect(api.createQqInstance({ action: "create", backend: "snowluma", accountId: "234567" })).rejects.toThrow("保留");
    await api.deleteQqInstance(true);
    await expect(fs.access(runtime)).rejects.toThrow();
  });
});
