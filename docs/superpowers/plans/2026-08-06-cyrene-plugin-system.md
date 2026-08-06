# Cyrene 插件系统（插件文件导入即用）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Cyrene-Agent（上游 `0de38dd` 基座）上实现一个轻量插件系统：插件以「目录 + manifest.json + 入口文件」形态放进 `userData/plugins/`（或随构建进入 `dist/main/plugins/`），应用启动时自动扫描、动态加载、按开关启用，插件能力通过现有 ToolRegistry / ChannelManager / IPC 三套落点暴露，无需修改上游扩展机制。

**Architecture:** 插件契约极简：`manifest.json`（id/name/version/description/author/entry/defaultEnabled/deps）+ 入口文件导出 `register(ctx)` / `unregister()`。`PluginManager` 启动时扫描目录、读 manifest、动态 `import()` 入口，并把 `PluginContext`（注册工具/注册 IPC/注册渠道/私有存储/依赖注入）交给插件；开关状态持久化到 `app-settings.json` 的 `plugins` 字段；设置面板新增「功能插件」页，数据由 `plugins:list` / `plugins:set-enabled` 两个 IPC 通道驱动。

**Tech Stack:** TypeScript 5.6 / Electron 43 / Vite 7 / Vitest 4。零新增运行时依赖。插件入口支持 CJS（`.cjs`）与 ESM（`.mjs`），统一经 `import()` 加载。

## Global Constraints

- 分支：所有施工与提交只在本地分支 `liyi-Cyrene-v2` 上进行；不推送远端（除非用户另行要求）。
- 提交规范：每个步骤结束后立即本地提交，message 以 `M<里程碑>-S<步骤>` 开头，例如 `M1-S4 feat(plugins): PluginManager 启停与开关持久化`。
- 施工痕迹：本文档顶部「施工日志」必须随每个步骤更新（时间 / 状态 / commit hash），日志更新以独立 `docs` 提交落库，保证痕迹在文档与 git 历史中同时可见。
- 上游文件改动收敛清单（除下列文件外，不改动任何上游文件）：`src/main/index.ts`（挂载行）、`src/shared/ipc-channels.ts`（追加 2 个常量）、`src/renderer/settings/index.html`（新增导航项与区块）、`src/renderer/settings/settings.ts`（导航标签与渲染逻辑）、`src/main/channels/manager.ts`（追加 unregister/startOne）、`tsconfig.main.json`（include 追加）、`vitest.config.ts`（include 追加）、`package.json`（build:main 追加 manifest 拷贝）、`vite.config.ts`（renderer 页面插件追加入口——由 NovelAI 插件计划扩展，见 2026-08-06-novelai-plugin.md）。
- 测试：TDD，功能先写失败测试再实现；测试用 Vitest（node 环境），`npm test` 全量通过；`npm run build` 全绿。
- 依赖：不新增任何运行时/开发依赖；Node >=24 <25。
- 插件安全边界：`userData/plugins/` 中的插件在主进程执行任意代码，视为完全信任；文档在 M5 明确风险。

---

## 施工日志（Construction Log）

> 规则：每完成一个步骤 → 先提交该步骤的代码/文档 → 再用一条 `docs` 提交把「时间 / 状态 / commit hash」回填到下表。表格初始状态全部为「待执行」。

| 步骤 | 日期时间 | 内容 | 状态 | 提交 |
|---|---|---|---|---|
| M0-S1 | 2026-08-06 | 计划文档创建并落库 | 已完成 | cc96d4f |
| M0-S2 | 2026-08-06 | 基线验证：npm test + build:main 全绿 | 已完成 | 2a8db78 |
| M1-S1 | 2026-08-06 | 插件契约 types.ts + 加载器 loader.ts + 单测（修正测试 fixture 缺入口文件；vitest include 前置追加 src/plugins） | 已完成 | 5fe6cea |
| M1-S2 | 2026-08-06 | 插件存储 storage.ts + 单测 | 已完成 | c00e705 |
| M1-S3 | 2026-08-06 | 插件上下文 context.ts + 单测 | 已完成 | 342f70f |
| M1-S4 | 2026-08-06 | PluginManager manager.ts + 单测（含计划测试缺陷修正） | 已完成 | bb6cf49 |
| M2-S1 | - | IPC 常量 + 构建配置（tsconfig/vitest/package.json） | 待执行 | - |
| M2-S2 | - | GeneralSettings 增加 plugins 字段（默认/归一化） | 待执行 | - |
| M2-S3 | - | index.ts 挂载 PluginManager（initSkills 之后、initChannels 之前） | 待执行 | - |
| M2-S4 | - | preload 暴露 window.plugins + renderer 类型声明 | 待执行 | - |
| M3-S1 | - | 设置面板导航「功能插件」+ 空壳区块 | 待执行 | - |
| M3-S2 | - | 设置面板插件列表渲染与开关 | 待执行 | - |
| M4-S1 | - | ChannelManager 追加 unregister/startOne + 单测 | 待执行 | - |
| M4-S2 | - | 内置 TS 演示插件 src/plugins/demo/ | 待执行 | - |
| M4-S3 | - | drop-in JS 插件端到端验证（放文件即用） | 待执行 | - |
| M5-S1 | 2026-08-06 | docs/plugins/plugin-authoring.md 编写（提前完成） | 已完成 | 4c93439 |
| M5-S2 | - | 全量回归 npm test + npm run build | 待执行 | - |
| M5-S3 | - | 上游合并演练与冲突面收敛核对 | 待执行 | - |
| M5-S4 | - | 施工日志完结 + 风险清单核对 | 待执行 | - |

---

## 1. 背景与目标

Cyrene 已有三套扩展机制可作为插件落点：`toolRegistry`（`src/main/orchestrator/tool-registry.ts`，`register/unregister`）、`channelManager`（`src/main/channels/manager.ts`，`register/startAll`）、`src/main/skills/`（SKILL.md 磁盘扫描）。主进程启动顺序（`src/main/index.ts`）：`initSkills()` @5190 → `initChannels()` @5385 → `initRAG()`/`initMcpManager()` @5694-5704 → `schedulerEngine.start()` @5714。

目标：新增能力（NovelAI、QQ NapCat 等）以插件目录聚合，第三方插件「丢文件即用」；上游基座除下面列出的收敛清单外零改动，可被上游更新安全合并。

非目标（YAGNI）：运行时热重载、插件市场/远程安装、依赖版本解析、插件间依赖图、renderer 页面入口（v1 插件只提供主进程能力；插件窗口留待 v2）。

## 2. 插件契约（完整代码）

### 2.1 `src/plugins/types.ts`（新建）

```ts
import type { ChannelAdapter } from "../main/channels/adapters/base";
import type { ToolDefinition } from "../main/orchestrator/tool-registry";

/** 插件清单：插件目录下必须存在 manifest.json */
export interface PluginManifest {
  /** 唯一 id，小写连字符，如 "novelai" */
  id: string;
  /** 显示名 */
  name: string;
  version: string;
  description: string;
  author: string;
  /** 相对插件目录的入口文件，如 "index.cjs" / "index.mjs" / "index.js" */
  entry: string;
  defaultEnabled: boolean;
  /** 需要注入的主程序内部依赖白名单（v1 仅 "channels"） */
  deps?: Array<"channels">;
}

/** ChannelManager 的结构子集：运行时注入用，插件只允许使用这些方法 */
export interface ChannelManagerLike {
  register(adapter: ChannelAdapter): void;
  unregister(id: string): Promise<boolean>;
  startOne(id: string): Promise<void>;
}

export interface PluginDeps {
  channels?: { channelManager: ChannelManagerLike };
}

export interface PluginStorage {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
  rootDir(): string;
}

export interface PluginContext {
  /** 插件 id（冗余，便于日志与调试） */
  id: string;
  registerTool(tool: ToolDefinition): void;
  unregisterTool(toolId: string): void;
  /** 自动加 plugin:<id>: 前缀 */
  registerIpc(channel: string, handler: (...args: unknown[]) => unknown): void;
  unregisterIpc(channel: string): void;
  registerChannelAdapter(adapter: ChannelAdapter): Promise<void>;
  unregisterChannelAdapter(channelId: string): Promise<void>;
  storage: PluginStorage;
  deps: PluginDeps;
  log(...args: unknown[]): void;
}

export interface CyrenePlugin {
  register(ctx: PluginContext): void | Promise<void>;
  unregister?(): void | Promise<void>;
}

export interface PluginRecord {
  manifest: PluginManifest;
  dir: string;
  enabled: boolean;
}
```

### 2.2 插件文件形态（约定）

```
userData/plugins/<id>/
  manifest.json
  index.cjs        # 推荐 CJS；也支持 index.mjs (ESM) / index.js
  （其他文件）
```

`manifest.json` 最小示例：

```json
{
  "id": "my-plugin",
  "name": "我的插件",
  "version": "1.0.0",
  "description": "一句话描述",
  "author": "你",
  "entry": "index.cjs",
  "defaultEnabled": true
}
```

`index.cjs` 最小示例：

```js
module.exports = {
  register(ctx) {
    ctx.log("插件已启用");
    ctx.registerIpc("ping", () => "pong");
  },
  unregister() {
    ctx.log("插件已禁用");
  },
};
```

内置插件（`src/plugins/` 下用 TS 编写）编译到 `dist/main/plugins/`，与用户插件走同一条加载路径，规则完全一致。

## 3. 文件结构映射

| 文件 | 职责 | 动作 |
|---|---|---|
| `src/plugins/types.ts` | 插件契约 | 新建 |
| `src/plugins/loader.ts` | 扫描目录 / 读 manifest / 动态加载入口 | 新建 |
| `src/plugins/storage.ts` | 插件私有存储（JSON 文件） | 新建 |
| `src/plugins/context.ts` | PluginContext 实现 + dispose 清理 | 新建 |
| `src/plugins/manager.ts` | PluginManager：启停、开关持久化、IPC 列表 | 新建 |
| `src/plugins/**/*.test.ts` | 各模块单测 | 新建 |
| `src/plugins/demo/` | 内置演示插件（manifest + index.ts） | 新建 |
| `src/shared/ipc-channels.ts` | 追加 PLUGINS_LIST / PLUGINS_SET_ENABLED | 修改 |
| `src/main/index.ts` | whenReady 挂载 PluginManager；before-quit stop | 修改 |
| `src/main/channels/manager.ts` | 追加 unregister / startOne | 修改 |
| `src/preload/index.ts` | 暴露 window.plugins | 修改 |
| `src/renderer/settings/index.html` | 导航 + 「功能插件」区块 | 修改 |
| `src/renderer/settings/settings.ts` | NAV_LABELS + 渲染 + 开关 | 修改 |
| `tsconfig.main.json` | include 追加 `src/plugins/**/*.ts` | 修改 |
| `vitest.config.ts` | include 追加 `src/plugins/**/*.test.ts` | 修改 |
| `package.json` | build:main 追加 manifest 拷贝 | 修改 |
| `docs/plugins/plugin-authoring.md` | 插件开发指南 | 新建（M5-S1） |

---

## 任务与步骤

### Task M0-S1: 计划文档落库

**Files:**
- Create: `docs/superpowers/plans/2026-08-06-cyrene-plugin-system.md`（本文档）

**Interfaces:**
- Produces: 施工日志表与提交约定，供全部后续任务使用。

- [ ] **Step 1: 确认分支**

```bash
git branch --show-current
```
Expected: `liyi-Cyrene-v2`

- [ ] **Step 2: 提交计划文档**

```bash
git add docs/superpowers/plans/2026-08-06-cyrene-plugin-system.md
git commit -m "M0-S1 docs(plugins): 插件系统实施计划（插件文件导入即用）"
```

- [ ] **Step 3: 回填施工日志（M0-S1 行：状态=已完成，commit=上一步 hash），并提交日志更新**

```bash
git add docs/superpowers/plans/2026-08-06-cyrene-plugin-system.md
git commit -m "M0-S1 docs(plugins): 施工日志回填 M0-S1"
```

---

### Task M0-S2: 基线验证

**Files:**
- 无代码改动（仅记录验证结果）

**Interfaces:**
- Consumes: 上游 `0de38dd` + `npm ci` 后的依赖树。
- Produces: 基线证据（测试与构建全绿），作为后续任务可随时回归的基准。

- [ ] **Step 1: 跑全量测试**

```bash
npm test
```
Expected: vitest 全量 PASS，无失败。

- [ ] **Step 2: 跑主进程构建**

```bash
npm run build:main
```
Expected: tsc 无类型错误，dist/main 产物生成。

- [ ] **Step 3: 记录结果到施工日志（M0-S2 行），提交**

```bash
git add docs/superpowers/plans/2026-08-06-cyrene-plugin-system.md
git commit -m "M0-S2 docs(plugins): 基线验证通过（test/build:main 全绿）"
```

---

### Task M1-S1: 插件契约与加载器

**Files:**
- Create: `src/plugins/types.ts`
- Create: `src/plugins/loader.ts`
- Test: `src/plugins/loader.test.ts`

**Interfaces:**
- Produces: `readManifest(dir): PluginManifest | null`、`scanPluginDir(root): PluginRecord[]`、`loadPlugin(record): Promise<CyrenePlugin>`。
- Consumed by: M1-S4 `manager.ts`。

- [ ] **Step 1: 写失败测试 `src/plugins/loader.test.ts`**

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadPlugin, readManifest, scanPluginDir } from "./loader";

let tmp: string;

function fixture(rel: string, files: Record<string, string>): string {
  if (!tmp) tmp = mkdtempSync(path.join(os.tmpdir(), "cyrene-plugins-test-"));
  const dir = path.join(tmp, rel);
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), content, "utf8");
  }
  return dir;
}

const validManifest = {
  id: "demo",
  name: "演示",
  version: "1.0.0",
  description: "d",
  author: "a",
  entry: "index.cjs",
  defaultEnabled: true,
};

afterEach(() => {
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = "";
  }
});

describe("readManifest", () => {
  it("读取合法 manifest", () => {
    const dir = fixture("ok", { "manifest.json": JSON.stringify(validManifest) });
    expect(readManifest(dir)).toMatchObject({ id: "demo" });
  });

  it("拒绝非法 id 或缺失入口文件", () => {
    const dir = fixture("bad", {
      "manifest.json": JSON.stringify({ ...validManifest, id: "Bad ID", entry: "nope.js" }),
    });
    expect(readManifest(dir)).toBeNull();
  });

  it("无 manifest 返回 null", () => {
    const dir = fixture("empty", { "readme.txt": "x" });
    expect(readManifest(dir)).toBeNull();
  });
});

describe("scanPluginDir", () => {
  it("只收集带合法 manifest 的一级子目录", () => {
    const root = fixture("root", {});
    fixture("root/ok", { "manifest.json": JSON.stringify(validManifest) });
    fixture("root/bad-json", { "manifest.json": "not json" });
    fixture("root/no-manifest", { "x.txt": "x" });
    expect(scanPluginDir(root).map((r) => r.manifest.id)).toEqual(["demo"]);
  });
});

describe("loadPlugin", () => {
  it("加载 CJS 插件并归一化 register", async () => {
    const dir = fixture("cjs", {
      "manifest.json": JSON.stringify(validManifest),
      "index.cjs": `module.exports = { register(ctx) { ctx.log("hi"); } };`,
    });
    const record = { manifest: readManifest(dir)!, dir, enabled: true };
    const plugin = await loadPlugin(record);
    expect(typeof plugin.register).toBe("function");
  });

  it("入口未导出 register 抛错", async () => {
    const dir = fixture("bad-entry", {
      "manifest.json": JSON.stringify(validManifest),
      "index.cjs": `module.exports = {};`,
    });
    const record = { manifest: readManifest(dir)!, dir, enabled: true };
    await expect(loadPlugin(record)).rejects.toThrow(/register/);
  });
});
```

- [ ] **Step 2: 运行测试，确认失败（模块不存在）**

```bash
npx vitest run src/plugins/loader.test.ts
```
Expected: FAIL，`Cannot find module './loader'`。

- [ ] **Step 3: 实现 `src/plugins/types.ts`（完整代码见 §2.1）**

- [ ] **Step 4: 实现 `src/plugins/loader.ts`**

```ts
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { CyrenePlugin, PluginManifest, PluginRecord } from "./types";

const MANIFEST_FILE = "manifest.json";
const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** 读取并校验 manifest；不合法返回 null（调用方跳过并留痕日志） */
export function readManifest(dir: string): PluginManifest | null {
  const manifestPath = path.join(dir, MANIFEST_FILE);
  if (!existsSync(manifestPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(manifestPath, "utf8")) as PluginManifest;
    if (!raw || typeof raw.id !== "string" || !ID_RE.test(raw.id)) return null;
    if (typeof raw.name !== "string" || !raw.name) return null;
    if (typeof raw.version !== "string" || !raw.version) return null;
    if (typeof raw.description !== "string" || !raw.description) return null;
    if (typeof raw.author !== "string" || !raw.author) return null;
    if (typeof raw.entry !== "string" || !raw.entry) return null;
    if (!existsSync(path.join(dir, raw.entry))) return null;
    return {
      id: raw.id,
      name: raw.name,
      version: raw.version,
      description: raw.description,
      author: raw.author,
      entry: raw.entry,
      defaultEnabled: raw.defaultEnabled !== false,
      deps: raw.deps,
    };
  } catch {
    return null;
  }
}

/** 扫描 root 下所有一级子目录，收集带合法 manifest 的插件 */
export function scanPluginDir(root: string): PluginRecord[] {
  if (!existsSync(root)) return [];
  const out: PluginRecord[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    const manifest = readManifest(dir);
    if (!manifest) {
      console.warn(`[plugins] 忽略无效插件目录: ${dir}`);
      continue;
    }
    out.push({ manifest, dir, enabled: false });
  }
  return out;
}

/** 动态加载插件入口（.cjs/.js/.mjs 均可），归一化 default/named export */
export async function loadPlugin(record: PluginRecord): Promise<CyrenePlugin> {
  const entry = path.join(record.dir, record.manifest.entry);
  const mod = (await import(pathToFileURL(entry).href)) as Record<string, unknown>;
  const plugin = (mod.default ?? mod) as Partial<CyrenePlugin>;
  if (typeof plugin.register !== "function") {
    throw new Error(`插件 ${record.manifest.id} 入口未导出 register()`);
  }
  return plugin as CyrenePlugin;
}
```

- [ ] **Step 5: 运行测试，确认通过**

```bash
npx vitest run src/plugins/loader.test.ts
```
Expected: 7 个用例全 PASS。

- [ ] **Step 6: 提交并回填施工日志（M1-S1）**

```bash
git add src/plugins/types.ts src/plugins/loader.ts src/plugins/loader.test.ts
git commit -m "M1-S1 feat(plugins): 插件契约 types + 加载器 loader（manifest 校验/目录扫描/动态加载）"
git add docs/superpowers/plans/2026-08-06-cyrene-plugin-system.md
git commit -m "M1-S1 docs(plugins): 施工日志回填 M1-S1"
```

---

### Task M1-S2: 插件存储

**Files:**
- Create: `src/plugins/storage.ts`
- Test: `src/plugins/storage.test.ts`

**Interfaces:**
- Produces: `createPluginStorage(rootDir): PluginStorage`。
- Consumed by: M1-S3 `context.ts`。

- [ ] **Step 1: 写失败测试 `src/plugins/storage.test.ts`**

```ts
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
```

- [ ] **Step 2: 运行测试，确认失败**

```bash
npx vitest run src/plugins/storage.test.ts
```

- [ ] **Step 3: 实现 `src/plugins/storage.ts`**

```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { PluginStorage } from "./types";

/** 每个 key 一个 JSON 文件：<rootDir>/<key>.json */
export function createPluginStorage(rootDir: string): PluginStorage {
  mkdirSync(rootDir, { recursive: true });
  const fileFor = (key: string): string => path.join(rootDir, `${key}.json`);
  return {
    get<T>(key: string): T | undefined {
      const p = fileFor(key);
      if (!existsSync(p)) return undefined;
      try {
        return JSON.parse(readFileSync(p, "utf8")) as T;
      } catch {
        return undefined;
      }
    },
    set<T>(key: string, value: T): void {
      writeFileSync(fileFor(key), JSON.stringify(value, null, 2), "utf8");
    },
    rootDir: () => rootDir,
  };
}
```

- [ ] **Step 4: 运行测试，确认通过**

```bash
npx vitest run src/plugins/storage.test.ts
```
Expected: PASS。

- [ ] **Step 5: 提交并回填施工日志（M1-S2）**

```bash
git add src/plugins/storage.ts src/plugins/storage.test.ts
git commit -m "M1-S2 feat(plugins): 插件私有存储 storage（JSON 按 key 落盘）"
git add docs/superpowers/plans/2026-08-06-cyrene-plugin-system.md
git commit -m "M1-S2 docs(plugins): 施工日志回填 M1-S2"
```

---

### Task M1-S3: 插件上下文

**Files:**
- Create: `src/plugins/context.ts`
- Test: `src/plugins/context.test.ts`

**Interfaces:**
- Consumes: M1-S1 `types.ts`、M1-S2 `storage.ts`。
- Produces: `PluginRuntime` 结构、`createContext(id, storageRoot, runtime)`；ctx 的 `registerIpc` 自动加 `plugin:<id>:` 前缀；`dispose()` 统一清理已注册的工具/IPC/渠道。

- [ ] **Step 1: 写失败测试 `src/plugins/context.test.ts`**

```ts
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createContext, type PluginRuntime } from "./context";

let tmp: string;

afterEach(() => {
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = "";
  }
});

function runtime(): PluginRuntime & { tools: string[]; ipc: Map<string, unknown> } {
  const tools: string[] = [];
  const ipc = new Map<string, unknown>();
  return {
    tools,
    ipc,
    toolRegistry: {
      register: (t) => tools.push(t.id),
      unregister: (id) => {
        const i = tools.indexOf(id);
        if (i >= 0) tools.splice(i, 1);
        return true;
      },
    },
    channelManager: { register: () => {}, unregister: async () => true, startOne: async () => {} },
    registerIpc: (c, h) => ipc.set(c, h),
    unregisterIpc: (c) => ipc.delete(c),
    appEvents: { on: () => {} },
  };
}

describe("createContext", () => {
  it("registerIpc 自动加 plugin:<id>: 前缀", () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "cyrene-ctx-test-"));
    const rt = runtime();
    const ctx = createContext("demo", tmp, rt);
    ctx.registerIpc("ping", () => "pong");
    expect(rt.ipc.has("plugin:demo:ping")).toBe(true);
  });

  it("dispose 清理已注册工具与 IPC", () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "cyrene-ctx-test-"));
    const rt = runtime();
    const ctx = createContext("demo", tmp, rt);
    ctx.registerTool({
      id: "demo_tool",
      name: "t",
      description: "d",
      enabled: true,
      inputSchema: { type: "object", properties: {}, required: [] },
      execute: async () => "ok",
    });
    ctx.registerIpc("ping", () => "pong");
    (ctx as unknown as { dispose(): void }).dispose();
    expect(rt.tools).toEqual([]);
    expect(rt.ipc.has("plugin:demo:ping")).toBe(false);
  });

  it("storage 可读写", () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "cyrene-ctx-test-"));
    const ctx = createContext("demo", tmp, runtime());
    ctx.storage.set("k", 1);
    expect(ctx.storage.get<number>("k")).toBe(1);
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

```bash
npx vitest run src/plugins/context.test.ts
```

- [ ] **Step 3: 实现 `src/plugins/context.ts`**

```ts
import type { ChannelAdapter } from "../main/channels/adapters/base";
import type { ToolDefinition } from "../main/orchestrator/tool-registry";
import { createPluginStorage } from "./storage";
import type { ChannelManagerLike, PluginContext, PluginDeps } from "./types";

export interface PluginRuntime {
  toolRegistry: {
    register(tool: ToolDefinition): void;
    unregister(id: string): boolean;
  };
  channelManager: ChannelManagerLike;
  registerIpc: (channel: string, handler: (...args: unknown[]) => unknown) => void;
  unregisterIpc: (channel: string) => void;
  appEvents: {
    on(evt: "before-quit", cb: () => void): void;
  };
}

interface DisposableContext extends PluginContext {
  /** 框架内部：卸载插件时统一清理已注册资源 */
  dispose(): void;
}

export function createContext(
  id: string,
  storageRoot: string,
  runtime: PluginRuntime,
): DisposableContext {
  const registeredTools = new Set<string>();
  const registeredIpc = new Set<string>();
  const registeredAdapters = new Set<string>();
  const beforeQuitCbs: Array<() => void> = [];

  const deps: PluginDeps = {
    channels: { channelManager: runtime.channelManager },
  };

  const ctx: PluginContext = {
    id,
    registerTool(tool: ToolDefinition) {
      runtime.toolRegistry.register(tool);
      registeredTools.add(tool.id);
    },
    unregisterTool(toolId: string) {
      runtime.toolRegistry.unregister(toolId);
      registeredTools.delete(toolId);
    },
    registerIpc(channel: string, handler: (...args: unknown[]) => unknown) {
      const full = `plugin:${id}:${channel}`;
      runtime.registerIpc(full, handler);
      registeredIpc.add(full);
    },
    unregisterIpc(channel: string) {
      const full = `plugin:${id}:${channel}`;
      runtime.unregisterIpc(full);
      registeredIpc.delete(full);
    },
    async registerChannelAdapter(adapter: ChannelAdapter) {
      runtime.channelManager.register(adapter);
      await runtime.channelManager.startOne(adapter.id);
      registeredAdapters.add(adapter.id);
    },
    async unregisterChannelAdapter(channelId: string) {
      await runtime.channelManager.unregister(channelId);
      registeredAdapters.delete(channelId);
    },
    storage: createPluginStorage(storageRoot),
    deps,
    log(...args: unknown[]) {
      console.log(`[plugin:${id}]`, ...args);
    },
  };

  runtime.appEvents.on("before-quit", () => {
    for (const cb of beforeQuitCbs) cb();
  });

  return Object.assign(ctx, {
    dispose() {
      for (const toolId of registeredTools) runtime.toolRegistry.unregister(toolId);
      registeredTools.clear();
      for (const channel of registeredIpc) runtime.unregisterIpc(channel);
      registeredIpc.clear();
      for (const adapterId of registeredAdapters) {
        void runtime.channelManager.unregister(adapterId);
      }
      registeredAdapters.clear();
    },
  });
}
```

- [ ] **Step 4: 运行测试，确认通过**

```bash
npx vitest run src/plugins/context.test.ts
```
Expected: 3 个用例 PASS。

- [ ] **Step 5: 提交并回填施工日志（M1-S3）**

```bash
git add src/plugins/context.ts src/plugins/context.test.ts
git commit -m "M1-S3 feat(plugins): 插件上下文 context（IPC 前缀/工具注册/dispose 清理）"
git add docs/superpowers/plans/2026-08-06-cyrene-plugin-system.md
git commit -m "M1-S3 docs(plugins): 施工日志回填 M1-S3"
```

---

### Task M1-S4: PluginManager

**Files:**
- Create: `src/plugins/manager.ts`
- Test: `src/plugins/manager.test.ts`

**Interfaces:**
- Consumes: M1-S1 `loader.ts`、M1-S3 `context.ts`/`PluginRuntime`。
- Produces: `PluginManagerOptions`、`PluginListEntry`、`PluginManager`（`start()/stop()/list()/setEnabled()`）；IPC 通道 `plugins:list` / `plugins:set-enabled`。
- Consumed by: M2-S3 `src/main/index.ts` 挂载。

- [ ] **Step 1: 写失败测试 `src/plugins/manager.test.ts`**

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PluginManager, type PluginManagerOptions } from "./manager";
import type { PluginRuntime } from "./context";

let tmp: string;

function fixturePlugin(id: string, manifestId: string = id): string {
  if (!tmp) tmp = mkdtempSync(path.join(os.tmpdir(), "cyrene-mgr-test-"));
  const dir = path.join(tmp, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify({
      id: manifestId,
      name: id,
      version: "1.0.0",
      description: "d",
      author: "a",
      entry: "index.cjs",
      defaultEnabled: true,
    }),
    "utf8",
  );
  writeFileSync(
    path.join(dir, "index.cjs"),
    `module.exports = { register(ctx) {
      ctx.registerIpc("ping", () => "pong");
      ctx.registerTool({ id: "${id}_tool", name: "t", description: "d", enabled: true, inputSchema: { type: "object", properties: {}, required: [] }, execute: async () => "ok" });
    }, unregister() {} };`,
    "utf8",
  );
  return dir;
}

afterEach(() => {
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = "";
  }
});

function harness(overrides: Partial<PluginManagerOptions> = {}) {
  const tools: string[] = [];
  const ipc = new Map<string, (...args: unknown[]) => unknown>();
  const runtime: PluginRuntime = {
    toolRegistry: {
      register: (t) => tools.push(t.id),
      unregister: (id) => {
        const i = tools.indexOf(id);
        if (i >= 0) tools.splice(i, 1);
        return true;
      },
    },
    channelManager: { register: () => {}, unregister: async () => true, startOne: async () => {} },
    registerIpc: (c, h) => ipc.set(c, h),
    unregisterIpc: (c) => ipc.delete(c),
    appEvents: { on: () => {} },
  };
  let enabledMap: Record<string, boolean> = {};
  const options: PluginManagerOptions = {
    scanRoots: [path.dirname(fixturePlugin("demo"))],
    storageRoot: path.join(tmp ?? "tmp", "storage"),
    runtime,
    loadEnabledMap: () => ({ ...enabledMap }),
    saveEnabledMap: (m) => {
      enabledMap = { ...m };
    },
    ...overrides,
  };
  return { options, tools, ipc, getEnabledMap: () => ({ ...enabledMap }) };
}

describe("PluginManager", () => {
  it("启动时启用 defaultEnabled 插件并注册列表/开关 IPC", async () => {
    const h = harness();
    const mgr = new PluginManager(h.options);
    await mgr.start();
    expect(mgr.list().map((e) => e.id)).toEqual(["demo"]);
    expect(mgr.list()[0].enabled).toBe(true);
    expect(h.ipc.has("plugins:list")).toBe(true);
    expect(h.ipc.has("plugins:set-enabled")).toBe(true);
    expect(h.ipc.has("plugin:demo:ping")).toBe(true);
  });

  it("开关关闭的插件不激活", async () => {
    const h = harness({
      loadEnabledMap: () => ({ demo: false }),
    });
    const mgr = new PluginManager(h.options);
    await mgr.start();
    expect(mgr.list()[0].enabled).toBe(false);
    expect(h.ipc.has("plugin:demo:ping")).toBe(false);
  });

  it("setEnabled(false) 清理资源并持久化；setEnabled(true) 重新激活", async () => {
    const h = harness();
    const mgr = new PluginManager(h.options);
    await mgr.start();
    expect(h.tools).toContain("demo_tool");

    const off = await mgr.setEnabled("demo", false);
    expect(off.ok).toBe(true);
    expect(mgr.list()[0].enabled).toBe(false);
    expect(h.ipc.has("plugin:demo:ping")).toBe(false);
    expect(h.tools).toEqual([]);
    expect(h.getEnabledMap().demo).toBe(false);

    const on = await mgr.setEnabled("demo", true);
    expect(on.ok).toBe(true);
    expect(h.ipc.has("plugin:demo:ping")).toBe(true);
    expect(h.tools).toContain("demo_tool");
  });

  it("重复 id 只保留第一个扫描结果", async () => {
    const h = harness();
    fixturePlugin("demo-copy", "demo");
    h.options.scanRoots = [path.dirname(fixturePlugin("demo"))];
    const mgr = new PluginManager(h.options);
    await mgr.start();
    expect(mgr.list()).toHaveLength(1);
  });

  it("setEnabled 未知 id 返回失败", async () => {
    const h = harness();
    const mgr = new PluginManager(h.options);
    await mgr.start();
    const res = await mgr.setEnabled("nope", true);
    expect(res.ok).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

```bash
npx vitest run src/plugins/manager.test.ts
```

- [ ] **Step 3: 实现 `src/plugins/manager.ts`**

```ts
import path from "node:path";
import { createContext, type PluginRuntime } from "./context";
import { loadPlugin, scanPluginDir } from "./loader";
import type { CyrenePlugin, PluginContext, PluginRecord } from "./types";

export interface PluginListEntry {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  entry: string;
  defaultEnabled: boolean;
  enabled: boolean;
  hasUnregister: boolean;
}

export interface PluginManagerOptions {
  /** 插件扫描根目录（内置 + 用户目录） */
  scanRoots: string[];
  /** 插件私有存储根目录（userData/plugins） */
  storageRoot: string;
  runtime: PluginRuntime;
  loadEnabledMap: () => Record<string, boolean>;
  saveEnabledMap: (map: Record<string, boolean>) => void;
  /** 列表/开关变化后回调（设置面板刷新用，可空） */
  onListChanged?: () => void;
}

const IPC_LIST = "plugins:list";
const IPC_SET_ENABLED = "plugins:set-enabled";

type DisposableContext = PluginContext & { dispose(): void };

export class PluginManager {
  private records = new Map<string, PluginRecord>();
  private instances = new Map<string, CyrenePlugin>();
  private contexts = new Map<string, DisposableContext>();
  private enabledMap: Record<string, boolean>;

  constructor(private opts: PluginManagerOptions) {
    this.enabledMap = opts.loadEnabledMap() ?? {};
  }

  list(): PluginListEntry[] {
    return Array.from(this.records.values()).map((r) => {
      const plugin = this.instances.get(r.manifest.id);
      return {
        id: r.manifest.id,
        name: r.manifest.name,
        version: r.manifest.version,
        description: r.manifest.description,
        author: r.manifest.author,
        entry: r.manifest.entry,
        defaultEnabled: r.manifest.defaultEnabled,
        enabled: this.enabledMap[r.manifest.id] ?? r.manifest.defaultEnabled,
        hasUnregister: typeof plugin?.unregister === "function",
      };
    });
  }

  async start(): Promise<void> {
    for (const root of this.opts.scanRoots) {
      for (const record of scanPluginDir(root)) {
        if (this.records.has(record.manifest.id)) {
          console.warn(`[plugins] 插件 id 重复，忽略 ${record.dir}`);
          continue;
        }
        this.records.set(record.manifest.id, record);
      }
    }
    for (const [id] of this.records) {
      const enabled = this.enabledMap[id] ?? this.records.get(id)!.manifest.defaultEnabled;
      if (!enabled) continue;
      try {
        await this.activate(id);
      } catch (err) {
        console.error(`[plugins] 插件 ${id} 启用失败，跳过`, err);
      }
    }
    this.opts.runtime.registerIpc(IPC_LIST, () => this.list());
    this.opts.runtime.registerIpc(IPC_SET_ENABLED, async (id: string, enabled: boolean) => {
      return this.setEnabled(id, enabled);
    });
    this.opts.onListChanged?.();
  }

  async setEnabled(
    id: string,
    enabled: boolean,
  ): Promise<{ ok: boolean; error?: string }> {
    const record = this.records.get(id);
    if (!record) return { ok: false, error: `插件不存在: ${id}` };
    const current = this.enabledMap[id] ?? record.manifest.defaultEnabled;
    if (current === enabled) return { ok: true };
    try {
      if (enabled) await this.activate(id);
      else await this.deactivate(id);
      this.enabledMap[id] = enabled;
      this.opts.saveEnabledMap({ ...this.enabledMap });
      this.opts.onListChanged?.();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async stop(): Promise<void> {
    for (const id of Array.from(this.instances.keys())) {
      await this.deactivate(id);
    }
  }

  private async activate(id: string): Promise<void> {
    const record = this.records.get(id);
    if (!record || this.instances.has(id)) return;
    const plugin = await loadPlugin(record);
    const ctx = createContext(id, path.join(this.opts.storageRoot, id), this.opts.runtime);
    await plugin.register(ctx);
    this.instances.set(id, plugin);
    this.contexts.set(id, ctx);
    console.log(`[plugins] 已启用 ${id}@${record.manifest.version}`);
  }

  private async deactivate(id: string): Promise<void> {
    const plugin = this.instances.get(id);
    if (plugin?.unregister) await plugin.unregister();
    this.contexts.get(id)?.dispose();
    this.instances.delete(id);
    this.contexts.delete(id);
    console.log(`[plugins] 已禁用 ${id}`);
  }
}
```

- [ ] **Step 4: 运行测试，确认通过**

```bash
npx vitest run src/plugins/manager.test.ts
```
Expected: 5 个用例 PASS。

- [ ] **Step 5: 提交并回填施工日志（M1-S4）**

```bash
git add src/plugins/manager.ts src/plugins/manager.test.ts
git commit -m "M1-S4 feat(plugins): PluginManager（扫描/启停/开关持久化/plugins:list IPC）"
git add docs/superpowers/plans/2026-08-06-cyrene-plugin-system.md
git commit -m "M1-S4 docs(plugins): 施工日志回填 M1-S4"
```

---

### Task M2-S1: IPC 常量与构建配置

**Files:**
- Modify: `src/shared/ipc-channels.ts`（IPC 常量区末尾追加）
- Modify: `tsconfig.main.json`（include）
- Modify: `vitest.config.ts`（include）
- Modify: `package.json`（build:main）

**Interfaces:**
- Produces: `IPC.PLUGINS_LIST` / `IPC.PLUGINS_SET_ENABLED` 常量；`src/plugins/**/*.ts` 参与 tsc 与 vitest；`dist/main/plugins/**/manifest.json` 随构建拷贝。

- [ ] **Step 1: 追加 IPC 常量（`src/shared/ipc-channels.ts`，`export const IPC = {` 内末尾）**

```ts
  // plugin system
  PLUGINS_LIST: "plugins:list",
  PLUGINS_SET_ENABLED: "plugins:set-enabled",
```

- [ ] **Step 2: `tsconfig.main.json` include 追加 `src/plugins/**/*.ts`**

```json
"include": ["src/plugins/**/*.ts", "src/main/**/*.ts", "src/shared/**/*.ts"]
```

- [ ] **Step 3: `vitest.config.ts` include 追加 `src/plugins/**/*.test.ts`**

```ts
include: [
  "src/plugins/**/*.test.ts",
  "src/main/**/*.test.ts",
  "src/renderer/**/*.test.ts",
  "src/shared/**/*.test.ts",
  "src/cli/**/*.test.ts",
  "skills/**/tests/**/*.test.ts",
  "scripts/cline-poc/**/*.test.ts",
]
```

- [ ] **Step 4: `package.json` 的 build:main 追加 manifest 拷贝（保留原有 cline bridge 拷贝）**

```json
"build:main": "tsc -p tsconfig.main.json && node -e \"require('fs').cpSync('src/main/orchestrator/code/cline-esm-bridge.mjs','dist/main/main/orchestrator/code/cline-esm-bridge.mjs')\" && node -e \"const fs=require('fs');fs.cpSync('src/plugins','dist/main/plugins',{recursive:true,filter:s=>fs.statSync(s).isDirectory()||s.endsWith('manifest.json')})\""
```

- [ ] **Step 5: 验证构建配置**

```bash
npm run build:main
```
Expected: tsc 通过，`dist/main/plugins/` 生成（此时无 manifest 也会生成空骨架目录），无报错。

- [ ] **Step 6: 提交并回填施工日志（M2-S1）**

```bash
git add src/shared/ipc-channels.ts tsconfig.main.json vitest.config.ts package.json package-lock.json
git commit -m "M2-S1 feat(plugins): IPC 常量 + 构建配置（tsconfig/vitest/build:main manifest 拷贝）"
git add docs/superpowers/plans/2026-08-06-cyrene-plugin-system.md
git commit -m "M2-S1 docs(plugins): 施工日志回填 M2-S1"
```

---

### Task M2-S2: GeneralSettings 增加 plugins 字段

**Files:**
- Modify: `src/main/index.ts`（`interface GeneralSettings` @680、默认值对象 @~946、`loadGeneralSettings0` 归一化 @~1441、返回对象 @~1545）

**Interfaces:**
- Produces: `GeneralSettings.plugins: Record<string, boolean>`，默认 `{}`，读写走现有 `loadGeneralSettings/saveGeneralSettings`（`app-settings.json`）。

- [ ] **Step 1: `interface GeneralSettings`（index.ts @680）追加字段**

```ts
  /** 插件开关表：pluginId -> enabled */
  plugins: Record<string, boolean>;
```

- [ ] **Step 2: 默认值对象（`petVisible: true` 附近 @~946）追加**

```ts
  plugins: {},
```

- [ ] **Step 3: 新增归一化函数（放在 `loadGeneralSettings0` 之前）并接入 load 逻辑**

```ts
function normalizePluginsEnabled(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === "boolean") out[k] = v;
  }
  return out;
}
```

在 `loadGeneralSettings0()` 内读取原始对象后追加：

```ts
  const plugins = normalizePluginsEnabled(input?.plugins);
```

并在组装返回对象时加入：

```ts
    plugins,
```

- [ ] **Step 4: 验证**

```bash
npm run build:main
```
Expected: tsc 通过。

- [ ] **Step 5: 提交并回填施工日志（M2-S2）**

```bash
git add src/main/index.ts
git commit -m "M2-S2 feat(plugins): GeneralSettings 增加 plugins 开关字段（默认/归一化）"
git add docs/superpowers/plans/2026-08-06-cyrene-plugin-system.md
git commit -m "M2-S2 docs(plugins): 施工日志回填 M2-S2"
```

---

### Task M2-S3: index.ts 挂载 PluginManager

**Files:**
- Modify: `src/main/index.ts`（import、模块级变量、whenReady 内 `initSkills()` @5190 之后、`initChannels()` @5385 之前、before-quit）

**Interfaces:**
- Consumes: M1-S4 `PluginManager`、M2-S1 常量、M2-S2 `GeneralSettings.plugins`。
- Produces: 应用启动即加载插件；退出前 `pluginManager.stop()`。

- [ ] **Step 1: 顶部 import 追加**

```ts
import { PluginManager } from "../plugins/manager";
```

- [ ] **Step 2: 模块级变量（`let mainWindow` 声明区附近）**

```ts
let pluginManager: PluginManager | null = null;
```

- [ ] **Step 3: whenReady 流程中 `initSkills()` 之后、`initChannels()` 之前插入**

```ts
    pluginManager = new PluginManager({
      scanRoots: [
        path.join(__dirname, "..", "plugins"),
        path.join(app.getPath("userData"), "plugins"),
      ],
      storageRoot: path.join(app.getPath("userData"), "plugins"),
      runtime: {
        toolRegistry,
        channelManager,
        registerIpc: (channel, handler) => {
          ipcMain.handle(channel, (_event, ...args: unknown[]) => handler(...args));
        },
        unregisterIpc: (channel) => {
          ipcMain.removeHandler(channel);
        },
        appEvents: { on: (evt, cb) => app.on(evt, cb) },
      },
      loadEnabledMap: () => loadGeneralSettings().plugins,
      saveEnabledMap: (map) => {
        saveGeneralSettings({ plugins: map });
      },
    });
    await pluginManager.start();
```

> 注意：确认 `toolRegistry` 与 `channelManager` 单例已在 index.ts 可访问（`tool-registry.ts` 导出 `toolRegistry`，`channels/manager.ts` 导出 `channelManager`；若 index.ts 未 import 则补 import）。

- [ ] **Step 4: before-quit 处追加（若已有 `app.on("before-quit")` 则在其中追加一行）**

```ts
    void pluginManager?.stop();
```

- [ ] **Step 5: 验证**

```bash
npm run build:main
```
Expected: tsc 通过，无类型错误。

- [ ] **Step 6: 提交并回填施工日志（M2-S3）**

```bash
git add src/main/index.ts
git commit -m "M2-S3 feat(plugins): index.ts 挂载 PluginManager（initSkills 之后 / initChannels 之前）"
git add docs/superpowers/plans/2026-08-06-cyrene-plugin-system.md
git commit -m "M2-S3 docs(plugins): 施工日志回填 M2-S3"
```

---

### Task M2-S4: preload 暴露 window.plugins

**Files:**
- Modify: `src/preload/index.ts`（新增 pluginsApi + exposeInMainWorld，参照 settingsApi @376 的写法）
- Modify: `src/renderer/settings/settings.ts`（`interface Window` @521 追加声明）

**Interfaces:**
- Produces: `window.plugins.list(): Promise<PluginListEntry[]>`、`window.plugins.setEnabled(id, enabled): Promise<{ok, error?}>`。
- Consumed by: M3-S2 设置面板。

- [ ] **Step 1: preload 新增 pluginsApi**

```ts
const pluginsApi = {
  list: () => ipcRenderer.invoke(IPC.PLUGINS_LIST),
  setEnabled: (id: string, enabled: boolean) =>
    ipcRenderer.invoke(IPC.PLUGINS_SET_ENABLED, id, enabled),
};
```

- [ ] **Step 2: preload 暴露（settingsApi 的 expose 附近）**

```ts
contextBridge.exposeInMainWorld("plugins", pluginsApi);
```

- [ ] **Step 3: settings.ts `interface Window`（@521）追加类型**

```ts
    plugins: {
      list(): Promise<
        Array<{
          id: string;
          name: string;
          version: string;
          description: string;
          author: string;
          entry: string;
          defaultEnabled: boolean;
          enabled: boolean;
          hasUnregister: boolean;
        }>
      >;
      setEnabled(id: string, enabled: boolean): Promise<{ ok: boolean; error?: string }>;
    };
```

- [ ] **Step 4: 验证**

```bash
npm run build:main && npm run build:renderer
```
Expected: 均通过。

- [ ] **Step 5: 提交并回填施工日志（M2-S4）**

```bash
git add src/preload/index.ts src/renderer/settings/settings.ts
git commit -m "M2-S4 feat(plugins): preload 暴露 window.plugins（list/setEnabled）"
git add docs/superpowers/plans/2026-08-06-cyrene-plugin-system.md
git commit -m "M2-S4 docs(plugins): 施工日志回填 M2-S4"
```

---

### Task M3-S1: 设置面板「功能插件」导航与区块

**Files:**
- Modify: `src/renderer/settings/index.html`（导航区 @~26 追加按钮；plugins-panel 区块后追加区块）

**Interfaces:**
- Produces: `data-section="feature-plugins"` 导航项 + `<section id="feature-plugins-panel" hidden>` 容器 `<div id="feature-plugins-list">`。

- [ ] **Step 1: 导航区（`data-section="plugins"` 按钮之后）追加**

```html
<button type="button" class="nav-item" data-section="feature-plugins"><span><svg class="nav-item__icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg></span>功能插件</button>
```

- [ ] **Step 2: 在 MCP 插件区块（`plugins-panel`）之后追加区块**

```html
<section class="settings-section" id="feature-plugins-panel" hidden>
  <div class="settings-section__heading">
    <h2>功能插件</h2>
    <p>插件以「目录 + manifest.json + 入口文件」放在 userData/plugins/ 下，启动时自动加载。</p>
  </div>
  <div id="feature-plugins-list" class="settings-list"></div>
</section>
```

> 区块外层结构若与现有 section 包装不同，以 `plugins-panel` 所在父容器结构为准调整 class。

- [ ] **Step 3: 提交并回填施工日志（M3-S1）**

```bash
git add src/renderer/settings/index.html
git commit -m "M3-S1 feat(plugins): 设置面板新增「功能插件」导航与空壳区块"
git add docs/superpowers/plans/2026-08-06-cyrene-plugin-system.md
git commit -m "M3-S1 docs(plugins): 施工日志回填 M3-S1"
```

---

### Task M3-S2: 设置面板渲染与开关

**Files:**
- Modify: `src/renderer/settings/settings.ts`（NAV_LABELS @926、面板元素引用区、渲染函数、导航切换触发）

**Interfaces:**
- Consumes: M2-S4 `window.plugins`、M3-S1 区块。
- Produces: 面板打开时渲染插件卡片（名称/版本/描述/作者/开关/打开按钮预留），开关失败回滚。

- [ ] **Step 1: NAV_LABELS（@926）追加**

```ts
  "feature-plugins": {
    emoji: "🧩",
    title: "功能插件",
    hint: "启用/停用本地插件",
  },
```

- [ ] **Step 2: 面板元素引用（`pluginsPanel` 引用附近）**

```ts
const featurePluginsPanel = document.getElementById("feature-plugins-panel") as HTMLElement;
const featurePluginsList = document.getElementById("feature-plugins-list") as HTMLElement;
```

- [ ] **Step 3: 新增渲染函数（放在其他 render 函数附近）**

```ts
async function renderFeaturePlugins(): Promise<void> {
  if (!featurePluginsList) return;
  const items = await window.plugins?.list();
  if (!items) return;
  featurePluginsList.replaceChildren();
  for (const item of items) {
    const row = document.createElement("div");
    row.className = "setting-row";
    const info = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = `${item.name} v${item.version}`;
    const desc = document.createElement("span");
    desc.textContent = `${item.description}（${item.author}）`;
    info.append(name, desc);
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = item.enabled ? "save-btn" : "save-btn save-btn--ghost";
    toggle.textContent = item.enabled ? "已启用" : "已停用";
    toggle.addEventListener("click", async () => {
      const res = await window.plugins?.setEnabled(item.id, !item.enabled);
      if (!res?.ok) {
        console.error("[settings] 切换插件失败", item.id, res?.error);
      }
      await renderFeaturePlugins();
    });
    row.append(info, toggle);
    featurePluginsList.appendChild(row);
  }
}
```

- [ ] **Step 4: 挂载渲染触发（导航点击/切换 section 的统一处理处 @~3397，与其它面板同位置）**

```ts
  if (section === "feature-plugins") {
    void renderFeaturePlugins();
  }
```

- [ ] **Step 5: 验证**

```bash
npm run build:renderer
```
Expected: vite 构建通过。

- [ ] **Step 6: 提交并回填施工日志（M3-S2）**

```bash
git add src/renderer/settings/settings.ts
git commit -m "M3-S2 feat(plugins): 设置面板插件列表渲染与开关（失败回滚重绘）"
git add docs/superpowers/plans/2026-08-06-cyrene-plugin-system.md
git commit -m "M3-S2 docs(plugins): 施工日志回填 M3-S2"
```

---

### Task M4-S1: ChannelManager 追加 unregister / startOne

**Files:**
- Modify: `src/main/channels/manager.ts`（`startAll` 之后追加）
- Test: `src/main/channels/manager.test.ts`（新建）

**Interfaces:**
- Produces: `channelManager.unregister(id): Promise<boolean>`（停用并移除）、`channelManager.startOne(id): Promise<void>`（运行时启用单个渠道）。
- Consumed by: M1-S3 `context.ts` 的渠道注册/注销。

- [ ] **Step 1: 写失败测试 `src/main/channels/manager.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { ChannelManager } from "./manager";
import type { ChannelAdapter } from "./adapters/base";

function fakeAdapter(id: string): ChannelAdapter {
  let started = false;
  return {
    id: id as never,
    displayName: id,
    capability: {} as never,
    onMessage: null,
    start: async () => {
      started = true;
    },
    stop: async () => {
      started = false;
    },
    send: async () => ({ ok: true }),
    getStatus: () => ({ started }),
  };
}

describe("ChannelManager", () => {
  it("startOne 启动单个 adapter；unregister 先 stop 再移除", async () => {
    const mgr = new ChannelManager();
    const adapter = fakeAdapter("qq");
    mgr.register(adapter);
    await mgr.startOne("qq" as never);
    expect(mgr.getAdapter("qq" as never)).toBeDefined();
    expect(adapter.getStatus().started).toBe(true);

    const removed = await mgr.unregister("qq" as never);
    expect(removed).toBe(true);
    expect(mgr.getAdapter("qq" as never)).toBeUndefined();
    expect(adapter.getStatus().started).toBe(false);
  });

  it("unregister 不存在的 id 返回 false", async () => {
    const mgr = new ChannelManager();
    expect(await mgr.unregister("nope" as never)).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

```bash
npx vitest run src/main/channels/manager.test.ts
```

- [ ] **Step 3: 实现（`startAll` 之后追加两个方法）**

```ts
  /** 注销 adapter：若已启动先 stop，再移除（运行时禁用插件渠道用） */
  async unregister(id: ChannelId): Promise<boolean> {
    const adapter = this.adapters.get(id);
    if (!adapter) return false;
    if (this.startedAdapters.has(id)) {
      try {
        await adapter.stop();
      } catch (err) {
        console.warn(LOG, `渠道停止失败 [${id}]:`, err instanceof Error ? err.message : err);
      }
      this.startedAdapters.delete(id);
    }
    this.adapters.delete(id);
    logger.info(LogTag.Channels, `unregistered: ${id}`);
    return true;
  }

  /** 启动单个 adapter（运行时启用插件渠道用） */
  async startOne(id: ChannelId): Promise<void> {
    const adapter = this.adapters.get(id);
    if (!adapter) return;
    if (this.dispatchFn) {
      setAdapterHandler(adapter, this.makeAdapterHandler(id));
    }
    await adapter.start();
    this.startedAdapters.add(id);
    logger.info(LogTag.Channels, `started: ${id} (${adapter.displayName})`);
  }
```

- [ ] **Step 4: 运行测试，确认通过**

```bash
npx vitest run src/main/channels/manager.test.ts
```
Expected: 2 个用例 PASS。

- [ ] **Step 5: 提交并回填施工日志（M4-S1）**

```bash
git add src/main/channels/manager.ts src/main/channels/manager.test.ts
git commit -m "M4-S1 feat(channels): ChannelManager 追加 unregister/startOne（插件渠道启停）"
git add docs/superpowers/plans/2026-08-06-cyrene-plugin-system.md
git commit -m "M4-S1 docs(plugins): 施工日志回填 M4-S1"
```

---

### Task M4-S2: 内置 TS 演示插件

**Files:**
- Create: `src/plugins/demo/manifest.json`
- Create: `src/plugins/demo/index.ts`

**Interfaces:**
- Consumes: M1-S1 契约。
- Produces: 内置插件 `demo`（注册工具 `demo_hello` + IPC `plugin:demo:ping`），用于验证构建产物被 PluginManager 正常加载。

- [ ] **Step 1: 写 manifest（`src/plugins/demo/manifest.json`）**

```json
{
  "id": "demo",
  "name": "演示插件",
  "version": "0.1.0",
  "description": "插件系统演示：注册一个工具与一个 IPC 通道",
  "author": "liyi",
  "entry": "index.js",
  "defaultEnabled": true
}
```

- [ ] **Step 2: 写入口（`src/plugins/demo/index.ts`）**

```ts
import type { CyrenePlugin } from "../types";

export const demoPlugin: CyrenePlugin = {
  register(ctx) {
    ctx.registerTool({
      id: "demo_hello",
      name: "演示问候",
      description: "返回一句来自演示插件的问候语",
      enabled: true,
      inputSchema: { type: "object", properties: {}, required: [] },
      execute: async () => "来自演示插件的问候 👋",
    });
    ctx.registerIpc("ping", () => "pong");
    ctx.log("演示插件已注册");
  },
  unregister() {
    console.log("[plugin:demo] 演示插件已卸载");
  },
};

export default demoPlugin;
```

- [ ] **Step 3: 构建并核对产物**

```bash
npm run build:main
```
Expected: `dist/main/plugins/demo/index.js` 与 `dist/main/plugins/demo/manifest.json` 均存在。

- [ ] **Step 4: 提交并回填施工日志（M4-S2）**

```bash
git add src/plugins/demo/manifest.json src/plugins/demo/index.ts
git commit -m "M4-S2 feat(plugins): 内置演示插件 demo（工具 + IPC 通道）"
git add docs/superpowers/plans/2026-08-06-cyrene-plugin-system.md
git commit -m "M4-S2 docs(plugins): 施工日志回填 M4-S2"
```

---

### Task M4-S3: drop-in JS 插件端到端验证

**Files:**
- Create（运行时验证用，不入库）: `userData/plugins/demo-dropin/manifest.json` + `index.cjs`
- 可选: `scripts/verify-plugins.mjs`（一次性验证脚本，入库）

**Interfaces:**
- Consumes: M1-M2 全部框架 + M3 设置面板。
- Produces: 「放文件即用」端到端证据：`plugins:list` 出现 demo-dropin，启用后工具/IPC 生效。

- [ ] **Step 1: 创建 drop-in 插件文件（`%APPDATA%/live2d-cyrene/plugins/demo-dropin/`）**

`manifest.json`：

```json
{
  "id": "demo-dropin",
  "name": "Drop-in 示例",
  "version": "0.1.0",
  "description": "不编译，直接放目录即被加载的插件",
  "author": "liyi",
  "entry": "index.cjs",
  "defaultEnabled": true
}
```

`index.cjs`：

```js
module.exports = {
  register(ctx) {
    ctx.log("drop-in 插件已启用");
    ctx.registerIpc("hello", () => "hi from drop-in plugin");
    ctx.registerTool({
      id: "demo_dropin_echo",
      name: "回显",
      description: "原样返回输入文本",
      enabled: true,
      inputSchema: {
        type: "object",
        properties: { text: { type: "string", description: "需要回显的文本" } },
        required: ["text"],
      },
      execute: async (args) => String(args.text ?? ""),
    });
  },
};
```

- [ ] **Step 2: 启动应用做端到端验证**

```bash
npm run build && node dist/cli/index.js run
```

Expected:
- 控制台出现 `[plugins] 已启用 demo`、`[plugins] 已启用 demo-dropin` 日志；
- 设置面板新增「功能插件」页，列出 demo 与 demo-dropin 两条记录；
- 切换开关可启用/停用，UI 状态随动；
- （可选）在聊天中调用工具 `demo_dropin_echo` 验证 LLM 侧可见。

- [ ] **Step 3: 提交并回填施工日志（M4-S3）**

```bash
git add docs/superpowers/plans/2026-08-06-cyrene-plugin-system.md
git commit -m "M4-S3 docs(plugins): drop-in 插件端到端验证通过"
```

---

### Task M5-S1: 插件开发指南

**Files:**
- Create: `docs/plugins/plugin-authoring.md`

**Interfaces:**
- Produces: 第三方插件作者文档（manifest 字段、入口约定、ctx API、示例）。

- [ ] **Step 1: 编写 `docs/plugins/plugin-authoring.md`**（内容：§2 契约、目录结构、CJS/ESM 两种写法示例、可用能力清单 Tool/IPC/Channel、安全边界声明）

- [ ] **Step 2: 提交并回填施工日志（M5-S1）**

```bash
git add docs/plugins/plugin-authoring.md
git commit -m "M5-S1 docs(plugins): 插件开发指南 plugin-authoring.md"
git add docs/superpowers/plans/2026-08-06-cyrene-plugin-system.md
git commit -m "M5-S1 docs(plugins): 施工日志回填 M5-S1"
```

---

### Task M5-S2: 全量回归与构建

**Files:**
- 无新增文件。

- [ ] **Step 1: 全量测试**

```bash
npm test
```
Expected: 全部 PASS（含新增 src/plugins 与 channels 测试）。

- [ ] **Step 2: 全量构建**

```bash
npm run build
```
Expected: skills/main/preload/cli/renderer 全绿。

- [ ] **Step 3: 提交并回填施工日志（M5-S2）**

```bash
git add docs/superpowers/plans/2026-08-06-cyrene-plugin-system.md
git commit -m "M5-S2 docs(plugins): 全量回归通过（test/build 全绿）"
```

---

### Task M5-S3: 上游合并演练

**Files:**
- 无代码改动。

- [ ] **Step 1: 拉取上游最新并对比基线**

```bash
git fetch origin
git merge-base --is-ancestor origin/master HEAD && echo "master 是当前分支祖先（可安全合并）"
```

- [ ] **Step 2: 核对冲突面收敛清单**（以下文件允许与上游冲突，其余上游文件不应出现冲突）

```text
src/main/index.ts
src/shared/ipc-channels.ts
src/main/channels/manager.ts
src/renderer/settings/index.html
src/renderer/settings/settings.ts
tsconfig.main.json
vitest.config.ts
package.json
```

- [ ] **Step 3: 提交并回填施工日志（M5-S3）**

```bash
git add docs/superpowers/plans/2026-08-06-cyrene-plugin-system.md
git commit -m "M5-S3 docs(plugins): 上游合并演练完成，冲突面收敛在清单内"
```

---

### Task M5-S4: 施工日志完结与风险核对

**Files:**
- Modify: 本文档（全部施工日志行回填完成）

- [ ] **Step 1: 核对施工日志表**——每个 M0-M5 步骤都有「已完成」状态与 commit hash，且 hash 与 `git log --oneline` 一一对应。

- [ ] **Step 2: 风险核对**

```text
[ ] userData/plugins 插件在主进程执行任意代码——文档已声明信任边界，插件目录仅限本机 user
[ ] 动态 import CJS/ESM 在 Electron main 可用——已在 M1-S1/M4-S3 验证
[ ] ipcMain.handle 通道名冲突——registerIpc 自动加 plugin:<id>: 前缀，全局通道仅 2 个
[ ] 上游文件改动收敛——M5-S3 已核对清单
```

- [ ] **Step 3: 最终提交**

```bash
git add docs/superpowers/plans/2026-08-06-cyrene-plugin-system.md
git commit -m "M5-S4 docs(plugins): 施工日志完结，插件系统 v1 交付"
```

---

## 验收标准

1. `npm test` 全量通过（含 src/plugins 与 channels 新增测试）。
2. `npm run build` 全绿。
3. 启动应用后，控制台输出 `[plugins] 已启用 demo` / `[plugins] 已启用 demo-dropin`。
4. 设置面板「功能插件」页动态列出插件，开关可启停且状态持久化（重启后保持）。
5. 在 `userData/plugins/` 新增一个符合契约的插件目录，无需改代码即可被加载使用（「放文件即用」）。
6. 上游文件改动仅限 Global Constraints 收敛清单。

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| 运行时插件在主进程执行任意代码 | 插件目录限定 `userData/plugins/`（本机用户），authoring 文档声明信任边界 |
| ESM/CJS 动态加载差异 | 统一 `import(pathToFileURL())` + default/named 归一化；内置插件走 CJS 编译产物 |
| 插件注册工具 id 与内置工具冲突 | 契约约定插件工具 id 以 `<pluginId>_` 前缀；冲突时 toolRegistry 覆盖并告警 |
| 插件抛错拖垮启动 | PluginManager.start 对每个插件 try/catch，失败插件记录错误后继续，不阻塞启动 |
| 与上游下次合并冲突 | 改动收敛清单固定，插件目录全部新增，冲突面可预期 |
