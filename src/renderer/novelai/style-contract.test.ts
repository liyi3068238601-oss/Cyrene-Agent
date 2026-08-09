import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = fs.readFileSync(fileURLToPath(new URL("./novelai.css", import.meta.url)), "utf8");
const wardrobe = fs.readFileSync(fileURLToPath(new URL("./wardrobe.css", import.meta.url)), "utf8");

function colorToken(name: string): string {
  const match = css.match(new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, "i"));
  if (!match) throw new Error(`Missing color token ${name}`);
  return match[1];
}

function relativeLuminance(hex: string): number {
  const channels = hex.slice(1).match(/../g)!.map((pair) => Number.parseInt(pair, 16) / 255);
  const linear = channels.map((value) => value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrast(first: string, second: string): number {
  const values = [relativeLuminance(first), relativeLuminance(second)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

describe("NovelAI warm studio styles", () => {
  it("defines the warm-white palette", () => {
    for (const token of ["--nai-canvas", "--nai-surface", "--nai-text", "--nai-muted", "--nai-accent", "--nai-danger"]) {
      expect(css).toContain(token);
    }
  });

  it("meets WCAG AA contrast for compact text and white primary labels", () => {
    const surface = colorToken("--nai-surface");
    const softSurface = colorToken("--nai-surface-soft");
    const primaryLabel = "#fffdf9";
    expect(contrast(colorToken("--nai-muted"), surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(colorToken("--nai-muted"), softSurface)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(colorToken("--nai-accent"), primaryLabel)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(colorToken("--nai-accent-strong"), primaryLabel)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(colorToken("--nai-success"), surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(colorToken("--nai-danger"), softSurface)).toBeGreaterThanOrEqual(4.5);
  });

  it("uses an opaque high-contrast focus ring including keyboard-focused assets", () => {
    const focus = colorToken("--nai-focus");
    expect(contrast(focus, colorToken("--nai-surface"))).toBeGreaterThanOrEqual(3);
    expect(css).toMatch(/outline:\s*3px solid var\(--nai-focus\)/);
    expect(wardrobe).toMatch(/\.asset-item:focus-visible\s*\{[^}]*outline:\s*3px solid var\(--nai-focus\)/s);
    expect(wardrobe).toMatch(/#download-result\.result-action:focus-visible\s*\{[^}]*var\(--nai-focus\)/s);
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

  it("keeps desktop work panels independently scrollable in short windows", () => {
    expect(css).toMatch(/\.studio\s*\{[^}]*height:\s*100vh/s);
    expect(css).toMatch(/\.create-page\s*\{[^}]*min-height:\s*0/s);
    expect(css).toMatch(
      /\.creation-panel,\s*\.canvas-area\s*\{[^}]*min-height:\s*0[^}]*overflow-y:\s*auto[^}]*overscroll-behavior:\s*contain/s,
    );
    expect(css).toMatch(
      /@media\s*\(max-width:\s*900px\)\s*\{[\s\S]*?\.studio\s*\{[^}]*height:\s*auto/s,
    );
    expect(css).toMatch(
      /@media\s*\(max-width:\s*900px\)\s*\{[\s\S]*?\.creation-panel,\s*\.canvas-area\s*\{[^}]*min-height:\s*auto[^}]*overflow:\s*visible[^}]*overscroll-behavior:\s*auto/s,
    );
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
