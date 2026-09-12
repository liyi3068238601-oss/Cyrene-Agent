import { afterEach, describe, expect, it } from "vitest";
import { buildSnowLumaConfig, validateArchiveEntry, prepareSnowLumaWebUi, freeLoopbackPort } from "./snowluma-runtime";
import { makeSessionId } from "./channel-context";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:net";

const roots: string[] = [];
async function fixture() { const root = await fs.mkdtemp(path.join(os.tmpdir(), "cyrene-sl-config-")); roots.push(root); return root; }
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

describe("managed QQ isolation", () => {
  it("only connects to the owned loopback listener with authentication", () => {
    const cfg = buildSnowLumaConfig("123456789", 16200, "test-token");
    expect(cfg.networks.httpServers).toEqual([]);
    expect(cfg.networks.wsServers).toEqual([]);
    expect(cfg.networks.wsClients).toEqual([expect.objectContaining({
      url: "ws://127.0.0.1:16200/onebot/v11/ws", accessToken: "test-token", enabled: true, reportSelfMessage: false,
    })]);
    expect(() => buildSnowLumaConfig("../account", 16200, "token")).toThrow();
    expect(() => buildSnowLumaConfig("123456789", 0, "token")).toThrow();
    expect(() => buildSnowLumaConfig("123456789", 16200, "")).toThrow();
  });
  it("rejects traversal, absolute paths and symlinks before extraction", () => {
    for (const entry of ["../escape", "foo/../../escape", "C:/escape", "/escape", "foo\\..\\escape", ".. /escape", "con.txt"]) {
      expect(() => validateArchiveEntry(entry, 0)).toThrow();
    }
    expect(() => validateArchiveEntry("native/link", 0o120777)).toThrow();
    expect(() => validateArchiveEntry("native/snowluma.dll", 0o100644)).not.toThrow();
  });
  it("separates account histories while retaining legacy session keys", () => {
    const first = makeSessionId("qq", "group", "11111");
    expect(first).not.toBe(makeSessionId("qq", "group", "22222"));
    expect(first).not.toBe(makeSessionId("qq", "group"));
    expect(makeSessionId("qq", "group")).toBe(makeSessionId("qq", "group", undefined));
  });
  it("persists a WebUI port and reuses it across starts", async () => {
    const root = await fixture();
    const first = await prepareSnowLumaWebUi(root);
    expect(await prepareSnowLumaWebUi(root)).toBe(first);
    const config = JSON.parse(await fs.readFile(path.join(root, "runtime.json"), "utf8"));
    expect(config).toMatchObject({ webuiPort: first, webuiHost: "127.0.0.1", hookAutoLoad: false });
  });
  it("adopts the first version's existing WebUI port without changing credentials", async () => {
    const root = await fixture();
    const port = await freeLoopbackPort();
    await fs.writeFile(path.join(root, "runtime.json"), JSON.stringify({ webuiPort: port, customSetting: "preserve" }));
    await fs.writeFile(path.join(root, "webui-auth.json"), "credential-sentinel");
    expect(await prepareSnowLumaWebUi(root)).toBe(port);
    expect(await fs.readFile(path.join(root, "webui-auth.json"), "utf8")).toBe("credential-sentinel");
    expect(JSON.parse(await fs.readFile(path.join(root, "runtime.json"), "utf8")).customSetting).toBe("preserve");
  });
  it("fails on a port conflict instead of silently moving the WebUI", async () => {
    const root = await fixture();
    const occupied = createServer();
    await new Promise<void>(resolve => occupied.listen(0, "127.0.0.1", resolve));
    try {
      const port = (occupied.address() as import("node:net").AddressInfo).port;
      await fs.writeFile(path.join(root, "runtime.json"), JSON.stringify({ webuiPort: port }));
      await expect(prepareSnowLumaWebUi(root)).rejects.toThrow("不可用");
      expect(JSON.parse(await fs.readFile(path.join(root, "runtime.json"), "utf8")).webuiPort).toBe(port);
    } finally { await new Promise<void>(resolve => occupied.close(() => resolve())); }
  });
});
