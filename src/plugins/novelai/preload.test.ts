import { beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({
  exposed: new Map<string, unknown>(),
  invoke: vi.fn(async () => undefined),
  on: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: (name: string, value: unknown) => electron.exposed.set(name, value),
  },
  ipcRenderer: {
    invoke: electron.invoke,
    on: electron.on,
    removeListener: electron.removeListener,
  },
}));

describe("NovelAI preload", () => {
  beforeEach(() => {
    electron.exposed.clear();
    electron.invoke.mockClear();
  });

  it("暴露 window.novelai，并保持 translatePrompt(string) 接口", async () => {
    await import("./preload");
    const api = electron.exposed.get("novelai") as {
      translatePrompt(description: string): Promise<unknown>;
    };

    expect(api).toBeDefined();
    await api.translatePrompt("粉色头发的少女");
    expect(electron.invoke).toHaveBeenCalledWith(
      "plugin:novelai:translate-prompt",
      expect.arrayContaining([
        expect.objectContaining({ role: "user", content: "粉色头发的少女" }),
      ]),
    );
  });
});
