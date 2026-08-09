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

  it("supports small windows and keyboard focus", () => {
    expect(css).toMatch(/@media\s*\(max-width:\s*900px\)/);
    expect(css).toContain(":focus-visible");
  });

  it("removes old dark wardrobe colors", () => {
    expect(wardrobe).not.toContain("#100d20");
    expect(wardrobe).not.toContain("#171326");
  });
});
