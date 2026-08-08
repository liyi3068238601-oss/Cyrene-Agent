# Cyrene 一键启动 BAT Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把现有 `start.bat` 改成不依赖全局 `cyrene` 命令、带中文环境检查的一键启动文件。

**Architecture:** BAT 先检查 npm、依赖目录和主程序构建产物，再调用项目自己的 `npm.cmd start`。Vitest 读取 BAT 文本，固定关键检查与错误处理，防止以后退回依赖全局命令的旧写法。

**Tech Stack:** Windows Batch / npm / Vitest 4。

## Global Constraints

- 只修改 `start.bat`，新增一个静态契约测试。
- 不自动安装依赖或自动构建。
- 使用 TDD，先确认新测试在旧 BAT 上失败。
- 代码和施工记录分别提交。

---

### Task 1: 用失败测试定义一键启动契约

**Files:**
- Create: `scripts/start-bat.test.ts`
- Test: `scripts/start-bat.test.ts`

**Interfaces:**
- Consumes: 根目录 `start.bat` 文本。
- Produces: 一键启动行为的自动回归检查。

- [ ] **Step 1: 写失败测试**

```ts
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(path.join(process.cwd(), "start.bat"), "utf8");

describe("start.bat", () => {
  it("检查本地环境并通过 npm.cmd 启动", () => {
    expect(source).toContain("where npm.cmd");
    expect(source).toContain('if not exist "node_modules\\"');
    expect(source).toContain('if not exist "dist\\main\\main\\index.js"');
    expect(source).toContain("call npm.cmd start");
    expect(source).not.toContain("cyrene run");
  });

  it("启动失败时保留错误码并暂停窗口", () => {
    expect(source).toContain('set "CYRENE_EXIT_CODE=%ERRORLEVEL%"');
    expect(source).toContain("pause");
    expect(source).toContain("exit /b %CYRENE_EXIT_CODE%");
  });
});
```

- [ ] **Step 2: 确认 RED**

Run: `npm.cmd test -- scripts/start-bat.test.ts`

Expected: 旧 BAT 缺少 `where npm.cmd`、环境目录检查和 `npm.cmd start`，测试失败。

---

### Task 2: 实现并验证一键启动 BAT

**Files:**
- Modify: `start.bat`
- Test: `scripts/start-bat.test.ts`

**Interfaces:**
- Produces: 可双击启动、能给新手中文提示的 `start.bat`。

- [ ] **Step 1: 写最小实现**

```bat
@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

where npm.cmd >nul 2>nul
if errorlevel 1 (
    echo [错误] 未找到 npm，请先安装 Node.js 24。
    echo 安装完成后，请重新双击 start.bat。
    pause
    exit /b 1
)

if not exist "node_modules\" (
    echo [提示] 项目依赖尚未安装。
    echo 请先双击 setup.bat 完成初始化，然后再运行 start.bat。
    pause
    exit /b 1
)

if not exist "dist\main\main\index.js" (
    echo [提示] 项目尚未构建。
    echo 请先双击 setup.bat 完成初始化，然后再运行 start.bat。
    pause
    exit /b 1
)

echo [Cyrene] 正在启动...
call npm.cmd start
set "CYRENE_EXIT_CODE=%ERRORLEVEL%"

if not "%CYRENE_EXIT_CODE%"=="0" (
    echo.
    echo [错误] Cyrene 启动失败，错误码：%CYRENE_EXIT_CODE%
    pause
)

exit /b %CYRENE_EXIT_CODE%
```

- [ ] **Step 2: 确认 GREEN**

Run: `npm.cmd test -- scripts/start-bat.test.ts`

Expected: 2 个测试全部通过。

- [ ] **Step 3: 运行相关回归**

Run: `npm.cmd test -- scripts/start-bat.test.ts src/plugins`

Expected: BAT 测试与插件专项全部通过。

- [ ] **Step 4: 提交实现**

```bash
git add start.bat scripts/start-bat.test.ts
git commit -m "feat(startup): 添加新手友好的一键启动 BAT"
```

- [ ] **Step 5: 回填计划并提交文档**

勾选全部步骤，追加 RED/GREEN 与提交 hash 记录，然后执行：

```bash
git add docs/superpowers/plans/2026-08-08-one-click-start-bat.md
git commit -m "docs(startup): 回填一键启动 BAT 施工记录"
```
