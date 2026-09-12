import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import ts from "typescript";

describe("SnowLuma guardian without real QQ", () => {
  it("reaps its fake runtime when the owner pipe closes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cyrene-guardian-test-"));
    const source = await fs.readFile(path.join(__dirname, "snowluma-guardian.ts"), "utf8");
    await fs.writeFile(path.join(root, "guardian.cjs"), ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText);
    await fs.writeFile(path.join(root, "index.mjs"), 'console.log(process.pid);setInterval(()=>{},1000);');
    const guardian = spawn(process.execPath, [path.join(root, "guardian.cjs")], { cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let childPid = 0;
    const exit = once(guardian, "exit");
    try {
      const [data] = await once(guardian.stdout!, "data");
      childPid = Number(String(data).trim());
      expect(childPid).toBeGreaterThan(0);
      process.kill(childPid, 0);
      guardian.stdin!.end();
      await exit;
      expect(() => process.kill(childPid, 0)).toThrow();
    } finally {
      guardian.stdin?.end();
      if (childPid) { try { process.kill(childPid); } catch {} }
      if (guardian.exitCode === null) guardian.kill();
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 15000);
});
