// 工具调用错误日志 —— 将 HTTP 错误请求/响应写入文件，便于诊断
// 写入位置：userData/tool-call-errors.log

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

let cachedLogPath: string | null = null;

function getLogPath(): string {
  if (cachedLogPath) return cachedLogPath;
  // Electron app.getPath 在 main 进程可用；非 Electron 环境用 OS tmp
  let userData: string;
  try {
    // 动态 require 避免 renderer 侧加载报错
    const electron = require("electron");
    userData = electron.app?.getPath("userData") ?? os.tmpdir();
  } catch {
    userData = path.join(
      process.env.APPDATA ?? process.env.HOME ?? os.tmpdir(),
      "live2d-cyrene",
    );
  }
  cachedLogPath = path.join(userData, "tool-call-errors.log");
  return cachedLogPath;
}

export interface ToolCallErrorEntry {
  stage: string;
  adapterId: string;
  httpStatus: number;
  responseBody: string;
  requestBodySummary: string;
}

export function appendToolCallErrorLog(entry: ToolCallErrorEntry): void {
  try {
    const now = new Date().toISOString();
    const lines = [
      "=".repeat(80),
      `[${now}] stage=${entry.stage} adapter=${entry.adapterId} status=${entry.httpStatus}`,
      `--- request summary ---`,
      entry.requestBodySummary,
      `--- response body (first 1000 chars) ---`,
      entry.responseBody || "(empty)",
      "=".repeat(80),
      "",
    ];
    fs.appendFileSync(getLogPath(), lines.join("\n"), "utf8");
  } catch {
    // silent
  }
}
