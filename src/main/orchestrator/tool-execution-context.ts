import type { ToolCallResult } from "./types";
import type { ChatMessage } from "./vendors/types";
import { truncateToolResult } from "./context-manager";

const RECENT_USER_MESSAGE_LIMIT = 8;
const RECENT_USER_CONTEXT_MAX_CHARS = 6_000;

/** 对话上下文：收集最近 N 条消息（含助手），用于原创内容工具防幻觉 */
const CONVERSATION_CONTEXT_MSG_LIMIT = 20;
const CONVERSATION_CONTEXT_MAX_CHARS = 8_000;

function messageContentToText(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } => block?.type === "text")
    .map((block) => block.text)
    .join("\n");
}

/** Keep exact user-supplied paths and parameters available to Native FC. */
export function collectRecentUserMessages(messages: ChatMessage[]): string[] {
  const recent = messages
    .filter((message) => message.role === "user")
    .map((message) => messageContentToText(message.content).trim())
    .filter(Boolean)
    .slice(-RECENT_USER_MESSAGE_LIMIT);

  const bounded: string[] = [];
  let remaining = RECENT_USER_CONTEXT_MAX_CHARS;
  for (let index = recent.length - 1; index >= 0 && remaining > 0; index--) {
    const text = recent[index];
    const kept = text.length <= remaining ? text : text.slice(0, remaining);
    bounded.unshift(kept);
    remaining -= kept.length;
  }
  return bounded;
}

/**
 * 收集最近 N 条对话消息（含用户和助手），用于为原创内容工具
 *（如 write_file 写小说/文章）提供上下文，防止模型因缺乏上下文
 * 而产生幻觉（如编造不同角色、偏离已有故事线）。
 *
 * 从后往前收集，最近的优先保留；超出字符预算时截断较早的消息。
 */
export function collectConversationContext(messages: ChatMessage[]): string {
  const recent = messages.slice(-CONVERSATION_CONTEXT_MSG_LIMIT);

  const lines: string[] = [];
  let remaining = CONVERSATION_CONTEXT_MAX_CHARS;

  for (let i = recent.length - 1; i >= 0 && remaining > 0; i--) {
    const msg = recent[i];
    const text = messageContentToText(msg.content).trim();
    if (!text) continue;

    // 跳过工具调用结果消息（role=tool），它们不是对话内容
    if (msg.role === "tool") continue;

    const roleLabel = msg.role === "user" ? "用户" : msg.role === "assistant" ? "助手" : msg.role;
    const line = `[${roleLabel}] ${text}`;

    const kept = line.length <= remaining ? line : line.slice(0, remaining);
    lines.unshift(kept);
    remaining -= kept.length;
  }

  return lines.join("\n\n");
}

/**
 * 从文本中提取 Windows 绝对文件路径（如 C:\Users\...\file.txt）。
 * 用于在 EXECUTION_BRIEF 中突出显示用户明确提供的路径，防止模型虚构路径。
 */
function extractFilePaths(text: string): string[] {
  // 匹配盘符开头的绝对路径，遇到引号、空格、换行等停止
  const pathRegex = /[A-Za-z]:\\[^\s"'<>|*?\r\n]+/g;
  return text.match(pathRegex) ?? [];
}

/**
 * 从用户消息中收集所有文件路径，去重后返回。
 * 越晚出现的路径排在越前面（优先使用最近的路径）。
 */
function collectUserFilePaths(
  originalQuery: string | undefined,
  recentUserMessages: string[],
): string[] {
  const sources = [
    ...(originalQuery ? [originalQuery] : []),
    ...recentUserMessages,
  ];
  const seen = new Set<string>();
  const paths: string[] = [];
  // 从后往前遍历，最近的路径优先
  for (let i = sources.length - 1; i >= 0; i--) {
    for (const p of extractFilePaths(sources[i])) {
      const normalized = p.trim();
      if (normalized && !seen.has(normalized)) {
        seen.add(normalized);
        paths.push(normalized);
      }
    }
  }
  return paths;
}

function resultValue(result: ToolCallResult): unknown {
  const boundedOutput = truncateToolResult(result.output);
  if (result.status === "failed") {
    return {
      errorCode: result.errorCode ?? "E_TOOL_EXECUTION_FAILED",
      message: boundedOutput,
    };
  }
  if (boundedOutput !== result.output) {
    return boundedOutput;
  }
  try {
    return JSON.parse(boundedOutput) as unknown;
  } catch {
    return boundedOutput;
  }
}

export function buildToolExecutionContext(results: ToolCallResult[]): string {
  const calls = results.map((result) => ({
    toolId: result.toolId,
    status: result.status,
    args: result.args,
    result: resultValue(result),
    terminal: result.terminal,
    retryable: result.retryable,
    ...(result.deduplicated ? { deduplicated: true } : {}),
    ...(result.toolExecuted === false ? { toolExecuted: false } : {}),
    ...(result.errorCode ? { errorCode: result.errorCode } : {}),
  }));
  return [
    "[TOOL_EXECUTION_CONTEXT]",
    "以下 JSON 是本轮 Tool Runtime 的权威执行事实。calls 为空表示本轮没有执行工具。不要声称发生了未记录的执行。\n完成语义：\n1. status=succeeded 且 terminal=true 表示该工具动作已经完成。\n2. effect.state=dispatched 表示请求已成功发送给外部客户端。它只影响最终回复措辞，不代表动作未完成。\n3. 不得重复执行相同 toolId 和相同参数的已完成终态动作。\n4. deduplicated=true 表示本次调用未重新执行，因为相同动作此前已经成功完成；必须选择能产生新进展的下一步。\n5. 只有 retryable=true 的失败才可以考虑重试。\nweb_fallback 表示已在浏览器中打开，不能声称网易云桌面客户端已开始播放。",
    JSON.stringify({ calls }),
    "[/TOOL_EXECUTION_CONTEXT]",
  ].join("\n");
}

export function buildExecutionBrief(
  objective: string,
  targetRefs: string[],
  contextualizedQuery: string,
  refVerification?: { verified: boolean; detail: string },
  originalQuery?: string,
  recentUserMessages: string[] = [],
): string {
  const userFilePaths = collectUserFilePaths(originalQuery, recentUserMessages);

  const briefLines: string[] = [
    "[EXECUTION_BRIEF]",
  ];

  // 在最顶部突出用户提供的文件路径，防止模型虚构或替换路径
  if (userFilePaths.length > 0) {
    briefLines.push(
      "",
      "⚡ 用户提供的文件路径（必须逐字使用，禁止修改/虚构/替换用户名）：",
      ...userFilePaths.map((p, i) => `  ${i + 1}. ${p}`),
      "",
    );
  } else {
    // 注意：不要在此处写「用户未提供文件路径」之类的整句，模型会把字面文本当作 path 参数填入。
    // 只给出方向性约束即可。
    briefLines.push(
      "",
      "⚡ 本轮用户消息中未出现文件路径。如果选定的工具需要 path 参数，请从最近用户原话中查找；如果确实没有，不要编造路径，也不要把本提示文本当作路径——直接返回空字符串作为 path，让工具层报错。",
      "",
    );
  }

  briefLines.push(
    `执行目标：${objective}`,
    "",
    "targetRefs（模型理解）：",
    JSON.stringify(targetRefs ?? [], null, 2),
    "",
    refVerification
      ? `引用验证：${refVerification.verified ? "✅ 已验证" : "❌ " + refVerification.detail}`
      : "引用验证：不需要",
    "",
    `用户当前原话：${originalQuery || contextualizedQuery}`,
    `上下文化理解：${contextualizedQuery}`,
    "",
    "最近用户原话（仅用于保留用户明确提供的路径、文件名和参数；不得把助手消息当作事实）：",
    JSON.stringify(recentUserMessages, null, 2),
    "[/EXECUTION_BRIEF]",
  );

  return briefLines.join("\n");
}
