// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

describe("feature plugin settings panel", () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="feature-plugins-list"></div>';
    vi.resetModules();
  });

  it("renders an enabled plugin and opens its controlled window", async () => {
    const open = vi.fn(async () => ({ ok: true }));
    const api = {
      list: async () => [{
        id: "novelai",
        name: "NovelAI",
        version: "0.1.0",
        description: "image generation",
        author: "Cyrene",
        entry: "index.cjs",
        defaultEnabled: true,
        enabled: true,
        hasUnregister: true,
        canOpen: true,
      }],
      setEnabled: vi.fn(async () => ({ ok: true })),
      open,
    };
    const { renderFeaturePlugins } = await import("./panel");

    await renderFeaturePlugins(api);
    const buttons = Array.from(document.querySelectorAll("button"));
    expect(document.body.textContent).toContain("NovelAI v0.1.0");
    expect(buttons.map((button) => button.textContent)).toContain("打开");

    buttons.find((button) => button.textContent === "打开")!.click();
    await vi.waitFor(() => expect(open).toHaveBeenCalledWith("novelai"));
  });
});
