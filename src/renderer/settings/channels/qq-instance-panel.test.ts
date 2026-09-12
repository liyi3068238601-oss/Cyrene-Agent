// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { bindQqInstancePanel } from "./qq-instance-panel";

afterEach(() => { window.dispatchEvent(new Event("beforeunload")); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe("managed QQ settings panel", () => {
  it("locks a created account and exposes only the ready WebUI link", async () => {
    document.documentElement.innerHTML = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    const call = vi.fn().mockResolvedValue({ instance: { backend: "snowluma", accountId: "123456", autoStart: false }, phase: "running", message: "ready", root: "E:/owned", webuiUrl: "http://127.0.0.1:16300/" });
    Object.defineProperty(window, "settings", { configurable: true, value: { channelsQqInstance: call, channelsGetConfig: vi.fn().mockResolvedValue({ qq: {} }) } });
    bindQqInstancePanel(async () => {});
    await vi.waitFor(() => expect((document.querySelector("#qq-instance-account") as HTMLInputElement).disabled).toBe(true));
    expect((document.querySelector('[data-action="create"]') as HTMLButtonElement).disabled).toBe(true);
    expect((document.querySelector('[data-action="open"]') as HTMLButtonElement).disabled).toBe(false);
    expect((document.querySelector("#qq-instance-url") as HTMLInputElement).value).toBe("http://127.0.0.1:16300/");
    expect((document.querySelector("#channels-qq-port") as HTMLInputElement).disabled).toBe(true);
    expect(document.querySelector("#qq-instance-feedback")?.textContent).toContain("运行中");
  });
  it("allows explicit cleanup of retained data even after deleting the manifest", async () => {
    document.documentElement.innerHTML = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    Object.defineProperty(window, "settings", { configurable: true, value: { channelsQqInstance: vi.fn().mockResolvedValue({ instance: null, phase: "absent", message: "retained", root: "E:/owned" }), channelsGetConfig: vi.fn().mockResolvedValue({ qq: {} }) } });
    bindQqInstancePanel(async () => {});
    await vi.waitFor(() => expect(document.querySelector("#qq-instance-feedback")?.textContent).toContain("未创建"));
    expect((document.querySelector('[data-action="delete"]') as HTMLButtonElement).disabled).toBe(false);
    expect((document.querySelector('[data-action="start"]') as HTMLButtonElement).disabled).toBe(true);
  });
  it("separates backend cards and keeps tutorials collapsed", () => {
    document.documentElement.innerHTML = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    const sl = document.querySelector("#qq-snowluma-card")!;
    const napcat = document.querySelector("#qq-napcat-card")!;
    expect(sl).not.toBe(napcat);
    expect(sl.querySelector("#channels-qq-token")).toBeNull();
    expect(napcat.querySelector("#qq-instance-url")).toBeNull();
    expect((sl.querySelector("details") as HTMLDetailsElement).open).toBe(false);
    expect(sl.textContent).not.toContain("保存白名单");
    expect(sl.textContent).toContain("空黑名单默认放行");
    expect((napcat.querySelector("details") as HTMLDetailsElement).open).toBe(false);
    const ids = [...document.querySelectorAll("[id]")].map(el => el.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it("saves SL blocklists without a restart and blocks the other backend", async () => {
    document.documentElement.innerHTML = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    const instance = vi.fn().mockResolvedValue({ instance: { backend: "snowluma", accountId: "123456", autoStart: false }, phase: "running", message: "ready", root: "owned", onebotUrl: "ws://127.0.0.1:12345/onebot/v11/ws" });
    const save = vi.fn().mockResolvedValue({});
    Object.defineProperty(window, "settings", { configurable: true, value: { channelsQqInstance: instance, channelsGetConfig: vi.fn().mockResolvedValue({ qq: {} }), channelsSaveConfig: save } });
    bindQqInstancePanel(async () => {});
    await vi.waitFor(() => expect((document.querySelector("#qq-instance-save-blocklists") as HTMLButtonElement).disabled).toBe(false));
    const users = document.querySelector("#qq-instance-user-blocklist") as HTMLTextAreaElement;
    users.value = "234567,345678\n234567"; users.dispatchEvent(new Event("input"));
    (document.querySelector("#qq-instance-save-blocklists") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(save).toHaveBeenCalledWith({ qq: { blockedUserIds: ["234567", "345678"], blockedGroupIds: [] } }));
    expect(instance.mock.calls.every(([request]) => request.action === "status")).toBe(true);
    expect((document.querySelector('#qq-napcat-instance-panel [data-action="create"]') as HTMLButtonElement).disabled).toBe(true);
    expect((document.querySelector("#qq-instance-onebot-url") as HTMLInputElement).value).toContain("/onebot/v11/ws");
  });
  it("clears a stale operation error once polling succeeds again", async () => {
    document.documentElement.innerHTML = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    const status = { instance: { backend: "snowluma", accountId: "123456", autoStart: false }, phase: "running", message: "ready", root: "owned", webuiUrl: "http://127.0.0.1:16300/" };
    let actionCalls = 0;
    const instance = vi.fn().mockImplementation((request: { action: string }) => {
      if (request.action === "status") return Promise.resolve(status);
      actionCalls += 1;
      return actionCalls === 1 ? Promise.reject(new Error("启动失败：端口被占用")) : Promise.resolve(status);
    });
    let poll: (() => void) | undefined;
    vi.spyOn(window, "setInterval").mockImplementation(((cb: () => void) => { poll = cb; return 1; }) as unknown as typeof window.setInterval);
    Object.defineProperty(window, "settings", { configurable: true, value: { channelsQqInstance: instance, channelsGetConfig: vi.fn().mockResolvedValue({ qq: {} }) } });
    bindQqInstancePanel(async () => {});
    await vi.waitFor(() => expect(document.querySelector("#qq-instance-feedback")?.textContent).toContain("运行中"));
    (document.querySelector('[data-action="start"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.querySelector("#qq-instance-feedback")?.textContent).toContain("启动失败：端口被占用"));
    poll?.();
    await vi.waitFor(() => expect(document.querySelector("#qq-instance-feedback")?.textContent).toContain("运行中"));
    expect(document.querySelector("#qq-instance-feedback")?.textContent).not.toContain("端口被占用");
  });
});
