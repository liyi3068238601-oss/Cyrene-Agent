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
