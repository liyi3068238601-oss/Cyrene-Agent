# Cyrene 启动前自动构建 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `start.bat` 每次双击启动时先完整构建当前源码，构建成功后才启动 Cyrene。

**Architecture:** 保留现有 npm 与依赖检查，在启动命令前插入 `npm.cmd run build`。BAT 分别保存构建和启动错误码，构建失败时暂停并退出，禁止启动旧 `dist`；Vitest 静态契约测试固定命令顺序与错误分支。

**Tech Stack:** Windows Batch / npm / Vitest 4。

## Global Constraints

- 每次启动都执行完整构建，不做时间戳或增量判断。
- 不修改 `setup.bat`、npm scripts、应用源码或依赖版本。
- 不自动执行 `npm install`；缺少 `node_modules` 时仍提示先运行 `setup.bat`。
- 保留 `*.bat` 的 CRLF 换行。
- 使用 TDD：先看到新契约测试在旧 BAT 上按预期失败，再修改 `start.bat`。
- 不提交现有的 `dist/renderer/react/index.html` 用户改动。

---

### Task 1: 用失败测试定义“先构建、后启动”契约

**Files:**
- Modify: `src/shared/start-bat.test.ts`
- Test: `src/shared/start-bat.test.ts`

**Interfaces:**
- Consumes: 根目录 `start.bat` 文本。
- Produces: 构建命令顺序与构建失败处理的静态契约。

- [x] **Step 1: 写失败测试**

在现有 `describe("start.bat")` 中追加：

```ts
it("每次启动前先完整构建，构建失败时不启动旧产物", () => {
  const buildCommand = "call npm.cmd run build";
  const startCommand = "call npm.cmd start";
  expect(source).toContain(buildCommand);
  expect(source.indexOf(buildCommand)).toBeLessThan(source.indexOf(startCommand));
  expect(source).toContain('set "CYRENE_BUILD_EXIT_CODE=%ERRORLEVEL%"');
  expect(source).toContain('if not "%CYRENE_BUILD_EXIT_CODE%"=="0" goto build_failed');
  expect(source).toContain(":build_failed");
  expect(source).toContain("exit /b %CYRENE_BUILD_EXIT_CODE%");
});
```

- [x] **Step 2: 运行测试并确认 RED**

Run: `npm.cmd test -- src/shared/start-bat.test.ts`

Expected: 新测试 FAIL，明确报告旧 BAT 不包含 `call npm.cmd run build`。

---

### Task 2: 实现启动前完整构建与错误处理

**Files:**
- Modify: `start.bat`
- Test: `src/shared/start-bat.test.ts`

**Interfaces:**
- Consumes: 已安装的 `npm.cmd` 与项目 `node_modules`。
- Produces: 构建成功才执行 `npm.cmd start` 的双击启动流程。

- [x] **Step 1: 写最小 BAT 实现**

在依赖检查后、启动命令前执行：

```bat
echo [Cyrene] 正在重新构建，请稍候...
call npm.cmd run build
set "CYRENE_BUILD_EXIT_CODE=%ERRORLEVEL%"
if not "%CYRENE_BUILD_EXIT_CODE%"=="0" goto build_failed

echo [Cyrene] 构建完成，正在启动...
call npm.cmd start
```

用以下分支处理构建失败：

```bat
:build_failed
echo.
echo [错误] Cyrene 构建失败，错误码：%CYRENE_BUILD_EXIT_CODE%
echo 请根据上方错误信息修复后，再重新双击 start.bat。
pause
exit /b %CYRENE_BUILD_EXIT_CODE%
```

删除旧的 `dist\main\main\index.js` 存在性检查及 `:build_missing` 分支，因为完整构建会创建产物，并直接报告真实构建错误。

- [x] **Step 2: 运行专项测试并确认 GREEN**

Run: `npm.cmd test -- src/shared/start-bat.test.ts`

Expected: 4 个测试全部 PASS，CRLF 约束仍通过。

- [x] **Step 3: 提交实现**

```bash
git add start.bat src/shared/start-bat.test.ts
git commit -m "feat(startup): 启动前自动完整构建"
```

---

### Task 3: 构建、回归与施工记录

**Files:**
- Modify: `docs/superpowers/plans/2026-08-08-one-click-start-bat.md`
- Modify: `docs/superpowers/plans/2026-08-08-start-bat-always-build.md`

**Interfaces:**
- Consumes: Task 2 的新启动流程。
- Produces: NovelAI 构建产物、全量回归证据与可追溯施工记录。

- [x] **Step 1: 运行完整构建并核对 NovelAI 产物**

Run: `npm.cmd run build`

Expected: exit 0，且以下文件存在：

```text
dist/main/plugins/novelai/manifest.json
dist/main/plugins/novelai/index.js
dist/renderer/novelai/index.html
```

- [x] **Step 2: 运行全量测试**

Run: `npm.cmd test`

Expected: 全量测试无失败；数量以实际输出为准。

- [x] **Step 3: 回填施工记录**

在原一键启动计划末尾追加“启动前自动构建改造”小节，记录 RED、GREEN、完整构建、NovelAI 产物、全量测试与实现提交 hash；同时勾选本计划全部步骤。

- [ ] **Step 4: 提交文档并推送**

```bash
git add docs/superpowers/plans/2026-08-08-one-click-start-bat.md docs/superpowers/plans/2026-08-08-start-bat-always-build.md
git commit -m "docs(startup): 记录启动前自动构建施工结果"
git push fork liyi-Cyrene-v2
```
