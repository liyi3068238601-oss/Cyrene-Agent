import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const html = fs.readFileSync(fileURLToPath(new URL("./index.html", import.meta.url)), "utf8");

describe("NovelAI beginner layout", () => {
  it("presents the three-step create flow", () => {
    expect(html).toContain('data-nai-page="create"');
    for (const label of ["1. 描述画面", "2. 选择角色与服装", "3. 开始绘制"]) expect(html).toContain(label);
    expect(html).toMatch(/id="natural-prompt"[\s\S]*id="prompt"/);
  });

  it("moves low-frequency tools to internal pages", () => {
    expect(html).toContain('id="open-library" data-nai-route="library"');
    expect(html).toContain('id="open-settings" data-nai-route="settings"');
    expect(html).toContain('data-nai-page="library" hidden');
    expect(html).toContain('data-nai-page="settings" hidden');
    expect(html).toContain("返回创作");
  });

  it("keeps advanced controls collapsed", () => {
    expect(html).toMatch(/<details class="advanced-settings">[\s\S]*?<summary>[\s\S]*高级设置/);
    expect(html).not.toMatch(/<details class="advanced-settings"[^>]* open/);
    for (const id of ["negative", "model", "width", "height", "steps", "scale", "sampler", "seed", "reference-mode", "variant-count"]) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  it("provides the collapsed task drawer", () => {
    expect(html).toContain('id="activity-toggle"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('id="activity-drawer" hidden');
  });

  it("preserves critical integration ids", () => {
    for (const id of ["connection-badge", "generate", "status", "preview", "task-list", "history", "test", "save", "asset-library", "profile-character-select", "outfit-editor"]) {
      expect(html).toContain(`id="${id}"`);
    }
  });
});
