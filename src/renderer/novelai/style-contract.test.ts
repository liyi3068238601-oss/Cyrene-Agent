import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = fs.readFileSync(fileURLToPath(new URL("./novelai.css", import.meta.url)), "utf8");
const wardrobe = fs.readFileSync(fileURLToPath(new URL("./wardrobe.css", import.meta.url)), "utf8");

describe("NovelAI warm studio styles", () => {
  it("defines the warm-white palette", () => {
    for (const token of ["--nai-canvas", "--nai-surface", "--nai-text", "--nai-muted", "--nai-accent", "--nai-danger"]) {
      expect(css).toContain(token);
    }
  });

  it("implements focus-canvas and activity layouts", () => {
    expect(css).toMatch(/\.create-page\s*\{[^}]*grid-template-columns/s);
    expect(css).toContain(".activity-shell");
    expect(css).toContain("#activity-drawer");
  });

  it("visually emphasizes failed activity summaries", () => {
    expect(css).toMatch(/#activity-summary\.is-error\s*\{[^}]*color:\s*var\(--nai-danger\)/s);
  });

  it("keeps asset errors visible and technical details collapsed by default", () => {
    expect(css).toMatch(/#asset-status\.is-error\s*\{[^}]*color:\s*var\(--nai-danger\)/s);
    expect(css).toMatch(/#asset-status-details\[hidden\]\s*\{[^}]*display:\s*none/s);
  });

  it("styles the download action without overriding its hidden state", () => {
    expect(wardrobe).toMatch(/#download-result\.result-action\s*\{[^}]*border:[^}]*background:[^}]*text-decoration:\s*none/s);
    expect(wardrobe).toMatch(/#download-result\.result-action:focus-visible\s*\{[^}]*outline:/s);
    expect(wardrobe).toMatch(/#download-result\.result-action\[hidden\]\s*\{[^}]*display:\s*none/s);
  });

  it("supports small windows and keyboard focus", () => {
    expect(css).toMatch(/@media\s*\(max-width:\s*900px\)/);
    expect(css).toContain(":focus-visible");
  });

  it("lets the wrapped narrow titlebar grow beyond the desktop row", () => {
    expect(css).toMatch(/@media\s*\(max-width:\s*900px\)\s*\{[\s\S]*?\.studio\s*\{[^}]*grid-template-rows:\s*auto\s+minmax\(0,\s*1fr\)\s+auto/s);
  });

  it("keeps history card actions visible for keyboard users", () => {
    expect(css).toMatch(/\.history-item:focus-visible\s*\{[^}]*outline:/s);
    expect(wardrobe).toMatch(/\.history-item:focus-within\s+\.history-item__replay,\s*\.history-item:focus-within\s+\.history-item__favorite,\s*\.history-item:focus-within\s+\.history-item__delete\s*\{[^}]*opacity:\s*1/s);
  });

  it("shows focus on hidden upscale radio choices", () => {
    expect(wardrobe).toMatch(/\.upscale-dialog\s+fieldset\s+input:focus-visible\s*\+\s*span\s*\{[^}]*(?:outline|box-shadow):/s);
  });

  it("removes old dark wardrobe colors", () => {
    expect(wardrobe).not.toContain("#100d20");
    expect(wardrobe).not.toContain("#171326");
  });
});
