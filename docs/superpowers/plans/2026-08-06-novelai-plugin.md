# NovelAI 插件开发与导入 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在插件系统 v1 之上，把 NovelAI 绘图工作台（此前位于 `liyi-Cyrene` 分支）迁移为第一个内置插件 `novelai`：主进程能力（服务/供应商/提示词/任务队列 + LLM 工具 + IPC）收敛进 `src/plugins/novelai/`，渲染工作台保留 `src/renderer/novelai/` 并新增 vite 入口，插件自带 preload 与窗口管理，验证「插件目录 + manifest + 入口」的完整加载链路。

**Architecture:** 插件契约与规范见 `docs/plugins/plugin-authoring.md`。NovelAI 插件 = `manifest.json` + `index.ts`（入口）+ `service.ts`（IPC/工具/配置，从旧 `registerNovelAiIpc` 改造为 `registerNovelAi(ctx)`）+ `workbench.ts`（窗口管理）+ `preload.ts`（桥接 `window.novelai` 与 `plugin:novelai:*` 通道）。LLM 翻译能力不直接 import 上游 vendors，改为框架注入 `ctx.deps.llm.translateText`；配置改存 `ctx.storage`。

**Tech Stack:** TypeScript 5.6 / Electron 43 / Vite 7 / Vitest 4。零新增依赖。NovelAI Gateway（`http://127.0.0.1:31555`）为外部运行前提，插件不含网关。

## Global Constraints

- 分支：从 `liyi-Cyrene-v2` 创建隔离工作树分支 `feat/novelai-plugin`；施工与提交只在该隔离分支进行，不推送远端（除非用户另行要求）。
- 前置：插件系统 v1 必须已完成并通过验收（`docs/superpowers/plans/2026-08-06-cyrene-plugin-system.md` 的 M1-M4）。
- 提交规范：`M<里程碑>-S<步骤> <type>(plugins): <描述>`，每步结束立即提交。
- 施工痕迹：本文档「施工日志」随每步回填（时间 / 状态 / commit hash），日志更新独立 `docs` 提交。
- 迁移源：`fork/liyi-Cyrene` @ `c946a0d`（本地已 fetch，refs/remotes/fork/liyi-Cyrene），只读使用，不改动该分支。
- 上游文件改动收敛清单（除下列外不改动任何上游文件）：
  - `src/plugins/**`（全部新增，含 `novelai/`）
  - `src/renderer/novelai/**`（新增，从分支取回）
  - `src/plugins/types.ts`（`PluginDeps` 追加 `llm`，`CyrenePlugin` 追加可选 `open`）
  - `src/plugins/context.ts`（按 manifest 白名单组装 `llm`）
  - `src/plugins/loader.ts`（manifest 依赖白名单追加 `llm`）
  - `src/plugins/manager.ts`（提供受控的插件打开入口）
  - `src/shared/ipc-channels.ts`、`src/preload/index.ts`（插件打开 IPC 链路）
  - `src/renderer/settings/settings.ts`（功能插件列表显示“打开”按钮）
  - `vite.config.ts`（`rollupOptions.input` 追加 `novelai` 入口）
  - `src/main/plugin-llm.ts`（新增：翻译注入实现）
  - `src/main/index.ts`（插件 runtime 追加 `llm.translateText`）
- 零新增 npm 依赖；Node >=24 <25。
- 测试：TDD；`npm test` 全量通过；`npm run build` 全绿。
- 权限边界：只有 manifest 明确声明 `deps: ["llm"]` 的插件才能获得 `ctx.deps.llm`；未声明时必须为 `undefined`。
- 易用性：支持打开窗口的插件在“设置 → 功能插件”中显示“打开”按钮；不向 renderer 暴露任意插件 IPC 调用能力。

### 2026-08-08 执行前修订

本节记录插件系统 v1 修复完成后的差异，以下规则覆盖本文后续旧代码片段中的冲突内容：

1. `PluginManifest.deps` 与 loader 白名单同时扩展为 `"channels" | "llm"`；不能只扩展 `PluginDeps`。
2. `createContext` 必须分别按 `declaredDeps.includes("channels")` 和 `declaredDeps.includes("llm")` 注入，禁止无条件注入。
3. `createContext` 的 LLM 测试必须传入 `["llm"]`，并补充“未声明时不注入”的反向测试。
4. `dispose()` 现为异步函数；测试和卸载流程必须 `await ctx.dispose()`。
5. 保留旧 renderer 的 `translatePrompt(description: string)` 接口；由插件 preload 在内部组装 LLM messages，避免 UI 调用签名断裂。
6. 新增通用、受控的 `CyrenePlugin.open?()` 链路，让设置页可以打开 NAI 工作台；不得新增可调用任意 `plugin:*` 通道的通用 renderer API。
7. 所有测试数量以实际运行结果为准，不再使用旧计划中的固定数量断言。

---

## 施工日志（Construction Log）

| 步骤 | 日期时间 | 内容 | 状态 | 提交 |
|---|---|---|---|---|
| M0-S1 | 2026-08-06 | 计划文档创建并落库（施工日志初始化） | 已完成 | 92f9596 |
| M0-S2 | 2026-08-08 | 从 fork/liyi-Cyrene 提取 NovelAI 源码（main + renderer） | 已完成，迁移测试 16/16 通过 | 9467be1 |
| M1-S1 | 2026-08-08 | 框架扩展：PluginDeps 增加 llm（translateText 注入）+ 单测 | 已完成，权限正反测试 15/15 通过 | 1a51910 |
| M1-S2 | 2026-08-08 | 插件骨架：manifest.json + channels.ts + index.ts（可加载/可停用）+ manifest 测试 | 已完成，插件测试 40/40 通过 | 41eedde |
| M1-S3 | 2026-08-08 | 插件打开能力：设置页“打开”按钮 + 受控 IPC + 单测 | 已完成，22 个框架测试及 preload/renderer 构建通过 | f41b7d5 |
| M2-S1 | 2026-08-08 | 纯逻辑模块适配：types/providers/prompt-profile/task-queue 去除上游内部依赖 | 已完成，无需改码；仅有插件内相对类型导入，测试 16/16 通过 | 无代码提交 |
| M2-S2 | 2026-08-08 | service.ts 改造：IPC/工具/配置/翻译全部走 ctx | 已完成，插件测试 42/42 与 main 类型检查通过 | f188ef7 |
| M2-S3 | 2026-08-08 | workbench.ts 窗口管理 + index.ts 最终版 | 已完成，窗口/入口测试及插件测试 44/44 通过 | 1a084a0 |
| M3-S1 | 2026-08-08 | renderer 入口（vite.config.ts）+ 插件 preload.ts | 已完成，preload 测试、main 类型检查与 renderer 构建通过 | 93fafc0 |
| M4-S1 | 2026-08-08 | 主程序接线：plugin-llm.ts + index.ts 注入 llm.translateText | 已完成，LLM/NAI 测试 23/23 与 main 类型检查通过 | 11d2ede |
| M5-S1 | 2026-08-08 | 测试迁移（prompt-profile/providers/task-queue）+ 插件级集成测试 | 已完成，NAI 与 LLM 专项测试 23/23 通过 | 测试随各功能提交 |
| M6-S1 | 2026-08-08 | 全量回归 + 构建 + 构建产物运行时冒烟验证（加载/工具/IPC/卸载） | 已完成：265 个测试文件通过、2349 个测试通过；全量构建通过；5 个必需产物齐全；运行时启用后注册 6 个工具和 28 个 IPC，卸载后均为 0 | 00016fb |
| M7-S1 | 2026-08-08 | 上游合并演练 + 文档收尾 + 施工日志完结 | 已完成：可直接合入开发基线 `liyi-Cyrene-v2`；最新 `origin/master@196b0b8` 与基线已分叉，直接合并存在冲突，需另开上游同步任务处理 | 72be2a8 |
| M8-S1 | 2026-08-08 | 交付：将 `feat/novelai-plugin` 快进合并回 `liyi-Cyrene-v2`，并在合并结果上复跑全量测试 | 已完成：265 个测试文件通过、2349 个测试通过；准备推送 `fork/liyi-Cyrene-v2` | 本提交 |

---

## 1. 背景与迁移源

NovelAI 模块现状（`fork/liyi-Cyrene` @ `c946a0d`）：

```text
src/main/novelai/
  types.ts            # 配置与领域类型（纯逻辑）
  providers.ts        # 图像供应商适配（gateway/openai 等，纯逻辑 + fetch）
  prompt-profile.ts   # 角色/服装/提示词编译（纯逻辑）
  task-queue.ts       # 任务队列（纯逻辑）
  service.ts          # IPC 注册（ipcMain.on/handle）、窗口回调、工具注册、配置读写、翻译
  *.test.ts           # prompt-profile / providers / task-queue 三份单测
src/renderer/novelai/
  index.html / main.ts / novelai.css / wardrobe.css   # 工作台 UI，仅用 window.novelai API
scripts/start-novelai-gateway.ps1                     # 本地网关启动辅助（外部进程）
```

旧 `service.ts` 的关键耦合点（迁移必须解除）：

| 旧耦合 | 位置 | 迁移后 |
|---|---|---|
| `import { IPC } from "../../shared/ipc-channels"`（NOVELAI_* 常量，上游已无） | service.ts 头部 | 插件本地 `./channels` 常量表 |
| `import { toolRegistry }` + `toolRegistry.register(...)` | service.ts | `ctx.registerTool(...)` |
| `import { getAdapterForConfig }` + 自写 `translatePromptWithLLM` | service.ts | `ctx.deps.llm.translateText(...)` |
| `ipcMain.on/handle(IPC.NOVELAI_*)` 约 25 个通道 | service.ts | `ctx.registerIpc(NOVELAI.*, handler)`（自动加 `plugin:novelai:` 前缀） |
| `registerNovelAiIpc(openWindow, minimizeWindow, closeWindow)` | index.ts 5519 | 窗口管理移入插件 `workbench.ts` |
| 配置读写 `userData/novelai-config.json` | service.ts | `ctx.storage`（`userData/plugins/novelai/config.json`），apiKey 加密保留 |
| `win.webContents.send(IPC.NOVELAI_TASKS_CHANGED, ...)` | service.ts | `plugin:novelai:tasks-changed` 字符串通道 |
| preload `window.novelai`（IPC.NOVELAI_*） | 旧 preload/index.ts | 插件自带 `preload.ts` |

## 2. 目标目录结构（最终形态）

```text
src/plugins/novelai/
  manifest.json       # id=novelai，deps: ["channels","llm"]
  channels.ts         # 本地通道常量表（替代 NOVELAI_*）
  index.ts            # CyrenePlugin 入口（窗口 IPC + registerNovelAi）
  service.ts          # IPC 处理器 + 工具注册 + 配置读写（ctx 驱动）
  workbench.ts        # BrowserWindow 生命周期
  preload.ts          # 暴露 window.novelai，桥接 plugin:novelai:* 通道
  types.ts            # 领域类型（迁移）
  providers.ts        # 图像供应商（迁移）
  prompt-profile.ts   # 提示词编译（迁移）
  task-queue.ts       # 任务队列（迁移）
  *.test.ts           # 迁移 + 新增测试
src/renderer/novelai/ # 工作台 UI（迁移，vite 入口）
src/main/plugin-llm.ts# 翻译注入实现（主程序侧）
```

---

## 任务与步骤

### Task M0-S2: 从 fork/liyi-Cyrene 提取源码

**Files:**
- 工作区新增：`src/main/novelai/*`（临时，随后移入插件目录）、`src/renderer/novelai/*`

**Interfaces:**
- Produces: NovelAI 全部源文件落入当前工作区，作为后续任务改造基材。

- [ ] **Step 1: 确认迁移源可用**

```bash
git rev-parse --short fork/liyi-Cyrene
```
Expected: `c946a0d`（或更新的 fork 远端值，若已重新 fetch）

- [ ] **Step 2: 提取主进程模块到工作区**

```bash
git restore --source fork/liyi-Cyrene -- src/main/novelai
```

- [ ] **Step 3: 移入插件目录（先建目录，再逐文件 git mv）**

```powershell
New-Item -ItemType Directory -Force -Path src/plugins/novelai | Out-Null
Get-ChildItem src/main/novelai -File | ForEach-Object { git mv $_.FullName src/plugins/novelai/ }
Remove-Item -LiteralPath src/main/novelai -Force
```

- [ ] **Step 4: 提取 renderer 工作台**

```bash
git restore --source fork/liyi-Cyrene -- src/renderer/novelai
```

- [ ] **Step 5: 核对文件清单**

```bash
git status --short
```
Expected: `src/plugins/novelai/{types,providers,prompt-profile,task-queue,service}.ts` + 3 个 `.test.ts`；`src/renderer/novelai/{index.html,main.ts,novelai.css,wardrobe.css}`。

- [ ] **Step 6: 提交并回填施工日志（M0-S2）**

```bash
git add src/plugins/novelai src/renderer/novelai
git commit -m "M0-S2 feat(plugins): 从 liyi-Cyrene 提取 NovelAI 源码（main/renderer）"
git add docs/superpowers/plans/2026-08-06-novelai-plugin.md
git commit -m "M0-S2 docs(plugins): 施工日志回填 M0-S2"
```

---

### Task M1-S1: 框架扩展 PluginDeps.llm

**Files:**
- Modify: `src/plugins/types.ts`（manifest 依赖类型与 `PluginDeps` 追加 `llm`）
- Modify: `src/plugins/loader.ts`（依赖白名单追加 `llm`）
- Modify: `src/plugins/context.ts`（runtime 增加 `llm`，deps 组装）
- Test: `src/plugins/context.test.ts`、`src/plugins/loader.test.ts`（追加正反用例）

**Interfaces:**
- Produces: `LlmDeps.translateText(messages): Promise<string>`；只有 manifest 声明 `llm` 且 runtime 提供实现时才注入 `ctx.deps.llm`。
- Consumed by: M2-S2 service 翻译功能、M4-S1 主程序注入。

- [ ] **Step 1: 写失败测试（`context.test.ts` 追加）**

```ts
it("runtime 提供 llm 时注入 ctx.deps.llm.translateText", async () => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "cyrene-ctx-test-"));
  const calls: string[] = [];
  const rt = runtime();
  rt.llm = {
    translateText: async (messages) => {
      calls.push(messages.map((m) => m.content).join("|"));
      return "翻译结果";
    },
  };
  const ctx = createContext("demo", tmp, rt, ["llm"]);
  const out = await ctx.deps.llm?.translateText([
    { role: "user", content: "你好" },
  ]);
  expect(out).toBe("翻译结果");
  expect(calls).toEqual(["你好"]);
});

it("manifest 未声明 llm 时不注入 runtime.llm", () => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "cyrene-ctx-test-"));
  const rt = runtime();
  rt.llm = { translateText: async () => "不应被调用" };
  const ctx = createContext("demo", tmp, rt);
  expect(ctx.deps.llm).toBeUndefined();
});
```

> `runtime()` 辅助函数需返回带 `llm?: LlmDeps` 的结构；测试失败原因：`PluginRuntime` 无 `llm` 字段。

- [ ] **Step 2: 运行测试，确认失败**

```bash
npx vitest run src/plugins/context.test.ts src/plugins/loader.test.ts
```

- [ ] **Step 3: `types.ts` 追加**

```ts
export interface LlmDeps {
  /** 用主聊天模型做一次非流式翻译请求 */
  translateText(
    messages: Array<{ role: "system" | "user"; content: string }>,
  ): Promise<string>;
}
```

`PluginDeps` 追加：

```ts
  llm?: LlmDeps;
```

`PluginManifest.deps` 改为：

```ts
  deps?: Array<"channels" | "llm">;
```

`loader.ts` 的白名单与类型守卫改为：

```ts
const DEPS_ALLOWED = new Set(["channels", "llm"]);

deps: Array.isArray(raw.deps)
  ? raw.deps.filter(
      (d): d is "channels" | "llm" =>
        typeof d === "string" && DEPS_ALLOWED.has(d),
    )
  : undefined,
```

并在 `loader.test.ts` 将合法依赖断言改为同时保留 `channels`、`llm`，仍过滤未知值 `nope`。

- [ ] **Step 4: `context.ts` 追加**

`PluginRuntime` 追加：

```ts
  llm?: LlmDeps;
```

`createContext` 内 deps 组装改为：

```ts
  const deps: PluginDeps = {};
  if (declaredDeps?.includes("channels")) {
    deps.channels = { channelManager: runtime.channelManager };
  }
  if (declaredDeps?.includes("llm") && runtime.llm) {
    deps.llm = runtime.llm;
  }
```

（并同步 `import type { LlmDeps } from "./types"`）

- [ ] **Step 5: 运行测试，确认通过**

```bash
npx vitest run src/plugins/context.test.ts src/plugins/loader.test.ts
```
Expected: `context.test.ts` 与 `loader.test.ts` 全部 PASS；具体数量以当前分支实际输出为准。

- [ ] **Step 6: 提交并回填施工日志（M1-S1）**

```bash
git add src/plugins/types.ts src/plugins/loader.ts src/plugins/context.ts src/plugins/context.test.ts src/plugins/loader.test.ts
git commit -m "M1-S1 feat(plugins): PluginDeps 扩展 llm（translateText 注入）"
git add docs/superpowers/plans/2026-08-06-novelai-plugin.md
git commit -m "M1-S1 docs(plugins): 施工日志回填 M1-S1"
```

---

### Task M1-S2: 插件骨架（manifest + channels + index）

**Files:**
- Create: `src/plugins/novelai/manifest.json`
- Create: `src/plugins/novelai/channels.ts`
- Create: `src/plugins/novelai/index.ts`
- Test: `src/plugins/novelai/manifest.test.ts`

**Interfaces:**
- Produces: 可被 `PluginManager` 扫描加载的最小插件（注册 `plugin:novelai:status` 通道），后续任务在其上填充真实能力。

- [ ] **Step 1: 写失败测试 `src/plugins/novelai/manifest.test.ts`**

```ts
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readManifest } from "../loader";

const pluginDir = path.resolve(__dirname);

describe("novelai manifest", () => {
  it("manifest 合法且 entry 存在", () => {
    const manifest = readManifest(pluginDir);
    expect(manifest).toMatchObject({
      id: "novelai",
      name: expect.any(String),
      deps: expect.arrayContaining(["channels", "llm"]),
    });
    expect(manifest?.entry).toBe("index.js");
  });
});
```

- [ ] **Step 2: 运行测试，确认失败（manifest 不存在）**

```bash
npx vitest run src/plugins/novelai/manifest.test.ts
```

- [ ] **Step 3: 写 `manifest.json`**

```json
{
  "id": "novelai",
  "name": "NovelAI 绘图",
  "version": "0.1.0",
  "description": "NovelAI 绘图工作台（本地网关模式）：LLM 工具 + 独立窗口",
  "author": "liyi",
  "entry": "index.js",
  "defaultEnabled": true,
  "deps": ["channels", "llm"]
}
```

- [ ] **Step 4: 写 `channels.ts`（本地常量表，替代旧 NOVELAI_*，通道名不含前缀，前缀由 ctx 自动加）**

```ts
export const NOVELAI = {
  OPEN_WORKBENCH: "open-workbench",
  MINIMIZE: "minimize",
  CLOSE: "close",
  LOAD_CONFIG: "load-config",
  SAVE_CONFIG: "save-config",
  TEST: "test",
  CAPABILITIES: "capabilities",
  MODELS: "models",
  GENERATE: "generate",
  TASKS: "tasks",
  TASK_CANCEL: "task-cancel",
  TASK_RETRY: "task-retry",
  HISTORY: "history",
  GET_IMAGE: "get-image",
  OPEN_OUTPUT: "open-output",
  PICK_IMAGE: "pick-image",
  ASSETS: "assets",
  ASSET_IMPORT: "asset-import",
  ASSET_DELETE: "asset-delete",
  ASSET_UPDATE: "asset-update",
  UPSCALE: "upscale",
  HISTORY_UPDATE: "history-update",
  HISTORY_DELETE: "history-delete",
  TRANSLATE_PROMPT: "translate-prompt",
  TASKS_CHANGED: "tasks-changed",
} as const;
```

- [ ] **Step 5: 写骨架 `index.ts`（M2-S3 会替换为最终版）**

```ts
import type { CyrenePlugin } from "../types";
import { NOVELAI } from "./channels";

export const novelaiPlugin: CyrenePlugin = {
  register(ctx) {
    ctx.log("NovelAI 插件注册");
    ctx.registerIpc("status", () => ({ id: "novelai", version: "0.1.0", ok: true }));
    ctx.registerIpc(NOVELAI.OPEN_WORKBENCH, () => ({ ok: false, error: "工作台未就绪（M2-S3 实现）" }));
  },
  unregister() {
    console.log("[plugin:novelai] 已卸载");
  },
};

export default novelaiPlugin;
```

- [ ] **Step 6: 运行测试，确认通过**

```bash
npx vitest run src/plugins/novelai/manifest.test.ts
```
Expected: PASS。

- [ ] **Step 7: 提交并回填施工日志（M1-S2）**

```bash
git add src/plugins/novelai/manifest.json src/plugins/novelai/channels.ts src/plugins/novelai/index.ts src/plugins/novelai/manifest.test.ts
git commit -m "M1-S2 feat(plugins): NovelAI 插件骨架（manifest/channels/index）"
git add docs/superpowers/plans/2026-08-06-novelai-plugin.md
git commit -m "M1-S2 docs(plugins): 施工日志回填 M1-S2"
```

---

### Task M1-S3: 通用插件打开能力（设置页“打开”按钮）

**Files:**
- Modify: `src/plugins/types.ts`
- Modify: `src/plugins/manager.ts`
- Modify: `src/shared/ipc-channels.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/settings/settings.ts`
- Test: `src/plugins/manager.test.ts`

**Interfaces:**
- Produces: `CyrenePlugin.open?(): void | Promise<void>`、列表字段 `canOpen: boolean`、受控 IPC `plugins:open`。
- Consumed by: M2-S3 的 NovelAI 工作台窗口、设置页“打开”按钮。

- [ ] **Step 1: 写失败测试**

在 `manager.test.ts` 的 fixture 插件入口中加入 `open() {}`，并追加：

```ts
it("只允许打开已启用且声明 open 的插件", async () => {
  const h = harness();
  const mgr = new PluginManager(h.options);
  await mgr.start();

  expect(mgr.list()[0].canOpen).toBe(true);
  expect(h.ipc.has("plugins:open")).toBe(true);
  await expect(h.ipc.get("plugins:open")?.("demo")).resolves.toEqual({ ok: true });

  await mgr.setEnabled("demo", false);
  await expect(h.ipc.get("plugins:open")?.("demo")).resolves.toMatchObject({ ok: false });
});
```

- [ ] **Step 2: 运行测试，确认因 `canOpen` / `plugins:open` 尚不存在而失败**

Run: `npx vitest run src/plugins/manager.test.ts`

- [ ] **Step 3: 实现最小主进程契约**

`CyrenePlugin` 追加：

```ts
open?(): void | Promise<void>;
```

`PluginListEntry` 追加 `canOpen: boolean`，`list()` 返回：

```ts
canOpen: typeof plugin?.open === "function",
```

`PluginManager` 追加：

```ts
async open(id: string): Promise<{ ok: boolean; error?: string }> {
  const plugin = this.instances.get(id);
  if (!plugin) return { ok: false, error: `插件未启用: ${id}` };
  if (!plugin.open) return { ok: false, error: `插件不支持打开窗口: ${id}` };
  try {
    await plugin.open();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
```

在 `start()` 注册 `IPC.PLUGINS_OPEN`，在 `stop()` 注销；`ipc-channels.ts` 追加：

```ts
PLUGINS_OPEN: "plugins:open",
```

- [ ] **Step 4: 实现 renderer 的受控按钮**

`src/preload/index.ts` 的 `pluginsApi` 追加：

```ts
open: (id: string) => ipcRenderer.invoke(IPC.PLUGINS_OPEN, id),
```

设置页 `window.plugins` 类型追加 `canOpen` 与 `open(id)`；`renderFeaturePlugins()` 在启用且 `canOpen` 时创建“打开”按钮，点击后调用 `window.plugins.open(item.id)`，失败时沿用现有红色错误提示样式。

- [ ] **Step 5: 运行插件测试并提交**

```bash
npx vitest run src/plugins
git add src/plugins/types.ts src/plugins/manager.ts src/plugins/manager.test.ts src/shared/ipc-channels.ts src/preload/index.ts src/renderer/settings/settings.ts
git commit -m "M1-S3 feat(plugins): 增加受控的插件打开入口"
git add docs/superpowers/plans/2026-08-06-novelai-plugin.md
git commit -m "M1-S3 docs(plugins): 施工日志回填 M1-S3"
```

---

### Task M2-S1: 纯逻辑模块适配

**Files:**
- Modify: `src/plugins/novelai/types.ts`
- Modify: `src/plugins/novelai/providers.ts`
- Modify: `src/plugins/novelai/prompt-profile.ts`
- Modify: `src/plugins/novelai/task-queue.ts`

**Interfaces:**
- Produces: 四个纯逻辑模块不再 import 任何 `../main/**`、`../../shared/**` 或 `electron` 符号；模块间相对导入保持原样。

- [ ] **Step 1: 检查各文件 import 行**

```bash
Select-String -Path src/plugins/novelai/types.ts,src/plugins/novelai/providers.ts,src/plugins/novelai/prompt-profile.ts,src/plugins/novelai/task-queue.ts -Pattern "^import"
```

- [ ] **Step 2: 删除/改写任何指向上游内部的 import**

规则：
- `electron` import 仅在 `service.ts` 中保留；四个纯逻辑模块若出现 electron import 一律删除或改为参数传入。
- `../../shared/ipc-channels`、`../orchestrator/*` 出现即删除，由调用方（service）注入所需数据。
- 若 `providers.ts` 需要配置类型，从 `./types` 导入（已如此，无需改）。

> 预期：四个文件迁移后无外部 import 或仅相对导入 `./types` / `./providers` 等，本步骤通常为 0 行实质性改动，仅核对。

- [ ] **Step 3: 跑迁移测试（暂仍指向旧路径的测试先排除）**

```bash
npx vitest run src/plugins/novelai/prompt-profile.test.ts src/plugins/novelai/providers.test.ts src/plugins/novelai/task-queue.test.ts
```
Expected: 3 份测试全 PASS（import 相对路径在移动后不变；若 providers 测试 mock 了 fetch/electron，按失败信息修 mock）。

- [ ] **Step 4: 提交并回填施工日志（M2-S1）**

```bash
git add src/plugins/novelai
git commit -m "M2-S1 feat(plugins): NovelAI 纯逻辑模块去上游耦合（types/providers/prompt-profile/task-queue）"
git add docs/superpowers/plans/2026-08-06-novelai-plugin.md
git commit -m "M2-S1 docs(plugins): 施工日志回填 M2-S1"
```

---

### Task M2-S2: service.ts 改造（ctx 驱动）

**Files:**
- Modify: `src/plugins/novelai/service.ts`（核心改造）

**Interfaces:**
- Consumes: M1-S1 `ctx.deps.llm`、M1-S2 `NOVELAI` 常量、`ctx.registerIpc/registerTool/storage`。
- Produces: `registerNovelAi(ctx: PluginContext): void`；删除 `registerNovelAiIpc(open, min, close)` 与 ipcMain 直挂。

- [ ] **Step 1: 改造 import 头（删除/替换）**

```ts
// 删除：import { IPC } from "../../shared/ipc-channels";
// 删除：import { toolRegistry } from "../orchestrator/tool-registry";
// 删除：import { getAdapterForConfig } from "../orchestrator/vendors";
// 保留（主进程插件允许 electron）：app, dialog, safeStorage, shell
// 新增：
import { NOVELAI } from "./channels";
import type { PluginContext } from "../types";
```

- [ ] **Step 2: 删除 `translatePromptWithLLM`，新增模块级翻译转发**

```ts
async function translatePrompt(messages: Array<{ role: "system" | "user"; content: string }>): Promise<string> {
  if (!activeCtx?.deps.llm?.translateText) {
    throw new Error("翻译能力不可用：主程序未注入 llm.translateText");
  }
  return activeCtx.deps.llm.translateText(messages);
}
```

原 `IPC.NOVELAI_TRANSLATE_PROMPT` 处理器改为调用 `translatePrompt`。

- [ ] **Step 3: 配置读写迁移到 ctx.storage**

```ts
let activeCtx: PluginContext | null = null;

function loadNovelAiConfig(): NovelAiConfig {
  const stored = activeCtx?.storage.get<StoredConfig>("config");
  // 与旧实现相同的合并/归一化逻辑（character/outfit 归一化等），数据源从 userData/novelai-config.json 改为 ctx.storage
}

function saveNovelAiConfig(config: Partial<NovelAiConfig>): NovelAiConfig {
  // 与旧实现相同的归一化 + safeStorage 加密 apiKey，写 activeCtx.storage.set("config", ...)
}
```

> 实现时保留旧函数体内的合并/归一化/加密逻辑不变，仅替换读写介质（storage key `config`）。

- [ ] **Step 4: 用 `registerNovelAi(ctx)` 替换 `registerNovelAiIpc`**

```ts
export function registerNovelAi(ctx: PluginContext): void {
  activeCtx = ctx;
  // 窗口三通道由 index.ts 注册（M2-S3），此处不注册 OPEN/MINIMIZE/CLOSE
  ctx.registerIpc(NOVELAI.LOAD_CONFIG, () => loadNovelAiConfig());
  ctx.registerIpc(NOVELAI.SAVE_CONFIG, (_c: unknown) => saveNovelAiConfig(_c || {}));
  ctx.registerIpc(NOVELAI.TEST, async (_c: unknown) => testNovelAiConfig(_c || {}));
  ctx.registerIpc(NOVELAI.CAPABILITIES, (_kind: unknown) => getProviderCapabilities(String(_kind) as ImageProviderKind));
  ctx.registerIpc(NOVELAI.MODELS, (_c: unknown) => listNovelAiModels(_c || undefined));
  ctx.registerIpc(NOVELAI.GENERATE, (_input: unknown) => generateNovelAiImage(_input || {}));
  ctx.registerIpc(NOVELAI.TASKS, () => imageQueue.list().map(({ input: _input, ...task }) => task));
  ctx.registerIpc(NOVELAI.TASK_CANCEL, (_id: unknown) => imageQueue.cancel(String(_id || "")));
  ctx.registerIpc(NOVELAI.TASK_RETRY, async (_id: unknown) => imageQueue.retry(String(_id || "")));
  ctx.registerIpc(NOVELAI.HISTORY, (_o: unknown, _l: unknown) => loadHistory(Number(_o) || 0, Number(_l) || 40));
  ctx.registerIpc(NOVELAI.GET_IMAGE, (_id: unknown) => loadImageById(_id));
  ctx.registerIpc(NOVELAI.OPEN_OUTPUT, () => shell.openPath(outputDir()));
  ctx.registerIpc(NOVELAI.PICK_IMAGE, async () => pickImageAsset());
  ctx.registerIpc(NOVELAI.ASSETS, () => loadAssets());
  ctx.registerIpc(NOVELAI.ASSET_IMPORT, () => importAsset());
  ctx.registerIpc(NOVELAI.ASSET_DELETE, (_id: unknown) => deleteAsset(_id));
  ctx.registerIpc(NOVELAI.ASSET_UPDATE, (_id: unknown, _p: unknown) => updateAsset(_id, _p));
  ctx.registerIpc(NOVELAI.UPSCALE, (_id: unknown, _s: unknown) => upscaleImageById(_id, _s));
  ctx.registerIpc(NOVELAI.HISTORY_UPDATE, (_id: unknown, _p: unknown) => updateHistoryMeta(_id, _p));
  ctx.registerIpc(NOVELAI.HISTORY_DELETE, (_id: unknown) => deleteHistoryItem(_id));
  ctx.registerIpc(NOVELAI.TRANSLATE_PROMPT, async (_msgs: unknown) => translatePrompt(_msgs as Array<{ role: "system" | "user"; content: string }>));
  registerNovelAiTools(ctx);
}
```

- [ ] **Step 5: 工具注册改造**

旧 `toolRegistry.register({ id: "inspect_drawing_context", ... })` 改为：

```ts
function registerNovelAiTools(ctx: PluginContext): void {
  ctx.registerTool({
    id: "inspect_drawing_context",
    // name/description/inputSchema/execute 等字段照抄旧实现（含全部已注册的 novelai 工具）
  });
}
```

（工具 id 保持 `<pluginId>_` 前缀：`inspect_drawing_context` 若与规范冲突，则统一改名为 `novelai_inspect_drawing_context`，并在迁移时同步改 service 内引用。）

- [ ] **Step 6: 任务推送改字符串通道**

```ts
// 旧：win.webContents.send(IPC.NOVELAI_TASKS_CHANGED, ...)
// 新：
getWorkbenchWindow()?.webContents.send(`plugin:novelai:${NOVELAI.TASKS_CHANGED}`, tasks);
```

（`getWorkbenchWindow` 由 M2-S3 的 workbench.ts 提供。）

- [ ] **Step 7: 验证编译**

```bash
npx tsc -p tsconfig.main.json --noEmit
```
Expected: 无类型错误（`workbench.ts` 尚不存在时，先注释/临时代替 `getWorkbenchWindow` 调用，或本步骤与 M2-S3 合并提交）。

- [ ] **Step 8: 提交并回填施工日志（M2-S2）**

```bash
git add src/plugins/novelai/service.ts
git commit -m "M2-S2 feat(plugins): service 改造为 ctx 驱动（IPC/工具/配置/翻译）"
git add docs/superpowers/plans/2026-08-06-novelai-plugin.md
git commit -m "M2-S2 docs(plugins): 施工日志回填 M2-S2"
```

---

### Task M2-S3: workbench 窗口管理 + index 最终版

**Files:**
- Create: `src/plugins/novelai/workbench.ts`
- Modify: `src/plugins/novelai/index.ts`（替换为最终版）

**Interfaces:**
- Produces: `createWorkbenchWindow()` / `minimizeWorkbenchWindow()` / `closeWorkbenchWindow()` / `getWorkbenchWindow(): BrowserWindow | null`；index 注册窗口三通道并调用 `registerNovelAi(ctx)`。
- Consumed by: M2-S2 service 任务推送、M3-S1 preload。

- [ ] **Step 1: 写 `workbench.ts`**

```ts
import { BrowserWindow } from "electron";
import path from "node:path";

const isDev = process.env.VITE_DEV === "1";
let workbenchWindow: BrowserWindow | null = null;

export function getWorkbenchWindow(): BrowserWindow | null {
  return workbenchWindow && !workbenchWindow.isDestroyed() ? workbenchWindow : null;
}

export function createWorkbenchWindow(): void {
  const existing = getWorkbenchWindow();
  if (existing) {
    existing.show();
    existing.focus();
    return;
  }
  workbenchWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: "昔涟 · NovelAI 绘图",
    backgroundColor: "#1b1b22",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  if (isDev) {
    workbenchWindow.loadURL("http://localhost:5173/novelai/");
  } else {
    workbenchWindow.loadFile(path.join(__dirname, "..", "..", "..", "renderer", "novelai", "index.html"));
  }
  workbenchWindow.once("ready-to-show", () => workbenchWindow?.show());
  workbenchWindow.on("closed", () => {
    workbenchWindow = null;
  });
}

export function minimizeWorkbenchWindow(): void {
  getWorkbenchWindow()?.minimize();
}

export function closeWorkbenchWindow(): void {
  getWorkbenchWindow()?.close();
}
```

- [ ] **Step 2: 替换 `index.ts` 为最终版**

```ts
import type { CyrenePlugin } from "../types";
import { NOVELAI } from "./channels";
import { registerNovelAi } from "./service";
import { closeWorkbenchWindow, createWorkbenchWindow, minimizeWorkbenchWindow } from "./workbench";

export const novelaiPlugin: CyrenePlugin = {
  open() {
    createWorkbenchWindow();
  },
  register(ctx) {
    ctx.log("NovelAI 插件注册");
    ctx.registerIpc("status", () => ({ id: "novelai", version: "0.1.0", ok: true }));
    ctx.registerIpc(NOVELAI.OPEN_WORKBENCH, () => {
      createWorkbenchWindow();
      return { ok: true };
    });
    ctx.registerIpc(NOVELAI.MINIMIZE, () => {
      minimizeWorkbenchWindow();
      return { ok: true };
    });
    ctx.registerIpc(NOVELAI.CLOSE, () => {
      closeWorkbenchWindow();
      return { ok: true };
    });
    registerNovelAi(ctx);
  },
  unregister() {
    closeWorkbenchWindow();
  },
};

export default novelaiPlugin;
```

- [ ] **Step 3: 验证编译**

```bash
npx tsc -p tsconfig.main.json --noEmit
```
Expected: 无类型错误。

- [ ] **Step 4: 提交并回填施工日志（M2-S3）**

```bash
git add src/plugins/novelai/workbench.ts src/plugins/novelai/index.ts
git commit -m "M2-S3 feat(plugins): NovelAI 工作台窗口管理 + 入口最终版"
git add docs/superpowers/plans/2026-08-06-novelai-plugin.md
git commit -m "M2-S3 docs(plugins): 施工日志回填 M2-S3"
```

---

### Task M3-S1: renderer 入口 + 插件 preload

**Files:**
- Modify: `vite.config.ts`（`rollupOptions.input` 追加 `novelai`）
- Create: `src/plugins/novelai/preload.ts`

**Interfaces:**
- Produces: 构建产物 `dist/renderer/novelai/index.html` 与 `dist/main/plugins/novelai/preload.js`；`window.novelai` 桥接 `plugin:novelai:*` 通道。

- [ ] **Step 1: `vite.config.ts` 的 `rollupOptions.input` 追加**

```ts
        novelai: resolve(__dirname, "src/renderer/novelai/index.html"),
```

- [ ] **Step 2: 写 `preload.ts`（完整映射 service 通道）**

```ts
import { contextBridge, ipcRenderer } from "electron";
import { NOVELAI } from "./channels";

const prefix = (ch: string) => `plugin:novelai:${ch}`;

const novelaiApi = {
  open: () => ipcRenderer.invoke(prefix(NOVELAI.OPEN_WORKBENCH)),
  minimize: () => ipcRenderer.invoke(prefix(NOVELAI.MINIMIZE)),
  close: () => ipcRenderer.invoke(prefix(NOVELAI.CLOSE)),
  loadConfig: () => ipcRenderer.invoke(prefix(NOVELAI.LOAD_CONFIG)),
  saveConfig: (config: unknown) => ipcRenderer.invoke(prefix(NOVELAI.SAVE_CONFIG), config),
  test: (config?: unknown) => ipcRenderer.invoke(prefix(NOVELAI.TEST), config),
  capabilities: (kind: string) => ipcRenderer.invoke(prefix(NOVELAI.CAPABILITIES), kind),
  models: (config?: unknown) => ipcRenderer.invoke(prefix(NOVELAI.MODELS), config),
  generate: (input: unknown) => ipcRenderer.invoke(prefix(NOVELAI.GENERATE), input),
  history: (offset = 0, limit = 40) => ipcRenderer.invoke(prefix(NOVELAI.HISTORY), offset, limit),
  image: (id: string) => ipcRenderer.invoke(prefix(NOVELAI.GET_IMAGE), id),
  openOutput: () => ipcRenderer.invoke(prefix(NOVELAI.OPEN_OUTPUT)),
  pickImage: () => ipcRenderer.invoke(prefix(NOVELAI.PICK_IMAGE)),
  tasks: () => ipcRenderer.invoke(prefix(NOVELAI.TASKS)),
  cancelTask: (id: string) => ipcRenderer.invoke(prefix(NOVELAI.TASK_CANCEL), id),
  retryTask: (id: string) => ipcRenderer.invoke(prefix(NOVELAI.TASK_RETRY), id),
  assets: () => ipcRenderer.invoke(prefix(NOVELAI.ASSETS)),
  importAsset: () => ipcRenderer.invoke(prefix(NOVELAI.ASSET_IMPORT)),
  deleteAsset: (id: string) => ipcRenderer.invoke(prefix(NOVELAI.ASSET_DELETE), id),
  updateAsset: (id: string, patch: unknown) => ipcRenderer.invoke(prefix(NOVELAI.ASSET_UPDATE), id, patch),
  upscale: (id: string, scale: number) => ipcRenderer.invoke(prefix(NOVELAI.UPSCALE), id, scale),
  updateHistory: (id: string, patch: unknown) => ipcRenderer.invoke(prefix(NOVELAI.HISTORY_UPDATE), id, patch),
  deleteHistory: (id: string) => ipcRenderer.invoke(prefix(NOVELAI.HISTORY_DELETE), id),
  translatePrompt: (description: string) =>
    ipcRenderer.invoke(prefix(NOVELAI.TRANSLATE_PROMPT), [
      {
        role: "system",
        content: "Convert the user's Chinese image description into concise NovelAI English comma-separated tags. Preserve subject, appearance, clothing, pose, expression, composition, environment, lighting and style. Output tags only; no explanation, Markdown, quotes, or roleplay.",
      },
      { role: "user", content: description },
    ]),
  onTasksChanged: (cb: (tasks: unknown[]) => void) => {
    const listener = (_event: unknown, tasks: unknown[]) => cb(tasks);
    ipcRenderer.on(prefix(NOVELAI.TASKS_CHANGED), listener);
    return () => ipcRenderer.removeListener(prefix(NOVELAI.TASKS_CHANGED), listener);
  },
};

contextBridge.exposeInMainWorld("novelai", novelaiApi);
```

> `src/renderer/novelai/main.ts` 已自行声明 `Window.novelai` 接口且只通过该 API 交互，无需修改。

- [ ] **Step 3: 构建验证**

```bash
npm run build:main && npm run build:renderer
```
Expected: `dist/renderer/novelai/index.html`、`dist/main/plugins/novelai/preload.js` 存在。

- [ ] **Step 4: 提交并回填施工日志（M3-S1）**

```bash
git add vite.config.ts src/plugins/novelai/preload.ts
git commit -m "M3-S1 feat(plugins): NovelAI renderer 入口 + 插件 preload（window.novelai 桥接）"
git add docs/superpowers/plans/2026-08-06-novelai-plugin.md
git commit -m "M3-S1 docs(plugins): 施工日志回填 M3-S1"
```

---

### Task M4-S1: 主程序注入 translateText

**Files:**
- Create: `src/main/plugin-llm.ts`
- Modify: `src/main/index.ts`（插件 runtime 追加 `llm`）

**Interfaces:**
- Consumes: 上游 `getAdapterForConfig`（orchestrator/vendors）。
- Produces: `pluginTranslateText(messages): Promise<string>`，注入 `PluginManager.runtime.llm`。

- [ ] **Step 1: 写 `src/main/plugin-llm.ts`**

```ts
import { app } from "electron";
import * as fs from "node:fs";
import path from "node:path";
import { getAdapterForConfig } from "./orchestrator/vendors";
import type { VendorConfig } from "./orchestrator/vendors/types";

interface ChatModelSettings {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  explicitTransport?: "openai" | "anthropic" | "auto";
}

function loadChatModelSettings(): ChatModelSettings {
  const defaults: ChatModelSettings = {
    provider: "DeepSeek（深度求索）",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-v4-pro",
    apiKey: "",
  };
  try {
    const filePath = path.join(app.getPath("userData"), "model-settings.json");
    if (!fs.existsSync(filePath)) return defaults;
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
    return {
      provider: typeof parsed.provider === "string" && parsed.provider.trim() ? parsed.provider.trim() : defaults.provider,
      baseUrl: typeof parsed.baseUrl === "string" && parsed.baseUrl.trim() ? parsed.baseUrl.trim() : defaults.baseUrl,
      model: typeof parsed.model === "string" && parsed.model.trim() ? parsed.model.trim() : defaults.model,
      apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey.trim() : "",
      explicitTransport:
        parsed.explicitTransport === "openai" || parsed.explicitTransport === "anthropic" || parsed.explicitTransport === "auto"
          ? parsed.explicitTransport
          : undefined,
    };
  } catch {
    return defaults;
  }
}

/** 供插件注入的非流式翻译实现（复用上游 vendor adapter） */
export async function pluginTranslateText(
  messages: Array<{ role: "system" | "user"; content: string }>,
): Promise<string> {
  const settings = loadChatModelSettings();
  if (!settings.apiKey) throw new Error("未配置 API Key，请先在设置页配置模型");
  const cfg: VendorConfig = {
    provider: settings.provider,
    baseUrl: settings.baseUrl,
    model: settings.model,
    apiKey: settings.apiKey,
    explicitTransport: settings.explicitTransport,
  };
  const adapter = getAdapterForConfig(cfg);
  const http = adapter.buildRequest(
    {
      model: cfg.model,
      messages: messages as Array<{ role: "system" | "user" | "assistant"; content: string }>,
      maxTokens: 1024,
      stream: false,
    },
    cfg,
  );
  const response = await fetch(http.url, {
    method: "POST",
    headers: http.headers,
    body: http.body,
  });
  if (!response.ok) throw new Error(`翻译请求失败: HTTP ${response.status}`);
  const data = await response.json();
  return adapter.parseResponse(data).text ?? "";
}
```

- [ ] **Step 2: `index.ts` 插件 runtime 追加**

```ts
      llm: { translateText: pluginTranslateText },
```

并补充 import：

```ts
import { pluginTranslateText } from "./plugin-llm";
```

- [ ] **Step 3: 验证编译**

```bash
npm run build:main
```
Expected: tsc 通过。

- [ ] **Step 4: 提交并回填施工日志（M4-S1）**

```bash
git add src/main/plugin-llm.ts src/main/index.ts
git commit -m "M4-S1 feat(plugins): 主程序注入 llm.translateText（plugin-llm.ts）"
git add docs/superpowers/plans/2026-08-06-novelai-plugin.md
git commit -m "M4-S1 docs(plugins): 施工日志回填 M4-S1"
```

---

### Task M5-S1: 测试迁移与插件级集成测试

**Files:**
- 迁移：`src/plugins/novelai/{prompt-profile,providers,task-queue}.test.ts`（已在 M0 移入，路径适配在 M2-S1 完成）
- Create: `src/plugins/novelai/novelai-plugin.test.ts`

**Interfaces:**
- Consumes: M1-S2 `NOVELAI`、M2-S2 `registerNovelAi`。
- Produces: 插件级集成测试——fake runtime 下 `registerNovelAi(ctx)` 注册了预期 IPC 通道与工具。

- [ ] **Step 1: 写失败测试 `src/plugins/novelai/novelai-plugin.test.ts`**

```ts
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createContext, type PluginRuntime } from "../context";
import { NOVELAI } from "./channels";
import { registerNovelAi } from "./service";

let tmp: string;

afterEach(() => {
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = "";
  }
});

function harness() {
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
    llm: {
      translateText: async (msgs) => `T:${msgs.map((m) => m.content).join("|")}`,
    },
  };
  tmp = mkdtempSync(path.join(os.tmpdir(), "cyrene-novelai-test-"));
  return { ctx: createContext("novelai", tmp, runtime, ["llm"]), ipc, tools };
}

describe("novelai plugin service", () => {
  it("registerNovelAi 注册核心 IPC 通道（带 plugin:novelai: 前缀）", () => {
    const { ctx, ipc } = harness();
    registerNovelAi(ctx);
    expect(ipc.has(`plugin:novelai:${NOVELAI.GENERATE}`)).toBe(true);
    expect(ipc.has(`plugin:novelai:${NOVELAI.LOAD_CONFIG}`)).toBe(true);
    expect(ipc.has(`plugin:novelai:${NOVELAI.TRANSLATE_PROMPT}`)).toBe(true);
  });

  it("registerNovelAi 注册绘图工具（id 以 novelai_ 前缀）", () => {
    const { ctx, tools } = harness();
    registerNovelAi(ctx);
    expect(tools.some((id) => id.startsWith("novelai_"))).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

```bash
npx vitest run src/plugins/novelai/novelai-plugin.test.ts
```

- [ ] **Step 3: 按失败修正 service.ts**（通道名/工具 id 与测试对齐：工具统一 `novelai_` 前缀；IPC 由 `registerNovelAi` 全部注册）

- [ ] **Step 4: 跑全部 NovelAI 测试**

```bash
npx vitest run src/plugins/novelai
```
Expected: prompt-profile / providers / task-queue / manifest / novelai-plugin 全部 PASS。

- [ ] **Step 5: 提交并回填施工日志（M5-S1）**

```bash
git add src/plugins/novelai
git commit -m "M5-S1 test(plugins): NovelAI 测试迁移 + 插件级集成测试"
git add docs/superpowers/plans/2026-08-06-novelai-plugin.md
git commit -m "M5-S1 docs(plugins): 施工日志回填 M5-S1"
```

---

### Task M6-S1: 全量回归 + 构建 + 端到端验证

**Files:**
- 无新增文件。

- [x] **Step 1: 全量测试**

```bash
npm test
```
Expected: 全部 PASS。

- [x] **Step 2: 全量构建**

```bash
npm run build
```
Expected: 全绿；确认产物：

```text
dist/main/plugins/novelai/manifest.json
dist/main/plugins/novelai/index.js
dist/main/plugins/novelai/preload.js
dist/main/plugins/novelai/service.js
dist/renderer/novelai/index.html
```

- [x] **Step 3: 启动端到端验证**

```bash
node dist/cli/index.js run
```

Expected:
- 控制台出现 `[plugins] 已启用 novelai@0.1.0`；
- 设置面板「功能插件」出现 NovelAI 绘图，开关可启停；
- 调用 `plugin:novelai:status` 返回 `{ ok: true, id: "novelai" }`；
- 打开工作台窗口（`plugin:novelai:open-workbench`），窗口标题「昔涟 · NovelAI 绘图」，`window.novelai` 可用；
- 禁用插件后工作台窗口关闭、IPC 通道消失；
- 生成/放大等动作依赖本地 NovelAI Gateway（`http://127.0.0.1:31555`）运行，未启动时接口报错但插件与 UI 正常。

本次采用构建产物运行时冒烟替代可见 GUI 人工点击：直接从 `dist/main/plugins` 启动 `PluginManager`，确认 `novelai@0.1.0` 已启用、`canOpen=true`、6 个 `novelai_*` 工具和 28 个 IPC 已注册；调用 `stop()` 后工具与 IPC 均清零。窗口创建、防重复、preload API 与设置页“打开”按钮由对应自动化测试覆盖。实际出图仍需用户本机另行启动 NovelAI Gateway。

- [x] **Step 4: 提交并回填施工日志（M6-S1）**

```bash
git add docs/superpowers/plans/2026-08-06-novelai-plugin.md
git commit -m "M6-S1 docs(plugins): NovelAI 插件端到端验证通过"
```

---

### Task M7-S1: 上游合并演练 + 收尾

**Files:**
- 无代码改动。

- [x] **Step 1: 合并演练**

```bash
git fetch origin
git merge-base --is-ancestor origin/master HEAD && echo "可安全合并"
```

演练结果（2026-08-08）：

- `liyi-Cyrene-v2` 是当前分支祖先，功能分支可直接合回该开发基线；
- fetch 后最新上游为 `origin/master@196b0b8`，双方共同基点为 `0de38dd`，上游已不是当前分支祖先；
- `git merge-tree` 只读演练确认直接同步官方上游会在 `package.json`、`src/main/index.ts`、preload、设置页、IPC、vitest 配置等既有集成热点产生冲突；这属于开发基线与官方上游的整体分叉，不在本次 NovelAI 插件迁移中强行解决；
- 后续如需同步官方上游，应单独建立同步分支，逐项保留两边功能并重新跑全量验收。

- [x] **Step 2: 核对冲突面收敛清单**（相对 `liyi-Cyrene-v2` 共 37 个文件：NovelAI 源码集中在 `src/plugins/novelai/` 与 `src/renderer/novelai/`；其余改动均落在 Global Constraints 已列出的框架接线、测试和文档文件中）

- [x] **Step 3: 核对规范一致性**（`docs/plugins/plugin-authoring.md` 已补齐 `llm` 白名单、受控 `open()` 和 NovelAI 窗口范例；静态检查确认 NovelAI 插件没有直接 import `src/main/**` 或 `src/shared/**`）

- [x] **Step 4: 施工日志全部回填，最终提交**

```bash
git add docs/superpowers/plans/2026-08-06-novelai-plugin.md
git commit -m "M7-S1 docs(plugins): NovelAI 插件施工日志完结"
```

---

## 验收标准

1. `npm test` 全量通过；`npm run build` 全绿。
2. 插件系统加载 `novelai`：控制台出现启用日志，设置面板可开关。
3. 工作台窗口可打开，`window.novelai` 与 `plugin:novelai:*` 通道全链路可用。
4. LLM 工具（`novelai_*`）注册成功，禁用插件后工具/IPC/窗口全部清理。
5. 配置落 `userData/plugins/novelai/config.json`，apiKey 加密语义保留。
6. 上游文件改动仅限 Global Constraints 收敛清单。

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| service.ts 改造面大（旧约 600 行，25 个 IPC 通道） | 规则化映射（旧 ipcMain → ctx.registerIpc），M2-S2 用插件级测试兜底 |
| 工具 id 与规范前缀不一致 | M5-S1 测试断言 `novelai_` 前缀，不一致则统一改名 |
| 翻译功能依赖上游 vendors | 注入 `llm.translateText`，插件不直接 import 上游内部模块 |
| Gateway 未运行 | 插件/UI 正常工作，仅生成类接口报错；文档明示外部运行前提 |
| renderer 页面与上游合并冲突 | 仅 vite.config.ts 一处入口追加，页面整体新增于 `src/renderer/novelai/` |
