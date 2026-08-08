import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = path.resolve(__dirname, "..", "..", "..");
const windowFactoryFiles = [
  "src/main/startup/create-main-window.ts",
  "src/main/windows/create-aux-windows.ts",
];

describe("production renderer entry paths", () => {
  it("resolves every window page from app.getAppPath()/dist/renderer", () => {
    for (const relativePath of windowFactoryFiles) {
      const source = fs.readFileSync(path.join(projectRoot, relativePath), "utf8");

      expect(source, relativePath).not.toMatch(
        /path\.join\(__dirname,[\s\S]{0,100}?"renderer"/,
      );
      expect(source, relativePath).toContain(
        'path.join(app.getAppPath(), "dist", "renderer"',
      );
    }
  });
});
