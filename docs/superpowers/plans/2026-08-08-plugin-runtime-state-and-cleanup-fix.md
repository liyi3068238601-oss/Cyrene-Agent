# 插件运行状态与完整卸载修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让插件列表显示真实运行状态，并确保禁用插件时等待渠道适配器完全停止。

**Architecture:** `PluginManager.instances` 作为实际运行状态的唯一依据；持久化的 `enabledMap` 只表示下次启动偏好。`PluginContext.dispose()` 返回 Promise，所有管理器清理路径都等待它结束。

**Tech Stack:** TypeScript 5.6 / Electron 43 / Vitest 4。

## Global Constraints

- 不新增依赖，不修改插件 manifest 或 renderer API。
- 使用 TDD：新测试必须先在旧实现上按预期失败。
- 不改动现有无关的 `dist/renderer/react/index.html`。
- 代码提交与施工日志提交分开。

---

### Task 1: 用失败测试复现两个问题

**Files:**
- Modify: `src/plugins/manager.test.ts`
- Modify: `src/plugins/context.test.ts`

**Interfaces:**
- Consumes: `PluginManager.list()`、`PluginManager.setEnabled()`、`createContext()`。
- Produces: 两个可重复运行的回归测试。

- [ ] **Step 1: 写启动失败与重试测试**

在 `manager.test.ts` 把 Vitest import 增加 `vi`，并让 `afterEach` 调用 `vi.restoreAllMocks()`。新增测试：

```ts
it("启动失败后显示停用；再次启用会重试", async () => {
  const h = harness();
  writeFileSync(
    path.join(tmp, "demo", "index.cjs"),
    `let attempts = 0;
    module.exports = { register(ctx) {
      attempts += 1;
      if (attempts === 1) throw new Error("first start failed");
      ctx.registerIpc("ping", () => "pong");
    } };`,
    "utf8",
  );
  vi.spyOn(console, "error").mockImplementation(() => {});
  const mgr = new PluginManager(h.options);

  await mgr.start();
  expect(mgr.list()[0].enabled).toBe(false);

  const retried = await mgr.setEnabled("demo", true);
  expect(retried.ok).toBe(true);
  expect(mgr.list()[0].enabled).toBe(true);
  expect(h.ipc.has("plugin:demo:ping")).toBe(true);
});
```

- [ ] **Step 2: 写异步卸载测试**

在 `context.test.ts` 导入 `ChannelAdapter` 类型并新增测试：

```ts
it("dispose 返回 Promise 并等待渠道注销完成", async () => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "cyrene-ctx-test-"));
  const rt = runtime();
  let releaseUnregister!: () => void;
  let unregisterFinished = false;
  rt.channelManager.unregister = async () => {
    await new Promise<void>((resolve) => { releaseUnregister = resolve; });
    unregisterFinished = true;
    return true;
  };
  const adapter: ChannelAdapter = {
    id: "wechat",
    displayName: "test",
    capability: {
      text: true, image: false, audio: false, file: false,
      video: false, markdown: false, card: false, sticker: false,
      maxTextLength: 100,
    },
    start: async () => {},
    stop: async () => {},
    onMessage: null,
    send: async () => ({ ok: true }),
    getStatus: () => ({ enabled: true, phase: "running" }),
  };
  const ctx = createContext("demo", tmp, rt, ["channels"]);
  await ctx.registerChannelAdapter(adapter);

  const disposing = ctx.dispose();
  expect(disposing).toBeInstanceOf(Promise);
  expect(unregisterFinished).toBe(false);
  releaseUnregister();
  await disposing;
  expect(unregisterFinished).toBe(true);
});
```

- [ ] **Step 3: 运行测试确认 RED**

Run: `npm.cmd test -- src/plugins/manager.test.ts src/plugins/context.test.ts`

Expected: 状态测试得到 `true` 而不是 `false`；卸载测试得到 `undefined` 而不是 Promise。

---

### Task 2: 修复真实运行状态

**Files:**
- Modify: `src/plugins/manager.ts`
- Test: `src/plugins/manager.test.ts`

**Interfaces:**
- Consumes: `instances: Map<string, CyrenePlugin>`。
- Produces: `list().enabled` 表示插件是否真实运行；失败插件可通过 `setEnabled(id, true)` 重试。

- [ ] **Step 1: 修改列表状态来源**

将列表字段改为：

```ts
enabled: this.instances.has(r.manifest.id),
```

- [ ] **Step 2: 修改开关的幂等判断**

用真实运行状态判断是否需要启停，仅在目标状态和运行状态一致时直接返回：

```ts
const running = this.instances.has(id);
if (running === enabled) return { ok: true };
```

启停成功后仍写入 `enabledMap`，保持重启偏好。

- [ ] **Step 3: 运行管理器测试确认 GREEN**

Run: `npm.cmd test -- src/plugins/manager.test.ts`

Expected: 全部通过。

---

### Task 3: 修复异步渠道卸载

**Files:**
- Modify: `src/plugins/context.ts`
- Modify: `src/plugins/manager.ts`
- Test: `src/plugins/context.test.ts`

**Interfaces:**
- Produces: `dispose(): Promise<void>`。
- Consumed by: `activate()` 的失败回滚、`deactivate()`、`stop()`。

- [ ] **Step 1: 把 dispose 改为异步**

```ts
interface DisposableContext extends PluginContext {
  dispose(): Promise<void>;
}
```

同步清理 Tool、IPC、事件监听，然后等待所有渠道注销：

```ts
const adapterIds = Array.from(registeredAdapters);
registeredAdapters.clear();
await Promise.all(adapterIds.map((adapterId) => runtime.channelManager.unregister(adapterId)));
```

- [ ] **Step 2: 等待所有清理调用**

`activate()` 捕获注册异常时使用 `await ctx.dispose()`；`deactivate()` 的 `finally` 中先取得 context，再 `await context?.dispose()`，之后删除实例和上下文。

- [ ] **Step 3: 运行上下文和管理器测试确认 GREEN**

Run: `npm.cmd test -- src/plugins/context.test.ts src/plugins/manager.test.ts`

Expected: 全部通过。

- [ ] **Step 4: 提交代码**

```bash
git add src/plugins/context.ts src/plugins/context.test.ts src/plugins/manager.ts src/plugins/manager.test.ts
git commit -m "M5-S9 fix(plugins): 修正运行状态与异步渠道卸载"
```

---

### Task 4: 回归验证与施工日志

**Files:**
- Modify: `docs/superpowers/plans/2026-08-06-cyrene-plugin-system.md`
- Modify: `docs/superpowers/plans/2026-08-08-plugin-runtime-state-and-cleanup-fix.md`

**Interfaces:**
- Produces: 当前验证证据和可追溯提交记录。

- [ ] **Step 1: 运行插件专项测试**

Run: `npm.cmd test -- src/plugins`

Expected: 全部通过。

- [ ] **Step 2: 运行渠道相关测试**

Run: `npm.cmd test -- src/main/channels`

Expected: 全部通过。

- [ ] **Step 3: 运行构建**

Run separately:

```bash
npm.cmd run build:main
npm.cmd run build
```

Expected: 两条命令退出码均为 0。

- [ ] **Step 4: 更新施工日志**

在原插件系统施工日志追加 M5-S9，记录两个根因、测试 RED/GREEN 证据、验证结果和代码提交 hash；勾选本计划的全部步骤。

- [ ] **Step 5: 提交施工日志**

```bash
git add docs/superpowers/plans/2026-08-06-cyrene-plugin-system.md docs/superpowers/plans/2026-08-08-plugin-runtime-state-and-cleanup-fix.md
git commit -m "M5-S9 docs(plugins): 回填运行状态与卸载修复记录"
```
