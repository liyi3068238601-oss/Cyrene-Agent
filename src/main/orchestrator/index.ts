// Orchestrator — unified entry point
// Function Calling 模式下，Orchestrator 只负责构建 always-on 上下文（世界书 + L0/L1）
// 工具的选择和执行由 function-calling.ts 的 runFunctionCallingLoop 处理
import { updateWorldbookActivation, getPermanentWorldbookEntries, getActiveWorldbookEntries, getCascadeWorldbookEntries, searchMemory, searchMemoryEntries, INJECTION_HEADER, INJECTION_PREAMBLE } from "../rag";
import { memoryStore } from "../memory/memory-store";
import { entityGraph } from "../memory/entity-graph";
import { recordRecentMemoryInjection, recordRecentMemorySearchEntries } from "../memory/recent-injected-memory";
import { getMemoryEngineMode, getMemoryV2Database } from "../memory-v2/bridge";
import { recallMemoryV2 } from "../memory-v2/librarian";
import { recordShadowRecallComparison } from "../memory-v2/shadow-recall";
import { toolRegistry } from "./tool-registry";

export { ToolCallResult } from "./types";
export { scheduleMemoryWrite } from "./context-builder";
export { buildToneInjection } from "./tone-injector";
export { runFunctionCallingLoop } from "./function-calling";

// topicState TTL 已移除——由 DMAE Activation 状态机接管（见 rag/worldbook.ts）

/**
 * 构建相关记忆注入：自动检索 top-N 相关 L2 记忆和导入文档，
 * 注入到 system prompt 中，让模型无需主动调用 tool 也能感知到相关信息。
 * 原有 tool 保留，模型仍可深度搜索。
 */
export async function buildMemoryInjection(
  userInput: string,
  options: { sessionId?: string; includeAllSessions?: boolean } = {},
): Promise<string> {
  const parts: string[] = [];
  let v2MemoryUsed = false;
  const memoryMode = getMemoryEngineMode();
  const memoryV2Db = getMemoryV2Database();

  try {
    if (memoryV2Db && memoryMode === "v2") {
      const vectorHits = await searchMemoryEntries(userInput, "user_memory", 24, { recordRecall: false });
      const recalled = await recallMemoryV2(memoryV2Db, userInput, {
        currentConversationId: options.sessionId,
        vectorHits,
        maxItems: 8,
      });
      if (recalled.items.length > 0) {
        parts.push(recalled.context);
        recordRecentMemoryInjection(
          recalled.items.filter((item) => item.layer === "fragment").map((item) => item.id),
        );
        v2MemoryUsed = true;
      }
    }
  } catch (err) {
    console.warn("[Orchestrator] Memory v2 hybrid search failed, falling back to legacy:", err);
  }

  if (!v2MemoryUsed) try {
    // 检索 top-3 L2 用户记忆
    const legacyStartedAt = Date.now();
    const candidates = await searchMemoryEntries(
      userInput,
      "user_memory",
      40,
      { recordRecall: false },
    );
    const allL2 = await memoryStore.getAllL2();
    const l2ById = new Map(allL2.map((memory) => [memory.id, memory]));
    const userMemoryEntries = candidates
      .filter((entry) => {
        const l2Id = entry.metadata?.l2Id;
        const l2 = typeof l2Id === "string" ? l2ById.get(l2Id) : undefined;
        if (l2 && l2.status !== "active" && l2.status !== "aging") return false;
        return true;
      })
      .slice(0, 5);
    const legacyDurationMs = Math.max(0, Date.now() - legacyStartedAt);
    if (userMemoryEntries.length > 0) {
      for (const entry of userMemoryEntries) {
        const l2Id = entry.metadata?.l2Id;
        if (typeof l2Id === "string") await memoryStore.updateL2RecallStats(l2Id, 1);
      }
      recordRecentMemorySearchEntries(userMemoryEntries);
      // 标注可能存在冲突的记忆
      const conflictAnnotated = userMemoryEntries.map((entry) => {
        const m = entry.text;
        const l2Entry = allL2.find((l) => l.content === m && l.conflictWith && l.conflictWith.length > 0);
        if (l2Entry) {
          return `· ${m} ⚠️（该信息可能存在矛盾记录）`;
        }
        return `· ${m}`;
      });
      parts.push("【相关记忆】\n" + conflictAnnotated.join("\n"));
    }
    if (memoryV2Db && memoryMode === "v2-shadow") {
      try {
        const shadow = await recallMemoryV2(memoryV2Db, userInput, {
          currentConversationId: options.sessionId,
          vectorHits: candidates.slice(0, 24),
          maxItems: 8,
          recordAccess: false,
          logMode: "shadow",
        });
        recordShadowRecallComparison(memoryV2Db, {
          query: userInput,
          legacyIds: userMemoryEntries
            .map((entry) => entry.metadata?.l2Id)
            .filter((id): id is string => typeof id === "string"),
          v2: shadow,
          legacyDurationMs,
        });
      } catch (error) {
        console.warn("[Orchestrator] Memory v2 shadow recall failed without affecting legacy injection:", error);
      }
    }
  } catch (err) {
    console.warn("[Orchestrator] user_memory search failed:", err);
  }

  try {
    // 检索 top-5 导入文档片段（与工具 imported_docs 默认 topK 对齐；
    // 之前只取 2 条导致知识库上下文严重不足，用户上传的文档几乎无法被模型感知）
    const docResults = await searchMemory(userInput, "imported_doc", 5);
    if (docResults.length > 0) {
      parts.push("【相关文档】\n" + docResults.map((d) => "· " + d).join("\n"));
    }
  } catch (err) {
    console.warn("[Orchestrator] imported_doc search failed:", err);
  }

  try {
    // 实体关系图谱
    const entityInfo = entityGraph.search(userInput);
    if (entityInfo) {
      parts.push("【人物关系】\n" + entityInfo);
    }
  } catch (err) {
    console.warn("[Orchestrator] entity graph search failed:", err);
  }

  return parts.join("\n\n");
}

function getWorldbookTriggerText(userInput: string): string {
  const contextMarkers = [
    "【本轮文件】",
    "【文档内容】",
    "【图片视觉信息】",
    "【图片附件】",
  ];
  const firstContextIndex = contextMarkers
    .map((marker) => userInput.indexOf(marker))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];
  return (typeof firstContextIndex === "number" ? userInput.slice(0, firstContextIndex) : userInput).trim();
}

/**
 * 构建 always-on 上下文：世界书 + L0/L1 画像。
 * 不涉及工具选择和执行——那些由 function calling 处理。
 */
export async function buildAlwaysOnContext(
  userInput: string,
  recentMessages: Array<{ role: string; content: string }>,
): Promise<string> {
  const parts: string[] = [];

  // ── 世界书 — 永远跑 ──────────────────────────────────
  // DMAE：常驻始终注入；非常驻条目按 Activation 生命周期门控。
  // updateActivation 在调 LLM 之前跑 → 用户当轮命中的条目当轮就进 Prompt。
  try {
    const permanentWb = getPermanentWorldbookEntries();
    if (permanentWb.length > 0) {
      parts.push("【常驻背景】\n" + permanentWb.join("\n\n"));
    }

    const lastAssistant = recentMessages
      .filter(m => m.role === "assistant")
      .slice(-1)[0]?.content ?? "";
    updateWorldbookActivation(getWorldbookTriggerText(userInput), lastAssistant);  // 打分（本轮用户 + 上轮模型）
    const active = getActiveWorldbookEntries();           // 阈值门控 + 注入
    // One-Shot cascade：用户命中后连带触发的条目（不入 DMAE 状态表，只本轮有效）
    const cascade = getCascadeWorldbookEntries();
    const allInjected = active.length > 0 || cascade.length > 0;
    if (allInjected) {
      const sections: string[] = [];
      if (active.length > 0) {
        sections.push(active.join("\n\n"));
      }
      if (cascade.length > 0) {
        sections.push(cascade.join("\n\n"));
      }
      parts.push(INJECTION_HEADER + "\n" + INJECTION_PREAMBLE + "\n\n" + sections.join("\n\n"));
    }
  } catch (err) {
    console.warn("[Orchestrator] worldbook dmae failed:", err);
  }

  // ── L0/L1 画像 — 永远跑 ──────────────────────────────
  try {
    const v2Db = getMemoryV2Database();
    if (v2Db && getMemoryEngineMode() === "v2") {
      const profile = v2Db.prepare("SELECT * FROM core_profile WHERE id = 1").get();
      const facts = v2Db.prepare("SELECT namespace, key, value FROM core_facts WHERE status = 'active' ORDER BY pinned DESC, updated_at DESC LIMIT 6").all();
      const states = v2Db.prepare("SELECT content FROM memory_states WHERE status = 'active' ORDER BY pinned DESC, importance DESC, updated_at DESC LIMIT 4").all();
      const profileLines = profile ? [
        profile.preferred_name && `称呼：${String(profile.preferred_name)}`,
        profile.occupation && `职业：${String(profile.occupation)}`,
        profile.long_term_interests && `长期兴趣：${String(profile.long_term_interests)}`,
        profile.language && `常用语言：${String(profile.language)}`,
        profile.permanent_note && `备注：${String(profile.permanent_note)}`,
      ].filter(Boolean).map(String) : [];
      const factLines = facts.map((fact) => `${String(fact.namespace)}.${String(fact.key)}：${String(fact.value)}`);
      const stateLines = states.map((state) => String(state.content));
      if (profileLines.length > 0 || factLines.length > 0) parts.push("[用户画像]\n" + [...profileLines, ...factLines].join("\n"));
      if (stateLines.length > 0) parts.push("[当前状态]\n" + stateLines.join("\n"));
    } else {
      const l0 = await memoryStore.getL0();
      const l1 = await memoryStore.getL1();

    const l0Lines = [
      l0.preferredName && `称呼：${l0.preferredName}`,
      l0.occupation && `职业：${l0.occupation}`,
      l0.longTermInterests && `长期兴趣：${l0.longTermInterests}`,
      l0.language && `常用语言：${l0.language}`,
      l0.permanentNote && `备注：${l0.permanentNote}`,
    ].filter(Boolean);

    const l1Lines = [
      l1.recentGoals && `最近目标：${l1.recentGoals}`,
      l1.recentPreferences && `近期偏好：${l1.recentPreferences}`,
      l1.currentProject && `当前项目：${l1.currentProject}`,
    ].filter(Boolean);

      if (l0Lines.length > 0 || l1Lines.length > 0) {
        let memoryContext = "";
        if (l0Lines.length > 0) {
          memoryContext += `[用户画像]\n${l0Lines.join("\n")}\n\n`;
        }
        if (l1Lines.length > 0) {
          memoryContext += `[近期状态]\n${l1Lines.join("\n")}\n\n`;
        }
        parts.push(memoryContext.trim());
      }
    }
  } catch (err) {
    console.warn("[Orchestrator] memory load failed:", err);
  }

  // ── 日志 ──────────────────────────────────────────────
  const enabledTools = toolRegistry.getEnabledTools();
  console.log("[Orchestrator] Always-on context built, enabled tools: " + enabledTools.map(t => t.id).join(", "));

  return parts.join("\n\n");
}
