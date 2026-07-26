// 对话摘要器 —— 当历史消息过长时，用 LLM 把较早的轮次压缩成摘要，
// 作为 system 消息注入上下文，保留最近若干轮完整对话。
//
// 设计要点：
//   - 摘要生成是异步 fire-and-forget：当前对话用已有缓存（零延迟），
//     摘要在后台生成后供下次对话使用。
//   - 缓存持久化到 <userData>/cyrene-chats/summaries/<sessionId>.json
//   - 消息数变化超过 RE_SUMMARY_DELTA 才重新生成，避免每轮都调 LLM。
//   - 摘要失败时 graceful fallback：直接用原始消息，不阻断对话。
//
// 阈值设计（基于前端 slice(-150) 的 150 条消息窗口）：
//   SUMMARY_THRESHOLD = 60   → 超过 60 条（30 轮）开始摘要
//   KEEP_RECENT = 30         → 保留最近 30 条（15 轮）完整
//   RE_SUMMARY_DELTA = 10    → 消息数变化超 10 条才重新生成摘要

import * as fs from "fs";
import * as path from "path";
import { app } from "electron";
import { getAdapterForConfig } from "./vendors";
import type { ChatMessage, VendorConfig } from "./vendors";
import { recordUsage } from "../token-usage-store";

const LOG_PREFIX = "[ConversationSummarizer]";

const SUMMARY_THRESHOLD = 60;
const KEEP_RECENT = 30;
const RE_SUMMARY_DELTA = 10;
const SUMMARY_TIMEOUT_MS = 60_000;
const MAX_SUMMARY_INPUT_CHARS = 200_000;
const PER_MESSAGE_TRUNCATE = 800;

/** 摘要缓存结构 */
interface SummaryCache {
  summary: string;
  messageCount: number;
  updatedAt: number;
}

/** 正在生成摘要的 session 集合（防止并发） */
const summarizingSessions = new Set<string>();

// ─── 缓存读写 ───────────────────────────────────────────

function summariesDir(): string {
  return path.join(app.getPath("userData"), "cyrene-chats", "summaries");
}

function cachePath(sessionId: string): string {
  // sanitize sessionId 防止路径穿越
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(summariesDir(), safe + ".json");
}

function readCache(sessionId: string): SummaryCache | null {
  try {
    const p = cachePath(sessionId);
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, "utf8");
    const parsed = JSON.parse(raw) as Partial<SummaryCache>;
    if (
      typeof parsed.summary !== "string" ||
      typeof parsed.messageCount !== "number" ||
      typeof parsed.updatedAt !== "number"
    ) {
      return null;
    }
    return parsed as SummaryCache;
  } catch {
    return null;
  }
}

function writeCache(sessionId: string, cache: SummaryCache): void {
  try {
    const dir = summariesDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const p = cachePath(sessionId);
    const tmp = p + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), "utf8");
    fs.renameSync(tmp, p);
  } catch (err) {
    console.warn(LOG_PREFIX, "缓存写入失败:", err);
  }
}

// ─── 消息工具 ───────────────────────────────────────────

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (block && typeof block === "object" && (block as { type?: unknown }).type === "text") {
          return String((block as { text?: unknown }).text ?? "");
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return String(content ?? "");
}

function stripThinkBlocks(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<think>[\s\S]*$/gi, "")
    .trim();
}

/**
 * 把要摘要的消息格式化成纯文本。每条消息截断到 PER_MESSAGE_TRUNCATE 字符，
 * 总长度不超过 MAX_SUMMARY_INPUT_CHARS。
 */
function formatMessagesForSummary(messages: ChatMessage[]): string {
  const lines: string[] = [];
  let totalLen = 0;
  for (const m of messages) {
    const role =
      m.role === "user" ? "用户" :
      m.role === "assistant" ? "昔涟" :
      m.role === "tool" ? "工具结果" :
      "系统";
    let content = contentToText(m.content);
    if (content.length > PER_MESSAGE_TRUNCATE) {
      content = content.slice(0, PER_MESSAGE_TRUNCATE) + "…";
    }
    const line = `[${role}] ${content}`;
    if (totalLen + line.length > MAX_SUMMARY_INPUT_CHARS) {
      lines.push("[… 更早的对话已省略 …]");
      break;
    }
    lines.push(line);
    totalLen += line.length;
  }
  return lines.join("\n");
}

// ─── 摘要生成 ───────────────────────────────────────────

const SUMMARIZER_SYSTEM_PROMPT = `你是对话摘要助手。请将以下对话历史压缩成一段简洁的摘要。

要求：
1. 保留关键事实、决定和承诺
2. 保留用户的核心需求、偏好和重要信息（人名、项目、时间线、技术细节等）
3. 保留未完成的任务或待办事项
4. 保留昔涟（Cyrene）的人格状态和情绪线索（如果有）
5. 用第三人称叙述，中文输出
6. 控制在 800 字以内
7. 不要加入新的信息或推测
8. 按时间顺序组织，最近的重要信息放后面

只输出摘要正文，不要加前缀、标题或任何说明性文字。`;

async function generateSummary(
  messagesToSummarize: ChatMessage[],
  cfg: VendorConfig,
): Promise<string> {
  const adapter = getAdapterForConfig(cfg);
  const conversationText = formatMessagesForSummary(messagesToSummarize);

  const llmMessages: ChatMessage[] = [
    { role: "system", content: SUMMARIZER_SYSTEM_PROMPT },
    { role: "user", content: `请摘要以下对话：\n\n---\n${conversationText}\n---` },
  ];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SUMMARY_TIMEOUT_MS);

  try {
    const http = adapter.buildRequest(
      {
        model: cfg.model,
        messages: llmMessages,
        maxTokens: 2000,
        stream: false,
      },
      cfg,
    );

    const response = await fetch(http.url, {
      method: "POST",
      signal: controller.signal,
      headers: http.headers,
      body: http.body,
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({})) as Record<string, unknown>;
      const errMsg = (errorData as { error?: { message?: string } }).error?.message;
      throw new Error(errMsg || `摘要 LLM 请求失败：HTTP ${response.status}`);
    }

    const data = await response.json();
    const parsed = adapter.parseResponse(data);

    if (parsed.usage) {
      recordUsage(parsed.usage.input, parsed.usage.output, 1);
    }

    const summary = stripThinkBlocks(parsed.text ?? "");
    if (!summary) {
      throw new Error("摘要 LLM 返回空内容");
    }
    return summary;
  } finally {
    clearTimeout(timer);
  }
}

// ─── 公开 API ───────────────────────────────────────────

/**
 * 把摘要应用到消息数组：用摘要 system 消息替换被摘要的旧消息。
 * 返回新数组：[summary_system, ...recent_messages]
 */
export function applySummaryToMessages(
  messages: ChatMessage[],
  summary: string,
  keepRecent: number = KEEP_RECENT,
): ChatMessage[] {
  if (messages.length <= keepRecent) return messages;
  const splitIndex = messages.length - keepRecent;
  return [
    {
      role: "system",
      content: `【对话历史摘要】\n以下是之前对话的摘要，供你理解上下文参考：\n\n${summary}`,
    },
    ...messages.slice(splitIndex),
  ];
}

/**
 * 读取缓存的摘要并应用到消息（如果缓存有效）。
 * 这是同步操作，无 LLM 调用，零延迟。
 */
export function applyCachedSummary(
  messages: ChatMessage[],
  sessionId: string,
): ChatMessage[] {
  if (messages.length <= SUMMARY_THRESHOLD) return messages;

  const cache = readCache(sessionId);
  if (!cache || !cache.summary) return messages;

  // 旧摘要即使消息数有差异也作兜底使用（总比完全丢失上下文好）；
  // scheduleSummaryUpdate 会在后台异步刷新。
  console.log(
    LOG_PREFIX,
    `应用缓存摘要: sessionId=${sessionId}, 摘要覆盖 ${cache.messageCount - KEEP_RECENT} 条消息, 保留最近 ${KEEP_RECENT} 条`,
  );
  return applySummaryToMessages(messages, cache.summary);
}

/**
 * 异步调度摘要更新。fire-and-forget，不阻塞当前对话。
 *
 * 触发条件：
 *   - 消息数 > SUMMARY_THRESHOLD
 *   - 没有正在运行的摘要任务
 *   - 缓存不存在，或消息数变化超过 RE_SUMMARY_DELTA
 */
export function scheduleSummaryUpdate(
  messages: ChatMessage[],
  cfg: VendorConfig,
  sessionId: string,
): void {
  if (messages.length <= SUMMARY_THRESHOLD) return;
  if (summarizingSessions.has(sessionId)) return;

  const cache = readCache(sessionId);
  if (cache) {
    const delta = Math.abs(messages.length - cache.messageCount);
    if (delta < RE_SUMMARY_DELTA) return; // 缓存仍然有效
  }

  // 启动异步摘要
  void performSummaryUpdate(messages, cfg, sessionId);
}

async function performSummaryUpdate(
  messages: ChatMessage[],
  cfg: VendorConfig,
  sessionId: string,
): Promise<void> {
  summarizingSessions.add(sessionId);
  const toSummarizeCount = messages.length - KEEP_RECENT;
  const messagesToSummarize = messages.slice(0, toSummarizeCount);

  console.log(
    LOG_PREFIX,
    `开始生成摘要: sessionId=${sessionId}, 摘要 ${toSummarizeCount} 条消息, 保留最近 ${KEEP_RECENT} 条`,
  );

  try {
    const summary = await generateSummary(messagesToSummarize, cfg);
    writeCache(sessionId, {
      summary,
      messageCount: messages.length,
      updatedAt: Date.now(),
    });
    console.log(LOG_PREFIX, `摘要生成完成: sessionId=${sessionId}, ${summary.length} 字符`);
  } catch (err) {
    console.warn(
      LOG_PREFIX,
      `摘要生成失败 (sessionId=${sessionId}):`,
      err instanceof Error ? err.message : String(err),
    );
  } finally {
    summarizingSessions.delete(sessionId);
  }
}

// ─── 导出常量（供测试和外部引用） ─────────────────────────

export {
  SUMMARY_THRESHOLD,
  KEEP_RECENT,
  RE_SUMMARY_DELTA,
};
