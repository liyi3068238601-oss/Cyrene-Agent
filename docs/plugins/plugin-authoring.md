# Cyrene 插件开发规范（Plugin Authoring Guide）

> 适用范围：Cyrene-Agent 插件系统 v1。插件以「目录 + manifest.json + 入口文件」形态交付，应用启动时自动扫描加载；第三方插件为 JS 文件，内置插件为 TS 编译产物，两者契约完全一致。

## 1. 插件是什么

一个插件 = 一个目录，包含：

```text
userData/plugins/<id>/
  manifest.json   # 插件清单（必需）
  index.cjs       # 入口文件（manifest.entry 指定，支持 .cjs / .mjs / .js）
  ...其他文件
```

应用启动时 `PluginManager` 会扫描两个根目录：

- 内置插件：`dist/main/plugins/`（由 `src/plugins/*/` TS 源码编译并拷贝 manifest 生成）
- 用户插件：`userData/plugins/`（即 `%APPDATA%/live2d-cyrene/plugins/`，放进去即生效，无需改代码）

扫描规则：只收集**一级子目录**中带合法 `manifest.json` 的目录；manifest 不合法（id 非法、字段缺失、entry 文件不存在）的目录会被跳过并在控制台留警告。

## 2. manifest.json

字段表：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string | 是 | 唯一 id，`^[a-z0-9]+(-[a-z0-9]+)*$`，如 `novelai` |
| `name` | string | 是 | 显示名 |
| `version` | string | 是 | 版本号 |
| `description` | string | 是 | 一句话描述 |
| `author` | string | 是 | 作者 |
| `entry` | string | 是 | 插件目录内的**裸文件名**（不允许 `../` 或子目录路径），必须存在 |
| `defaultEnabled` | boolean | 否 | 默认是否启用，缺省视为 `true` |
| `deps` | string[] | 否 | 需要注入的主程序内部依赖白名单，v1 支持 `"channels"`、`"llm"` |

最小示例：

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

## 3. 入口契约

入口文件必须导出 `register(ctx)`，可选导出 `unregister()` 和 `open()`。`register` 在插件启用时调用一次；`unregister` 在插件禁用/退出前调用；`open` 供主程序通过受控入口打开插件窗口。

### 3.1 CJS（推荐，`index.cjs`）

```js
module.exports = {
  register(ctx) {
    ctx.log("插件已启用");
  },
  unregister() {
    ctx.log("插件已禁用");
  },
};
```

### 3.2 ESM（`index.mjs`）

```js
export function register(ctx) {
  ctx.log("插件已启用");
}

export function unregister() {
  ctx.log("插件已禁用");
}
```

> 加载器统一用动态 `import()` 加载，CJS 与 ESM 均支持；入口未导出 `register` 会被拒绝加载。

## 4. PluginContext API

`register(ctx)` 收到的 `ctx` 提供以下能力：

### 4.1 注册 LLM 工具 `registerTool(tool)`

把工具暴露给 LLM（复用主程序 `ToolRegistry`）。`tool` 为 `ToolDefinition`，关键字段：

| 字段 | 说明 |
|---|---|
| `id` | 唯一标识，**必须以 `<插件id>_` 开头**（如 `novelai_generate`），避免与内置工具冲突 |
| `name` / `description` | 展示名 / 一句话描述 |
| `enabled` | 是否启用 |
| `inputSchema` | 参数 JSON Schema（`{ type: "object", properties, required }`） |
| `execute(args, ctx?)` | 执行函数，返回 `Promise<string>` |

```js
ctx.registerTool({
  id: "my-plugin_hello",
  name: "问候",
  description: "返回一句问候语",
  enabled: true,
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "要问候的人" },
    },
    required: [],
  },
  execute: async (args) => `你好，${args.name ?? "朋友"}！`,
});
```

对应注销：`ctx.unregisterTool(id)`。

> 前缀为**强制约束**：不满足 `<插件id>_` 前缀的 `registerTool` 会直接抛错；若注册了已存在的工具 id，框架会打印冲突告警（覆盖行为由 ToolRegistry 决定）。

### 4.2 注册 IPC 通道 `registerIpc(channel, handler)`

通道会自动加 `plugin:<id>:` 前缀，杜绝与主程序其他通道冲突。例如插件 id 为 `my-plugin`、`registerIpc("ping", ...)` 实际注册的是 `plugin:my-plugin:ping`。

```js
ctx.registerIpc("ping", () => "pong");
ctx.registerIpc("add", (a, b) => Number(a) + Number(b));
```

> handler 在主进程执行，返回 Promise 或普通值；渲染进程通过 `ipcRenderer.invoke("plugin:my-plugin:ping")` 调用。

对应注销：`ctx.unregisterIpc(channel)`（会自动加前缀）。

### 4.3 注册渠道适配器 `registerChannelAdapter(adapter)`

把插件作为外部渠道接入（复用 `ChannelManager`）。需要满足 `ChannelAdapter` 接口（`id/displayName/capability/start/stop/onMessage/send/getStatus`），并在 manifest 声明 `"deps": ["channels"]`。

```json
{
  "id": "qq-napcat",
  "deps": ["channels"],
  "entry": "index.cjs"
}
```

```js
class QqAdapter {
  constructor() {
    this.id = "qq";
    this.displayName = "QQ";
    this.capability = {};
    this.onMessage = null;
  }
  async start() {}
  async stop() {}
  async send(msg) {
    return { ok: true };
  }
  getStatus() {
    return { started: true };
  }
}

module.exports = {
  register(ctx) {
    ctx.registerChannelAdapter(new QqAdapter());
  },
  unregister() {},
};
```

> 注意：`ChannelAdapter.id` 的类型受主程序 `ChannelId` 联合类型约束；目前主程序只内置 `"wechat" | "feishu"`，新增渠道（如 `"qq"`）需要主程序在 `src/main/channels/types.ts` 最小扩展。计划新增渠道前先确认。

### 4.4 私有存储 `ctx.storage`

插件数据落 `userData/plugins/<id>/`，每个 key 一个 JSON 文件：

```js
ctx.storage.set("config", { apiKey: "..." });
const config = ctx.storage.get("config");
ctx.storage.rootDir(); // userData/plugins/<id>
```

> key 必须匹配 `^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$`，否则抛错；写入采用临时文件 + rename 的原子写。

### 4.5 依赖注入 `ctx.deps`

插件**不得直接 import 主程序内部模块**（`src/main/**`、`src/shared/**`），需要主程序能力时：

- 通过 manifest `deps` 白名单声明；
- 由框架在 `register` 前注入到 `ctx.deps`；
- **白名单生效**：未在 `manifest.deps` 声明的依赖不会被注入；例如未声明 `"llm"` 时，`ctx.deps.llm` 为 `undefined`。
- `deps: ["channels"]` → `ctx.deps.channels.channelManager`（仅 `register/unregister/startOne` 三个方法）。
- `deps: ["llm"]` → `ctx.deps.llm.translateText(messages)`，使用主程序当前配置的聊天模型完成一次非流式文本请求。

```json
{
  "id": "novelai",
  "deps": ["channels", "llm"],
  "entry": "index.js"
}
```

> 插件应在调用前判断依赖是否存在，并给用户可理解的错误提示；不要绕过依赖白名单直接 import 主程序的模型实现。

### 4.6 日志 `ctx.log(...args)`

统一输出 `[plugin:<id>]` 前缀日志，便于与主程序日志区分。

## 5. 生命周期与启停

```text
应用启动
  └─ PluginManager.start()
      ├─ 扫描目录 + 校验 manifest
      ├─ enabled = 开关表[id] ?? manifest.defaultEnabled
      └─ 启用插件 → loadPlugin() → register(ctx)

设置面板切换开关（plugins:set-enabled）
  ├─ 启用 → register(ctx)
  └─ 停用 → unregister() → dispose()（自动清理已注册的工具/IPC/渠道）

应用退出
  └─ PluginManager.stop() → 逐个 unregister() + dispose()
```

开关状态持久化在 `app-settings.json` 的 `plugins` 字段（重启后保持）。

## 6. 带窗口/UI 的插件（v1 约定）

插件系统 v1 不提供 `rendererEntry` 机制，带 UI 的插件按以下模式实现（NovelAI 即范例）：

1. 渲染页面源码放 `src/renderer/<plugin-id>/`，在 `vite.config.ts` 的 `rollupOptions.input` 追加入口（属于主程序收敛清单内的允许改动）。
2. 插件入口导出可选的 `open()`；主程序只允许通过 `plugins:open` 打开已启用且确实提供 `open()` 的插件。设置页会为这类插件显示“打开”按钮。
3. 插件在 `register(ctx)` 中注册窗口内部需要的 IPC（如 `plugin:novelai:open-workbench`）。
4. 插件自己在主进程创建 `BrowserWindow`，`webPreferences.preload` 指向插件自带 preload（编译到 `dist/main/plugins/<id>/preload.js`），由 preload 用 `ipcRenderer` 桥接 `window.<插件名>` API 与 `plugin:<id>:*` 通道。
5. 窗口生命周期（创建/关闭/防重复）由插件自行管理，`unregister()` 中关闭窗口。

插件代码运行在主进程，允许直接使用 Node 内置模块与 Electron 模块（`BrowserWindow`、`dialog`、`shell`、`safeStorage` 等）；约束仅限于「不直接 import 主程序内部业务模块」。

## 7. 内置插件（TS）与用户插件（JS）

**内置插件**：源码放 `src/plugins/<id>/`（`manifest.json` + `index.ts` 等），随 `npm run build:main` 编译到 `dist/main/plugins/<id>/`（manifest 自动拷贝）。适合随项目维护、需要 TS 类型与单测的插件（NovelAI、QQ）。

**用户插件**：JS 文件直接放 `userData/plugins/<id>/`，无需编译。适合第三方按本规范交付的插件。

## 8. 调试与验证

```bash
# 单测（插件框架）
npx vitest run src/plugins

# 构建（含内置插件编译与 manifest 拷贝）
npm run build:main

# 启动应用看加载日志
node dist/cli/index.js run
```

验证点：

- 控制台出现 `[plugins] 已启用 <id>@<version>`；
- 设置面板「功能插件」页出现该插件，开关可启停；
- 工具生效：`registerTool` 后 LLM 工具列表可见；
- IPC 生效：`ipcRenderer.invoke("plugin:<id>:<channel>")` 有响应；
- 提供 `open()` 的插件可从设置页打开；禁用后窗口关闭，上述通道/工具消失。

## 9. 安全边界

`userData/plugins/` 中的插件在主进程执行任意代码，拥有与主程序相同的权限。因此：

- 只安装可信来源的插件；
- 不要把共享目录/他人可写的目录设为插件目录；
- 插件不应被设计为接收不可信外部输入并自动执行（如无确认的远程代码）；
- 涉及网络/文件写入的插件行为应在插件描述中明示。

## 10. 插件自检清单

1. 目录名、manifest `id`、工具 id 前缀三者一致。
2. `manifest.json` 字段完整，`entry` 为目录内的裸文件名且指向存在的文件。
3. 入口导出 `register(ctx)`；有清理逻辑时导出 `unregister()`。
4. 工具 id 以 `<插件id>_` 开头，`inputSchema` 与 `execute` 匹配。
5. IPC 通道不重复注册；统一用 `ctx.registerIpc`（自动前缀）。
6. 渠道插件声明 `deps: ["channels"]`，并确认主程序 `ChannelId` 已包含对应渠道。
7. 不直接 import `src/main/**`、`src/shared/**` 内部模块；需要的能力走 `deps` 白名单；使用主模型时声明 `deps: ["llm"]`。
8. 数据写入 `ctx.storage`，不散落到其他 userData 位置。
9. `unregister()` 关闭窗口/停止后台任务；框架 dispose 会兜底清理工具与 IPC。
10. 带窗口插件导出 `open()`，并确认设置页只在插件启用时提供“打开”。
11. 按 §8 完成验证：加载日志、设置面板开关、工具/IPC 生效、禁用后清理。
