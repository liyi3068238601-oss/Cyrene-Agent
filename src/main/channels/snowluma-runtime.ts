import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { createServer } from "node:net";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import * as yauzl from "yauzl";
import { ONEBOT_WS_PATH } from "./adapters/qq/onebot-reverse-ws";

export const SNOWLUMA_VERSION = "1.14.15";
export const SNOWLUMA_SHA256 = "ab657f8121f8b503c8637ae9bf47d8982e4925897d9aa5d99056e04638f05809";
const ASSET_URL = `https://github.com/SnowLuma/SnowLuma/releases/download/v${SNOWLUMA_VERSION}/SnowLuma-v${SNOWLUMA_VERSION}-win-x64.zip`;

export function buildSnowLumaConfig(account: string, port: number, token: string) {
  if (!/^[1-9]\d{4,9}$/.test(account) || !token || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("QQ 账号、端口或 Token 无效");
  }
  return {
    networks: { httpServers: [], httpClients: [], wsServers: [], wsClients: [{
      name: "cyrene", enabled: true, url: `ws://127.0.0.1:${port}${ONEBOT_WS_PATH}`,
      role: "Universal", accessToken: token, messageFormat: "array",
      reportSelfMessage: false, reconnectIntervalMs: 3000,
    }] },
  };
}

export function validateArchiveEntry(name: string, mode: number): void {
  const normalized = name.replace(/\\/g, "/");
  if (normalized.startsWith("/") || normalized.includes(":") || normalized.split("/").some(part =>
    part === ".." || /[ .]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))
    || (mode & 0o170000) === 0o120000) throw new Error("压缩包包含不安全路径");
}

export async function freeLoopbackPort(): Promise<number> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

/** Reuse the existing origin, including migrating first-version instances. */
export async function prepareSnowLumaWebUi(configDirectory: string): Promise<number> {
  await fs.mkdir(configDirectory, { recursive: true });
  const runtimePath = path.join(configDirectory, "runtime.json");
  const previous = await fs.readFile(runtimePath, "utf8").then(JSON.parse).catch(error => {
    if (error.code === "ENOENT") return {};
    throw new Error("SnowLuma runtime.json 无法读取，请检查实例配置后重试");
  });
  const port = previous.webuiPort === undefined ? await freeLoopbackPort() : previous.webuiPort;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("SnowLuma WebUI 端口无效，请检查 runtime.json");
  // Do not silently change origin on conflict or terminate another application's listener.
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", () => reject(new Error(`SnowLuma WebUI 端口 ${port} 不可用，请释放该端口后重试`)));
    probe.listen(port, "127.0.0.1", () => probe.close(error => error ? reject(error) : resolve()));
  });
  await fs.writeFile(runtimePath, JSON.stringify({ ...previous, webuiHost: "127.0.0.1", webuiPort: port,
    webuiTls: { enabled: false }, hookAutoLoad: false, logMaxTotalMb: 256, logRetainDays: 7 }, null, 2));
  return port;
}

export async function extractSnowLumaArchive(archive: string, destination: string): Promise<void> {
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) =>
    yauzl.open(archive, { lazyEntries: true }, (error, value) => error ? reject(error) : resolve(value!)));
  try {
    await new Promise<void>((resolve, reject) => {
      let bytes = 0;
      zip.once("error", reject);
      zip.once("end", resolve);
      zip.on("entry", (entry: yauzl.Entry) => {
        void (async () => {
          validateArchiveEntry(entry.fileName, entry.externalFileAttributes >>> 16);
          bytes += entry.uncompressedSize;
          if (bytes > 1024 * 1024 * 1024) throw new Error("SnowLuma 解压大小超过限制");
          const target = path.join(destination, entry.fileName);
          if (entry.fileName.endsWith("/")) await fs.mkdir(target, { recursive: true });
          else {
            await fs.mkdir(path.dirname(target), { recursive: true });
            const input = await new Promise<import("node:stream").Readable>((ok, fail) =>
              zip.openReadStream(entry, (error, stream) => error ? fail(error) : ok(stream!)));
            await pipeline(input, createWriteStream(target, { flags: "wx" }));
          }
          zip.readEntry();
        })().catch(reject);
      });
      zip.readEntry();
    });
  } finally { zip.close(); }
}

export class SnowLumaRuntime {
  private child: ChildProcess | null = null;
  private stopping = false;
  webuiUrl: string | undefined;
  constructor(readonly root: string, private readonly notify: (message: string, failed?: boolean) => void) {}

  async install(): Promise<void> {
    if (process.platform !== "win32" || process.arch !== "x64") throw new Error("首版内置安装仅支持 Windows x64");
    await fs.mkdir(this.root, { recursive: true });
    const stage = await fs.mkdtemp(path.join(this.root, "staging-"));
    const archive = path.join(stage, "snowluma.zip");
    try {
      const response = await fetch(ASSET_URL, { signal: AbortSignal.timeout(180_000) });
      if (!response.ok || !response.body) throw new Error(`SnowLuma 下载失败 (${response.status})`);
      const file = await fs.open(archive, "w");
      const hash = createHash("sha256");
      let count = 0;
      let announced = 0;
      try {
        for await (const chunk of response.body) {
          count += chunk.length;
          if (count > 100 * 1024 * 1024) throw new Error("SnowLuma 下载超过大小限制");
          hash.update(chunk);
          await file.writeFile(chunk);
          const mb = Math.floor(count / 1048576);
          if (mb !== announced) { announced = mb; this.notify(`下载 SnowLuma：${mb} MiB`); }
        }
      } finally { await file.close(); }
      if (hash.digest("hex") !== SNOWLUMA_SHA256) throw new Error("SnowLuma SHA-256 校验失败");
      const unpack = path.join(stage, "unpacked");
      await extractSnowLumaArchive(archive, unpack);
      // Official archives may have a single enclosing directory.
      let source = unpack;
      if (!await exists(path.join(source, "index.mjs"))) {
        const dirs = (await fs.readdir(unpack, { withFileTypes: true })).filter(e => e.isDirectory());
        if (dirs.length !== 1) throw new Error("SnowLuma 包结构无效");
        source = path.join(unpack, dirs[0].name);
      }
      for (const file of ["index.mjs", "node.exe", "package.json", "native"]) await fs.access(path.join(source, file));
      await fs.writeFile(path.join(source, "cyrene-installation.json"), JSON.stringify({
        version: SNOWLUMA_VERSION, sha256: SNOWLUMA_SHA256, url: ASSET_URL,
      }, null, 2));
      await fs.rename(source, path.join(this.root, "runtime"));
    } finally { await fs.rm(stage, { recursive: true, force: true }); }
  }

  async start(account: string, port: number, token: string): Promise<void> {
    if (this.child) throw new Error("SnowLuma 已启动");
    const cwd = path.join(this.root, "runtime");
    const config = path.join(cwd, "config");
    await fs.mkdir(config, { recursive: true });
    const webPort = await prepareSnowLumaWebUi(config);
    // A disabled adapter prevents SnowLuma's empty-network default fallback.
    const disabled = buildSnowLumaConfig(account, port, token);
    disabled.networks.wsClients[0].enabled = false;
    await fs.writeFile(path.join(config, "onebot.json"), JSON.stringify(disabled));
    await fs.writeFile(path.join(config, `onebot_${account}.json`), JSON.stringify(buildSnowLumaConfig(account, port, token)));
    const local = path.join(this.root, "environment");
    for (const dir of ["home", "temp", "appdata", "localappdata"]) await fs.mkdir(path.join(local, dir), { recursive: true });
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("SNOWLUMA_")));
    const env: NodeJS.ProcessEnv = { ...inherited,
      HOME: path.join(local, "home"), USERPROFILE: path.join(local, "home"),
      APPDATA: path.join(local, "appdata"), LOCALAPPDATA: path.join(local, "localappdata"),
      TEMP: path.join(local, "temp"), TMP: path.join(local, "temp"),
      SNOWLUMA_HOOK_AUTOLOAD: "0", SNOWLUMA_WEBUI_PORT: String(webPort), SNOWLUMA_WEBUI_HOST: "127.0.0.1",
      SNOWLUMA_LOG_DIR: path.join(cwd, "logs"),
    };
    for (const key of ["ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "SNOWLUMA_DEV_MODE", "SNOWLUMA_ACCEPT_EULA", "SNOWLUMA_ACCEPT_PRIVACY"]) delete env[key];
    // External Node cannot read Electron's app.asar filesystem.
    const guardian = path.join(this.root, "snowluma-guardian.cjs");
    await fs.writeFile(guardian, await fs.readFile(path.join(__dirname, "snowluma-guardian.js")));
    const child = spawn(path.join(cwd, "node.exe"), [guardian], {
      cwd, env, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    let recent = "";
    let credentialsSaved = false;
    let credentialsWrite: Promise<void> = Promise.resolve();
    const read = (data: Buffer) => {
      // Do not forward SnowLuma output: it can contain passwords, tokens and message bodies.
      recent = (recent + data.toString("utf8")).slice(-8192);
      // SL deliberately prints the initial credential only to stdout, not its logs.
      // Keep it in an explicitly named private file, never in IPC/status or general logs.
      const credential = recent.match(/initial credentials: user=admin password=([a-f0-9]{16})/);
      if (credential && !credentialsSaved) {
        credentialsSaved = true;
        credentialsWrite = fs.writeFile(path.join(this.root, "webui-initial-credentials.txt"),
          `Username: admin\nInitial password: ${credential[1]}\nChange this password in WebUI, then delete this file.\n`, { mode: 0o600 });
        void credentialsWrite.catch(() => this.notify("无法保存初始 WebUI 凭据，请停止后重试", true));
      }
      const match = recent.match(/listening http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) this.webuiUrl = `http://127.0.0.1:${Number(match[1])}/`;
    };
    child.stdout?.on("data", read);
    child.stderr?.on("data", read);
    child.on("error", () => {
      if (this.child === child) this.child = null;
      this.notify("SnowLuma 进程启动失败", true);
    });
    child.once("exit", code => {
      // 主动停止不报失败；停止超时后 stopping 已复位，此后的退出仍按异常上报。
      if (this.child === child && !this.stopping) { this.child = null; this.webuiUrl = undefined; this.notify(`SnowLuma 已退出 (${code ?? "signal"})`, true); }
    });
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      if (!this.child) throw new Error("SnowLuma 启动期间退出");
      if (this.webuiUrl) {
        if (this.webuiUrl !== `http://127.0.0.1:${webPort}/`) {
          await this.stop();
          throw new Error(`WebUI 未绑定固定端口 ${webPort}，请检查端口占用后重试`);
        }
        await credentialsWrite;
        this.notify("SnowLuma WebUI 已启动；OneBot 地址和 Token 已自动配置"); return;
      }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    await this.stop();
    throw new Error("SnowLuma WebUI 启动超时");
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.webuiUrl = undefined;
    this.stopping = true;
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("SnowLuma 停止超时，请检查该实例进程")), 10_000);
        child.once("exit", () => { clearTimeout(timer); if (this.child === child) this.child = null; resolve(); });
        child.stdin?.end();
      });
    } finally { this.stopping = false; }
  }
}
async function exists(file: string): Promise<boolean> { return fs.access(file).then(() => true, () => false); }
