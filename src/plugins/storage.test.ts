import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPluginStorage } from "./storage";

let tmp: string;

afterEach(() => {
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = "";
  }
});

describe("createPluginStorage", () => {
  it("get/set 落盘并可读回；缺失返回 undefined", () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "cyrene-store-test-"));
    const s = createPluginStorage(tmp);
    s.set("cfg", { a: 1 });
    expect(s.get<{ a: number }>("cfg")).toEqual({ a: 1 });
    expect(s.get("missing")).toBeUndefined();
    expect(s.rootDir()).toBe(tmp);
  });
});
