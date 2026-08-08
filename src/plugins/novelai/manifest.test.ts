import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readManifest } from "../loader";

const pluginDir = path.resolve(__dirname);
let tmp = "";

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = "";
});

describe("novelai manifest", () => {
  it("声明合法入口和所需依赖", () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "cyrene-novelai-manifest-"));
    writeFileSync(
      path.join(tmp, "manifest.json"),
      readFileSync(path.join(pluginDir, "manifest.json"), "utf8"),
      "utf8",
    );
    writeFileSync(path.join(tmp, "index.js"), "module.exports = {};", "utf8");

    expect(readManifest(tmp)).toMatchObject({
      id: "novelai",
      name: expect.any(String),
      entry: "index.js",
      deps: expect.arrayContaining(["channels", "llm"]),
    });
  });
});
