import * as fs from "fs"
import * as path from "path"
import { getAdapterForConfig } from "../orchestrator/vendors"
import type { VendorConfig, ChatMessage } from "../orchestrator/vendors"
import { app } from "electron"
import { MemoryCandidate, L0_FIELD_DESCRIPTIONS, MemoryJudgeTurn } from "./memory-types"
import { recordUsage } from "../token-usage-store"
import { getMemoryV2Database } from "../memory-v2/bridge"
import { isMemoryBackgroundBudgetAvailable, recordMemoryBackgroundCall } from "../memory-v2/background-metrics"

interface ModelSettings {
  provider: string
  baseUrl: string
  model: string
  apiKey: string
  explicitTransport?: "openai" | "anthropic" | "auto"
}

const DEFAULT_MODEL_SETTINGS: ModelSettings = {
  provider: "DeepSeek（深度求索）",
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-v4-pro",
  apiKey: "",
};

function getSettingsPath(): string {
  return path.join(app.getPath("userData"), "model-settings.json")
}

function loadModelSettings(): ModelSettings {
  try {
    const filePath = getSettingsPath()
    if (!fs.existsSync(filePath)) return DEFAULT_MODEL_SETTINGS
    const raw = fs.readFileSync(filePath, "utf8")
    const parsed = JSON.parse(raw) as Partial<ModelSettings>
    // explicitTransport 取自顶层（顶层是 perProvider[currentProvider] 的镜像）
    const explicitTransport: ModelSettings["explicitTransport"] =
      parsed.explicitTransport === "openai" || parsed.explicitTransport === "anthropic" || parsed.explicitTransport === "auto"
        ? parsed.explicitTransport
        : undefined;
    return {
      provider: typeof parsed.provider === "string" && parsed.provider.trim() ? parsed.provider.trim() : DEFAULT_MODEL_SETTINGS.provider,
      baseUrl: typeof parsed.baseUrl === "string" && parsed.baseUrl.trim() ? parsed.baseUrl.trim() : DEFAULT_MODEL_SETTINGS.baseUrl,
      model: typeof parsed.model === "string" && parsed.model.trim() ? parsed.model.trim() : DEFAULT_MODEL_SETTINGS.model,
      apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey.trim() : "",
      explicitTransport,
    };
  } catch {
    return DEFAULT_MODEL_SETTINGS
  }
}



function stripThinkBlocks(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<think>[\s\S]*$/gi, "")
    .trim()
}

function extractJsonArray(raw: string): unknown[] | null {
  // 第一步：去掉 markdown 代码块包裹 + think 块
  let text = raw
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/gi, '')
    .trim()

  // 第二步：截取从第一个 [ 开始的内容（不要求结尾有 ]，防 max_tokens 截断）
  const start = text.indexOf('[')
  if (start === -1) return null
  text = text.slice(start)

  // 第三步：直接尝试解析（完整数组的情况）
  try {
    const parsed = JSON.parse(text) as unknown[]
    if (Array.isArray(parsed)) return parsed
  } catch (_) {}

  // 第四步：截断救场 —— 即使末尾 ] 缺失，把已完整的 {...} 对象逐个捞出来。
  // 关键：用栈匹配大括号深度，避免把对象内部的 } 当成对象结束。
  const results: unknown[] = []
  let i = 0
  while (i < text.length) {
    if (text[i] !== '{') { i++; continue }
    // 找匹配的 } —— 跟踪引号和嵌套深度
    let depth = 0
    let inStr = false
    let esc = false
    let j = i
    for (; j < text.length; j++) {
      const c = text[j]
      if (esc) { esc = false; continue }
      if (c === '\\') { esc = true; continue }
      if (c === '"') { inStr = !inStr; continue }
      if (inStr) continue
      if (c === '{') depth++
      else if (c === '}') {
        depth--
        if (depth === 0) break  // 找到匹配的闭合
      }
    }
    if (depth !== 0) break  // 这个对象被截断了，后面也不可能有完整的了
    const objStr = text.slice(i, j + 1)
    try {
      const obj = JSON.parse(objStr)
      if (obj && typeof obj === "object") results.push(obj)
    } catch (_) {
      // 单个对象解析失败，跳过继续找下一个
    }
    i = j + 1
  }

  if (results.length > 0) {
    console.log('[MemoryJudge] 截断救场提取成功，条数:', results.length)
    return results
  }

  // 第五步：修复嵌套英文引号问题（针对完整数组的情况再试一次）
  try {
    // 给 text 补上缺失的 ] 让 JSON.parse 有机会成功
    const fixedText = text.replace(/("content"|"triggerText"):\s*"([\s\S]*?)(?<!\\)"/g,
      (match: string, key: string, value: string) => {
        let k = 0
        const cleaned = value.replace(/"/g, () => k++ % 2 === 0 ? '「' : '」')
        return key + ': "' + cleaned + '"'
      }
    )
    // 尝试找最后一个完整对象后补 ]
    const lastBrace = fixedText.lastIndexOf('}')
    if (lastBrace > 0) {
      const candidate = fixedText.slice(0, lastBrace + 1) + ']'
      const parsed = JSON.parse(candidate) as unknown[]
      if (Array.isArray(parsed)) return parsed
    }
  } catch (_) {}

  return null
}

const ABSOLUTE_TERMS = ["只", "永远", "从不", "一定", "完全", "绝对", "以后都", "不再"]

function hasUnsupportedAbsolute(summary: string, evidenceQuotes: string[]): boolean {
  return ABSOLUTE_TERMS.some((term) => summary.includes(term) && !evidenceQuotes.some((quote) => quote.includes(term)))
}

function normalizeCandidate(input: unknown): MemoryCandidate | null {
  if (!input || typeof input !== "object") return null
  const record = input as Record<string, unknown>
  const layer = record.layer
  const summary = record.summary
  const importance = record.importance
  const stability = record.stability
  const certainty = record.certainty
  const attribution = record.attribution
  const evidenceQuotes = Array.isArray(record.evidenceQuotes) ? record.evidenceQuotes.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()) : []
  const contextSummary = record.contextSummary
  const shouldWrite = record.shouldWrite
  const reason = record.reason
  const forbiddenOverclaims = Array.isArray(record.forbiddenOverclaims) ? record.forbiddenOverclaims.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()) : []
  if (layer !== "L0" && layer !== "L1" && layer !== "L2") return null
  if (typeof summary !== "string" || !summary.trim()) return null
  if (importance !== "low" && importance !== "medium" && importance !== "high") return null
  if (stability !== "one_off" && stability !== "situational" && stability !== "stable") return null
  if (certainty !== "explicit" && certainty !== "inferred" && certainty !== "uncertain") return null
  if (attribution !== "user_explicit" && attribution !== "assistant_inferred" && attribution !== "mixed") return null
  if (shouldWrite !== true) return null
  if (typeof contextSummary !== "string" || !contextSummary.trim()) return null
  if (typeof reason !== "string" || !reason.trim()) return null
  if (evidenceQuotes.length === 0) return null
  if (forbiddenOverclaims.length > 0) return null
  if (hasUnsupportedAbsolute(summary, evidenceQuotes)) return null

  const confidence =
    certainty === "explicit" ? 0.9 :
    certainty === "inferred" ? 0.65 :
    0.4
  return {
    layer,
    field: typeof record.field === 'string' ? record.field : undefined,
    summary: summary.trim(),
    content: summary.trim(),
    confidence,
    triggerText: evidenceQuotes[0],
    importance,
    stability,
    certainty,
    attribution,
    evidenceQuotes,
    contextSummary: contextSummary.trim(),
    shouldWrite,
    reason: reason.trim(),
    forbiddenOverclaims,
  }
}

async function callChatCompletions(
  settings: ModelSettings,
  messages: Array<{ role: "system" | "user"; content: string }>,
  timeoutMs: number,
  label: string,
): Promise<string> {
  const startedAt = Date.now()
  let inputTokens = 0
  let outputTokens = 0
  const metricsDb = getMemoryV2Database()
  if (!isMemoryBackgroundBudgetAvailable(metricsDb)) throw new Error("memory_background_daily_budget_exhausted")
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  // 拼 VendorConfig（settings 顶层三件套 + 镜像字段都参与）
  const cfg: VendorConfig = {
    provider: settings.provider,
    baseUrl: settings.baseUrl,
    model: settings.model,
    apiKey: settings.apiKey,
    explicitTransport: settings.explicitTransport,
  }

  try {
    // adapter 三层 transport 解析（explicitTransport → baseUrl 启发式 → capabilities fallback）
    // —— 之前直接写 OpenAI body / Bearer header / choices[0].message.content 解析，
    // 切到 anthropic transport 厂商（如 MiniMax / Claude）时会拿到空字符串，误判 "JSON 解析失败"。
    // 现在交给 adapter，OpenAI / Anthropic 端点都正确。
    const adapter = getAdapterForConfig(cfg)
    const http = adapter.buildRequest({
      model: cfg.model,
      messages: messages as ChatMessage[],
      maxTokens: 50000,
      stream: false,
    }, cfg)

    const response = await fetch(http.url, {
      method: "POST",
      signal: controller.signal,
      headers: http.headers,
      body: http.body,
    })

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({})) as Record<string, unknown>
      const errMsg = (errorData as { error?: { message?: string } }).error?.message
      throw new Error(errMsg || `模型请求失败：HTTP ${response.status}`)
    }

    const data = await response.json()
    const parsed = adapter.parseResponse(data)

    // 记录 token 用量（统一字段，OpenAI / Anthropic adapter 都映射成 {input, output}）
    if (parsed.usage) {
      recordUsage(parsed.usage.input, parsed.usage.output, 1)
      inputTokens = parsed.usage.input
      outputTokens = parsed.usage.output
    }
    recordMemoryBackgroundCall(metricsDb, { kind: `scribe:${label}`, durationMs: Date.now() - startedAt, inputTokens, outputTokens })
    return stripThinkBlocks(parsed.text ?? "")
  } catch (error) {
    recordMemoryBackgroundCall(metricsDb, { kind: `scribe:${label}`, durationMs: Date.now() - startedAt, inputTokens, outputTokens, failed: true })
    throw error
  } finally {
    clearTimeout(timer)
  }
}

export class MemoryJudge {
  private buildL0FieldPrompt(): string {
    return Object.entries(L0_FIELD_DESCRIPTIONS)
      .map(([field, description]) => `  · ${field}：${description}`)
      .join('\n')
  }
  async judgeRecentTurns(
    turns: MemoryJudgeTurn[],
    conversationId: string,
  ): Promise<MemoryCandidate[]> {
    console.log(`[MemoryJudge] 分析最近 ${turns.length} 轮对话...`)

    try {
      const settings = loadModelSettings()
      if (!settings.apiKey) {
        console.error("[MemoryJudge] LLM 调用失败: missing api key")
        console.log("[MemoryJudge] 本轮无值得记录的信息")
        return []
      }

      const systemPrompt = [
        "你是一个记忆候选提取器，负责从对话中识别对理解用户有帮助的信息。",
        "你的目标是在准确和全面之间取得平衡：准确的信息优先记录，不确定的信息标注出来。",
        "",
        "你可以提取用户直接或间接表达的信息，只要对未来理解用户可能有帮助即可。",
        "L0/L1 层级的核心事实仍然需要用户明确表达；L2 层可以记录用户的偏好倾向、情绪模式、日常习惯等软性信息。",
        "如果这些对话完全没有值得记录的内容（纯寒暄、无任何信息量），才返回空数组 []。",
        "",
        "记忆层级定义：",
        "- L0：用户稳定身份信息或核心画像。只有 certainty=explicit 且 attribution=user_explicit 才允许进入 L0。",
        "  识别到 L0 信息时，必须同时在 field 字段里指定要写入哪个格子。",
        "  可用的 field 值如下（只能用这些，不能自己发明）：",
        this.buildL0FieldPrompt(),
        "",
        "  重要：field 的值必须严格是上方列出的英文字段名，",
        "  例如 preferredName、occupation，",
        "  不能用 nickname、name、job 等其他词。",
        "- L1：用户近期目标、阶段性偏好或当前状态，写近期情况，不要写成长期偏好。",
        "- L2：用户说过的事件、经历、日常偏好、情绪反应、对事情的态度、讨论过的话题等。L2 的准入门槛最低——只要用户确实提到了、对未来可能有参考价值，就可以记录。",
        "",
        "判断原则：",
        "- 准确的信息直接记录；不确定的信息用 certainty=inferred/uncertain 标注后进入 L2",
        "- 纯问候（你好、晚安）→ 返回空数组；有内容的日常聊天可以提取 L2 片段",
        "- 必须是用户主动表达或明显流露的信息，不能把 AI 的推断写成事实",
        "- summary 忠于用户原话和上下文，不要自行推广范围",
        "- summary 必须用第一人称（昔涟视角）书写，即昔涟观察到的关于用户的信息，例如「梨衣喜欢…」「他叫…」「他在…工作」，禁止用「用户喜欢…」等第三人称，也不要用「我喜欢…」这种容易混淆人称的写法",
        "- evidenceQuotes 保持用户原话不变，不做人称转换",
        "- 不要把「这次」「刚刚」「这个话题里」变成长期偏好。如果信息暗示长期倾向，用 L2 + stability=situational 记录",
        "- 不要自动使用绝对化表达：只、永远、从不、一定、完全、绝对、以后都、不再，除非用户原话明确说过这些词",
        "- 如果 summary 中存在可能过度概括的词，必须写入 forbiddenOverclaims；有 forbiddenOverclaims 时 shouldWrite 必须是 false",
        "",
        "重要格式规则：",
        "- summary 和 evidenceQuotes 字段的值里，禁止出现英文双引号 \"",
        "- 如果内容里有引号，统一用中文引号「」替代，例如：用户希望被称为「宝宝」",
        "- 不要用 markdown 代码块包裹 JSON，直接输出裸 JSON",
        "- 数组第一个字符必须是 [，最后一个字符必须是 ]",
        "",
        "输出格式为 JSON 数组，禁止用 markdown 代码块包裹，直接输出裸 JSON。",
        "",
        "每个候选必须包含这些字段：",
        "{",
        "  \"layer\": \"L0\",",
        "  \"field\": \"preferredName\",",
        "  \"summary\": \"昔涟第一人称书写的候选摘要，如：梨衣喜欢看科幻小说\",",
        "  \"importance\": \"low|medium|high\",",
        "  \"stability\": \"one_off|situational|stable\",",
        "  \"certainty\": \"explicit|inferred|uncertain\",",
        "  \"attribution\": \"user_explicit|assistant_inferred|mixed\",",
        "  \"evidenceQuotes\": [\"用户原话短引文，必须来自用户\"],",
        "  \"contextSummary\": \"最近多轮上下文概括，不超过80字\",",
        "  \"shouldWrite\": true,",
        "  \"reason\": \"为什么值得记，或为什么不写\",",
        "  \"forbiddenOverclaims\": []",
        "}",
        "",
        "L1/L2 不需要 field。",
        "inferred / uncertain 不允许进入 L0；如果还值得保留，放到 L2。",
        "没有值得记录的信息时，输出：[]",
        "summary 和 evidenceQuotes 里禁止出现英文双引号，用「」替代。",
      ].join("\n")

      const transcript = turns.map((turn, index) => [
        `第 ${index + 1} 轮：`,
        `用户：${turn.userInput}`,
        `AI：${turn.assistantReply}`,
      ].join("\n")).join("\n\n")

      const userPrompt = [
        `conversationId: ${conversationId}`,
        "最近对话：",
        transcript,
      ].join("\n")

      const raw = await callChatCompletions(
        settings,
        [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        120000,
        "MemoryJudge",
      )

      const parsed = extractJsonArray(raw)
      if (!parsed) {
        console.error("[MemoryJudge] JSON 解析失败，原始内容：\n", raw.slice(0, 200))
        console.log("[MemoryJudge] 本轮无值得记录的信息")
        return []
      }

      const candidates = parsed
        .map(normalizeCandidate)
        .filter((item): item is MemoryCandidate => item !== null)
        .filter((item) => item.shouldWrite === true)
        .filter((item) => item.layer !== "L0" || (item.certainty === "explicit" && item.attribution === "user_explicit"))

      if (candidates.length === 0) {
        console.log("[MemoryJudge] 本轮无值得记录的信息")
        return []
      }

      console.log(`[MemoryJudge] 提取候选: ${candidates.length} 条（过滤后）`)
      console.log(
        `[MemoryJudge] 候选详情: ${candidates.map((item) => item.layer === "L0" && item.field ? `${item.layer}.${item.field}(\"${item.content.slice(0, 20)}\", ${item.confidence.toFixed(2)})` : `${item.layer}(\"${item.content.slice(0, 20)}\", ${item.confidence.toFixed(2)})`).join(" ")}`,
      )
      return candidates
    } catch (error) {
      console.error("[MemoryJudge] LLM 调用失败:", error)
      console.log("[MemoryJudge] 本轮无值得记录的信息")
      return []
    }
  }

  async judge(
    userMessage: string,
    assistantMessage: string,
    conversationId: string,
  ): Promise<MemoryCandidate[]> {
    return this.judgeRecentTurns([{ userInput: userMessage, assistantReply: assistantMessage }], conversationId)
  }
}

export const memoryJudge = new MemoryJudge()
