import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createContext, type PluginRuntime } from "../context";
import { NOVELAI } from "./channels";
import { registerNovelAi } from "./service";

vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: () => [] },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString("utf8"),
  },
  shell: { openPath: async () => "" },
}));

let tmp = "";

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = "";
});

function harness() {
  const tools: string[] = [];
  const ipc = new Map<string, (...args: unknown[]) => unknown>();
  const runtime: PluginRuntime = {
    toolRegistry: {
      register: (tool) => tools.push(tool.id),
      unregister: (id) => {
        const index = tools.indexOf(id);
        if (index >= 0) tools.splice(index, 1);
        return true;
      },
    },
    channelManager: {
      register: () => {},
      unregister: async () => true,
      startOne: async () => {},
    },
    registerIpc: (channel, handler) => ipc.set(channel, handler),
    unregisterIpc: (channel) => ipc.delete(channel),
    appEvents: { on: () => {} },
    llm: {
      translateText: async (messages) =>
        `T:${messages.map((message) => message.content).join("|")}`,
    },
  };
  tmp = mkdtempSync(path.join(os.tmpdir(), "cyrene-novelai-test-"));
  return {
    ctx: createContext("novelai", tmp, runtime, ["llm"]),
    ipc,
    tools,
  };
}

describe("NovelAI 插件服务", () => {
  it("注册带插件前缀的核心 IPC 和绘图工具", async () => {
    const { ctx, ipc, tools } = harness();
    registerNovelAi(ctx);

    expect(ipc.has(`plugin:novelai:${NOVELAI.GENERATE}`)).toBe(true);
    expect(ipc.has(`plugin:novelai:${NOVELAI.LOAD_CONFIG}`)).toBe(true);
    expect(ipc.has(`plugin:novelai:${NOVELAI.TRANSLATE_PROMPT}`)).toBe(true);
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.every((id) => id.startsWith("novelai_"))).toBe(true);

    const saveConfig = ipc.get(`plugin:novelai:${NOVELAI.SAVE_CONFIG}`)!;
    const loadConfig = ipc.get(`plugin:novelai:${NOVELAI.LOAD_CONFIG}`)!;
    await saveConfig({ gatewayUrl: "http://127.0.0.1:31555", apiKey: "secret" });
    expect(loadConfig()).toMatchObject({
      gatewayUrl: "http://127.0.0.1:31555",
      apiKey: "secret",
    });

    const translate = ipc.get(`plugin:novelai:${NOVELAI.TRANSLATE_PROMPT}`)!;
    await expect(
      translate([{ role: "user", content: "你好" }]),
    ).resolves.toBe("T:你好");

    await ctx.dispose();
    expect(tools).toEqual([]);
  });
});
