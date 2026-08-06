import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createContext, type PluginRuntime } from "./context";

let tmp: string;

afterEach(() => {
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = "";
  }
});

function runtime(): PluginRuntime & { tools: string[]; ipc: Map<string, unknown> } {
  const tools: string[] = [];
  const ipc = new Map<string, unknown>();
  return {
    tools,
    ipc,
    toolRegistry: {
      register: (t) => tools.push(t.id),
      unregister: (id) => {
        const i = tools.indexOf(id);
        if (i >= 0) tools.splice(i, 1);
        return true;
      },
    },
    channelManager: { register: () => {}, unregister: async () => true, startOne: async () => {} },
    registerIpc: (c, h) => ipc.set(c, h),
    unregisterIpc: (c) => ipc.delete(c),
    appEvents: { on: () => {} },
  };
}

describe("createContext", () => {
  it("registerIpc 自动加 plugin:<id>: 前缀", () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "cyrene-ctx-test-"));
    const rt = runtime();
    const ctx = createContext("demo", tmp, rt);
    ctx.registerIpc("ping", () => "pong");
    expect(rt.ipc.has("plugin:demo:ping")).toBe(true);
  });

  it("dispose 清理已注册工具与 IPC", () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "cyrene-ctx-test-"));
    const rt = runtime();
    const ctx = createContext("demo", tmp, rt);
    ctx.registerTool({
      id: "demo_tool",
      name: "t",
      description: "d",
      enabled: true,
      inputSchema: { type: "object", properties: {}, required: [] },
      execute: async () => "ok",
    });
    ctx.registerIpc("ping", () => "pong");
    (ctx as unknown as { dispose(): void }).dispose();
    expect(rt.tools).toEqual([]);
    expect(rt.ipc.has("plugin:demo:ping")).toBe(false);
  });

  it("storage 可读写", () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "cyrene-ctx-test-"));
    const ctx = createContext("demo", tmp, runtime());
    ctx.storage.set("k", 1);
    expect(ctx.storage.get<number>("k")).toBe(1);
  });

  it("工具 id 不满足 <插件id>_ 前缀时抛错", () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "cyrene-ctx-test-"));
    const ctx = createContext("demo", tmp, runtime());
    expect(() =>
      ctx.registerTool({
        id: "bad_tool",
        name: "t",
        description: "d",
        enabled: true,
        inputSchema: { type: "object", properties: {}, required: [] },
        execute: async () => "ok",
      }),
    ).toThrow(/demo_/);
  });

  it("未声明 deps 时不注入 channels；声明后注入", () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "cyrene-ctx-test-"));
    const without = createContext("demo", tmp, runtime());
    expect(without.deps.channels).toBeUndefined();
    const withDeps = createContext("demo", tmp, runtime(), ["channels"]);
    expect(withDeps.deps.channels?.channelManager).toBeDefined();
  });
});
