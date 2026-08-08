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
- Create: `src/shared/start-bat.test.ts`
- Test: `src/shared/start-bat.test.ts`

**Interfaces:**
- Consumes: 根目录 `start.bat` 文本。
- Produces: 一键启动行为的自动回归检查。

- [x] **Step 1: 写失败测试**

```ts
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(path.join(process.cwd(), "start.bat"), "utf8");

describe("start.bat", () => {
  it("使用 Windows CRLF 换行，避免 CMD 拆坏中文命令", () => {
    expect(source).toContain("\r\n");
    expect(source.replaceAll("\r\n", "")).not.toContain("\n");
  });

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

- [x] **Step 2: 确认 RED**

Run: `npm.cmd test -- src/shared/start-bat.test.ts`

Expected: 旧 BAT 缺少 `where npm.cmd`、环境目录检查和 `npm.cmd start`，测试失败。

---

### Task 2: 实现并验证一键启动 BAT

**Files:**
- Create: `.gitattributes`
- Modify: `start.bat`
- Test: `src/shared/start-bat.test.ts`

**Interfaces:**
- Produces: 可双击启动、能给新手中文提示的 `start.bat`。

- [x] **Step 1: 写最小实现**

```bat
@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

where npm.cmd >nul 2>nul
if errorlevel 1 goto npm_missing

if not exist "node_modules\" goto dependencies_missing

if not exist "dist\main\main\index.js" goto build_missing

echo [Cyrene] 正在启动...
call npm.cmd start
set "CYRENE_EXIT_CODE=%ERRORLEVEL%"
if not "%CYRENE_EXIT_CODE%"=="0" goto start_failed
exit /b 0

:npm_missing
echo [错误] 未找到 npm，请先安装 Node.js 24。
echo 安装完成后，请重新双击 start.bat。
pause
exit /b 1

:dependencies_missing
echo [提示] 项目依赖尚未安装。
echo 请先双击 setup.bat 完成初始化，然后再运行 start.bat。
pause
exit /b 1

:build_missing
echo [提示] 项目尚未构建。
echo 请先双击 setup.bat 完成初始化，然后再运行 start.bat。
pause
exit /b 1

:start_failed
echo.
echo [错误] Cyrene 启动失败，错误码：%CYRENE_EXIT_CODE%
pause
exit /b %CYRENE_EXIT_CODE%
```

并新增：

```gitattributes
*.bat text eol=crlf
```

- [x] **Step 2: 确认 GREEN**

Run: `npm.cmd test -- src/shared/start-bat.test.ts`

Expected: 3 个测试全部通过。

- [x] **Step 3: 运行相关回归**

Run: `npm.cmd test -- src/shared/start-bat.test.ts src/plugins`

Expected: BAT 测试与插件专项全部通过。

- [x] **Step 4: 提交实现**

```bash
git add .gitattributes start.bat src/shared/start-bat.test.ts
git commit -m "feat(startup): 添加新手友好的一键启动 BAT"
```

- [x] **Step 5: 回填计划并提交文档**

勾选全部步骤，追加 RED/GREEN 与提交 hash 记录，然后执行：

```bash
git add docs/superpowers/plans/2026-08-08-one-click-start-bat.md
git commit -m "docs(startup): 回填一键启动 BAT 施工记录"
```

## 执行记录

- 原计划把测试放在 `scripts/`；实测发现 Vitest 不收集该目录的一般测试，因此按现有 include 规则移到 `src/shared/start-bat.test.ts`。
- RED 1：旧 BAT 缺少 npm、依赖和构建检查，2 个契约测试按预期失败。
- 真实 CMD 模拟发现 LF 换行会拆坏中文命令；新增 CRLF 测试后在旧格式上按预期失败。
- 修复：BAT 改用标签跳转，新增 `.gitattributes` 固定 `*.bat` 为 CRLF。
- GREEN：BAT 测试 3/3 通过；BAT + 插件相关回归 25/25 通过。
- 手工模拟：缺少依赖和缺少构建产物两条路径均显示正确中文提示并以错误码 1 退出。
- 实现提交：`6303af7 feat(startup): 添加新手友好的一键启动 BAT`。
