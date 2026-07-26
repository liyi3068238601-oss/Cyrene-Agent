// 工具调用诊断日志 —— 将 Action Gate / 工具执行的完整流程写入文件
// 写入位置：userData/tool-call-errors.log

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

let cachedLogPath: string | null = null;

function getLogPath(): string {
  if (cachedLogPath) return cachedLogPath;
  let userData: string;
  try {
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

/** 通用诊断日志：记录 Action Gate / agent-graph 的关键决策步骤 */
export function traceToolCall(stage: string, message: string, details?: unknown): void {
  try {
    const now = new Date().toISOString();
    const detailStr = details !== undefined
      ? typeof details === "string"
        ? details
        : JSON.stringify(details, null, 2).slice(0, 2000)
      : "";
    const lines = [
      `[${now}] [${stage}] ${message}`,
      ...(detailStr ? [detailStr] : []),
    ];
    fs.appendFileSync(getLogPath(), lines.join("\n") + "\n", "utf8");
  } catch {
    // silent
  }
}
