import { randomUUID } from "crypto"
import { Jieba } from "@node-rs/jieba"
import type { MemoryV2Database } from "./database"
import { memoryLogPreview } from "./shadow-recall"
import { enqueueVectorDelete, enqueueVectorUpsert, loadVectorTarget, vectorContentHash, vectorIndexKey } from "./vector-sync"

const jieba = new Jieba()
const RRF_K = 60
const DAY_MS = 24 * 60 * 60 * 1000
const STOP_WORDS = new Set([
  "的", "了", "是", "在", "我", "你", "他", "她", "它", "我们", "你们",
  "这个", "那个", "什么", "怎么", "为什么", "可以", "有没有", "记得", "知道",
  "最近", "之前", "以前", "现在", "一下", "一个", "事情", "东西", "时候",
  "what", "which", "tell", "please", "remember", "recall", "saved", "fact",
  "user", "detail", "connected", "preference", "mentions", "recorded", "keyword",
  "know", "context", "find", "memory", "containing", "includes", "refers", "about",
  "there", "with", "does", "have", "this", "that", "the", "and", "for",
  "is", "to", "do", "of", "in", "on", "at", "it", "be", "was", "were", "are",
])

export type MemoryQueryIntent = "fact" | "current_state" | "entity" | "recent" | "long_term" | "emotional" | "semantic"
export type MemoryRecallPermission = "can_quote" | "cautious" | "association_only"
export type MemoryRecallLayer = "core_fact" | "state" | "fragment" | "episode" | "saga"

export interface MemoryVectorHit {
  id: string
  text: string
  score: number
  metadata?: Record<string, unknown>
}

export interface MemoryRecallItem {
  id: string
  claimId?: string
  layer: MemoryRecallLayer
  content: string
  permission: MemoryRecallPermission
  score: number
  confidence: number
  createdAt: number
  sources: string[]
  scoreParts: {
    rrf: number
    evidence: number
    importance: number
    recency: number
    topic: number
    lifecycle: number
    intent: number
  }
}

export interface MemoryRecallResult {
  intent: MemoryQueryIntent
  items: MemoryRecallItem[]
  context: string
  durationMs: number
}

interface Candidate {
  id: string
  claimId?: string
  layer: MemoryRecallLayer
  content: string
  confidence: number
  importance: number
  status: string
  certainty: string
  attribution: string
  createdAt: number
  lastAccessedAt: number
  sourceCount: number
  sourceConversations: string[]
  channels: Map<string, number>
}

function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value))
}

export function classifyMemoryIntent(query: string): MemoryQueryIntent {
  if (/还记得|以前|之前|曾经|那次|一路|变化|长期|回顾|最开始/.test(query)) return "long_term"
  if (/最近|近来|这段时间|刚才|刚刚|进展|最近在做/.test(query)) return "recent"
  if (/现在|目前|正在|计划|目标|接下来|待办|进度/.test(query)) return "current_state"
  if (/关系|感受|心情|难过|开心|在意|陪伴|喜欢我/.test(query)) return "emotional"
  if (/谁|哪位|关于.+(?:人|项目|应用)|认识|人物/.test(query)) return "entity"
  if (/多少|哪里|什么时候|哪天|几点|名字|职业|语言|哪个|是否|是不是/.test(query) || /\d/.test(query)) return "fact"
  return "semantic"
}

export function tokenizeMemoryQuery(query: string): string[] {
  const tokens = new Set<string>()
  try {
    for (const token of jieba.cut(query, true)) {
      const normalized = token.trim().toLowerCase()
      if (normalized.length >= 2 && !STOP_WORDS.has(normalized) && /[\p{L}\p{N}]/u.test(normalized)) {
        tokens.add(normalized)
      }
    }
  } catch {
    // Fall through to regex tokens.
  }
  for (const match of query.toLowerCase().matchAll(/[a-z0-9_-]{2,}|[\u4e00-\u9fff]{2,8}/g)) {
    if (!STOP_WORDS.has(match[0])) tokens.add(match[0])
  }
  return [...tokens].slice(0, 12)
}

function addChannel(candidate: Candidate, channel: string, rank: number, weight = 1): void {
  candidate.channels.set(channel, (candidate.channels.get(channel) ?? 0) + weight / (RRF_K + rank + 1))
}

function candidateFromRow(row: Record<string, unknown>, layer: MemoryRecallLayer): Candidate {
  const sourceConversations = String(row.source_conversations ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
  return {
    id: String(row.id),
    claimId: typeof row.claim_id === "string" && row.claim_id ? row.claim_id : undefined,
    layer,
    content: String(row.content ?? row.value ?? ""),
    confidence: clamp(Number(row.confidence ?? 0.5)),
    importance: clamp(Number(row.importance ?? 0.5)),
    status: String(row.status ?? "active"),
    certainty: String(row.certainty ?? "explicit"),
    attribution: String(row.attribution ?? "user"),
    createdAt: Number(row.created_at ?? row.updated_at ?? 0),
    lastAccessedAt: Number(row.last_accessed_at ?? row.updated_at ?? row.created_at ?? 0),
    sourceCount: Number(row.source_count ?? 0),
    sourceConversations,
    channels: new Map(),
  }
}

function mergeCandidate(target: Map<string, Candidate>, incoming: Candidate): Candidate {
  const key = `${incoming.layer}:${incoming.id}`
  const existing = target.get(key)
  if (!existing) {
    target.set(key, incoming)
    return incoming
  }
  existing.sourceCount = Math.max(existing.sourceCount, incoming.sourceCount)
  existing.sourceConversations = Array.from(new Set([...existing.sourceConversations, ...incoming.sourceConversations]))
  return existing
}

function likeWhere(columns: string[], terms: string[]): { sql: string; params: string[] } {
  if (terms.length === 0) return { sql: "1 = 0", params: [] }
  const clauses: string[] = []
  const params: string[] = []
  for (const term of terms) {
    for (const column of columns) {
      clauses.push(`${column} LIKE ? ESCAPE '\\'`)
      params.push(`%${term.replace(/[\\%_]/g, "\\$&")}%`)
    }
  }
  return { sql: `(${clauses.join(" OR ")})`, params }
}

function queryFragments(db: MemoryV2Database, terms: string[], limit: number): Array<Record<string, unknown>> {
  const where = likeWhere(["f.content"], terms)
  return db.prepare(`
    SELECT f.*,
      COUNT(DISTINCT fs.source_id) AS source_count,
      GROUP_CONCAT(DISTINCT s.conversation_id) AS source_conversations
    FROM memory_fragments f
    LEFT JOIN memory_fragment_sources fs ON fs.fragment_id = f.id
    LEFT JOIN memory_sources s ON s.id = fs.source_id
    WHERE f.status IN ('active', 'cooling', 'frozen') AND ${where.sql}
    GROUP BY f.id
    ORDER BY f.updated_at DESC
    LIMIT ?
  `).all(...where.params, limit)
}

function queryFragmentsFts(db: MemoryV2Database, terms: string[], limit: number): Array<Record<string, unknown>> {
  if (terms.length === 0) return []
  const match = terms.map((term) => `"${term.replace(/"/g, '""')}"`).join(" OR ")
  try {
    return db.prepare(`
      SELECT f.*,
        COUNT(DISTINCT fs.source_id) AS source_count,
        GROUP_CONCAT(DISTINCT s.conversation_id) AS source_conversations,
        MIN(fts.rank) AS fts_rank
      FROM memory_fragments_fts fts
      JOIN memory_fragments f ON f.id = fts.fragment_id
      LEFT JOIN memory_fragment_sources fs ON fs.fragment_id = f.id
      LEFT JOIN memory_sources s ON s.id = fs.source_id
      WHERE memory_fragments_fts MATCH ? AND f.status IN ('active', 'cooling')
      GROUP BY f.id
      ORDER BY fts_rank ASC
      LIMIT ?
    `).all(match, limit)
  } catch {
    return []
  }
}

function queryStates(db: MemoryV2Database, terms: string[], intent: MemoryQueryIntent, limit: number): Array<Record<string, unknown>> {
  const where = likeWhere(["st.content", "st.state_type"], terms)
  const includeAll = intent === "current_state" || intent === "recent"
  return db.prepare(`
    SELECT st.*,
      COUNT(DISTINCT ss.source_id) AS source_count,
      GROUP_CONCAT(DISTINCT src.conversation_id) AS source_conversations
    FROM memory_states st
    LEFT JOIN memory_state_sources ss ON ss.state_id = st.id
    LEFT JOIN memory_sources src ON src.id = ss.source_id
    WHERE st.status = 'active' AND (${includeAll ? "1 = 1" : where.sql})
    GROUP BY st.id
    ORDER BY st.importance DESC, st.updated_at DESC
    LIMIT ?
  `).all(...(includeAll ? [] : where.params), limit)
}

function queryEpisodes(db: MemoryV2Database, terms: string[], intent: MemoryQueryIntent, limit: number, includeRecent = false): Array<Record<string, unknown>> {
  const where = likeWhere(["e.title", "e.content"], terms)
  const statuses = intent === "long_term" ? "('active', 'mature', 'archived')" : "('active', 'mature')"
  return db.prepare(`
    SELECT e.*,
      COUNT(DISTINCT ef.fragment_id) AS source_count,
      '' AS source_conversations
    FROM memory_episodes e
    LEFT JOIN memory_episode_fragments ef ON ef.episode_id = e.id
    WHERE e.status IN ${statuses} AND ${includeRecent ? "1 = 1" : where.sql}
    GROUP BY e.id
    ORDER BY e.updated_at DESC
    LIMIT ?
  `).all(...(includeRecent ? [] : where.params), limit)
}

function queryEpisodesFts(db: MemoryV2Database, terms: string[], intent: MemoryQueryIntent, limit: number): Array<Record<string, unknown>> {
  if (terms.length === 0) return []
  const match = terms.map((term) => `"${term.replace(/"/g, '""')}"`).join(" OR ")
  const statuses = intent === "long_term" ? "('active', 'mature', 'archived')" : "('active', 'mature')"
  try {
    return db.prepare(`
      SELECT e.*, COUNT(DISTINCT ef.fragment_id) AS source_count,
        '' AS source_conversations, MIN(fts.rank) AS fts_rank
      FROM memory_episodes_fts fts
      JOIN memory_episodes e ON e.id = fts.episode_id
      LEFT JOIN memory_episode_fragments ef ON ef.episode_id = e.id
      WHERE memory_episodes_fts MATCH ? AND e.status IN ${statuses}
      GROUP BY e.id ORDER BY fts_rank ASC LIMIT ?
    `).all(match, limit)
  } catch {
    return []
  }
}

function queryEntityFragments(db: MemoryV2Database, terms: string[], limit: number): Array<Record<string, unknown>> {
  const where = likeWhere(["e.canonical_name", "e.aliases_json", "e.overview"], terms)
  return db.prepare(`
    SELECT f.*,
      COUNT(DISTINCT fs.source_id) AS source_count,
      GROUP_CONCAT(DISTINCT s.conversation_id) AS source_conversations
    FROM memory_entities e
    JOIN memory_fragment_entities fe ON fe.entity_id = e.id
    JOIN memory_fragments f ON f.id = fe.fragment_id
    LEFT JOIN memory_fragment_sources fs ON fs.fragment_id = f.id
    LEFT JOIN memory_sources s ON s.id = fs.source_id
    WHERE e.status IN ('seed', 'active')
      AND f.status IN ('active', 'cooling', 'frozen')
      AND ${where.sql}
    GROUP BY f.id
    ORDER BY f.updated_at DESC
    LIMIT ?
  `).all(...where.params, limit)
}

function queryEntityFragmentsFts(db: MemoryV2Database, terms: string[], limit: number): Array<Record<string, unknown>> {
  if (terms.length === 0) return []
  const match = terms.map((term) => `"${term.replace(/"/g, '""')}"`).join(" OR ")
  try {
    return db.prepare(`
      SELECT f.*, COUNT(DISTINCT fs.source_id) AS source_count,
        GROUP_CONCAT(DISTINCT s.conversation_id) AS source_conversations,
        MIN(fts.rank) AS fts_rank
      FROM memory_entities_fts fts
      JOIN memory_entities e ON e.id = fts.entity_id
      JOIN memory_fragment_entities fe ON fe.entity_id = e.id
      JOIN memory_fragments f ON f.id = fe.fragment_id
      LEFT JOIN memory_fragment_sources fs ON fs.fragment_id = f.id
      LEFT JOIN memory_sources s ON s.id = fs.source_id
      WHERE memory_entities_fts MATCH ?
        AND e.status IN ('seed', 'active')
        AND f.status IN ('active', 'cooling', 'frozen')
      GROUP BY f.id ORDER BY fts_rank ASC LIMIT ?
    `).all(match, limit)
  } catch {
    return []
  }
}

function queryCoreFacts(db: MemoryV2Database, terms: string[], limit: number): Array<Record<string, unknown>> {
  const where = likeWhere(["namespace", "key", "value"], terms)
  return db.prepare(`
    SELECT id, value AS content, status, confidence, 1 AS importance,
      'explicit' AS certainty, 'user' AS attribution,
      created_at, updated_at, updated_at AS last_accessed_at,
      1 AS source_count, '' AS source_conversations
    FROM core_facts
    WHERE status = 'active' AND ${where.sql}
    ORDER BY pinned DESC, updated_at DESC
    LIMIT ?
  `).all(...where.params, limit)
}

function queryCoreProfile(db: MemoryV2Database): Array<Record<string, unknown>> {
  const row = db.prepare("SELECT * FROM core_profile WHERE id = 1").get()
  if (!row) return []
  const fields: Array<[string, string, string]> = [
    ["preferred_name", "称呼", "preferred_name"],
    ["occupation", "职业或身份", "occupation"],
    ["long_term_interests", "长期兴趣", "long_term_interests"],
    ["language", "常用语言", "language"],
    ["permanent_note", "永久说明", "permanent_note"],
  ]
  return fields.flatMap(([column, label, key]) => {
    const value = String(row[column] ?? "").trim()
    if (!value) return []
    const sourceCount = Number(db.prepare(`
      SELECT COUNT(*) AS count FROM memory_revisions
      WHERE target_type = 'core_profile' AND target_id = '1' AND source_id IS NOT NULL
    `).get()?.count ?? 0)
    return [{
      id: `core_profile:${key}`,
      content: `${label}：${value}`,
      status: "active",
      confidence: 1,
      importance: 1,
      certainty: "explicit",
      attribution: "user",
      created_at: Number(row.updated_at ?? 0),
      updated_at: Number(row.updated_at ?? 0),
      last_accessed_at: Number(row.updated_at ?? 0),
      source_count: Math.max(1, sourceCount),
      source_conversations: "",
    }]
  })
}

function querySagas(db: MemoryV2Database, terms: string[], limit: number, includeRecent = false): Array<Record<string, unknown>> {
  const where = likeWhere(["theme", "content"], terms)
  return db.prepare(`
    SELECT id, content, status, confidence, 0.7 AS importance,
      'inferred' AS certainty, 'system' AS attribution,
      created_at, updated_at, updated_at AS last_accessed_at,
      1 AS source_count, '' AS source_conversations
    FROM memory_sagas
    WHERE status = 'active' AND ${includeRecent ? "1 = 1" : where.sql}
    ORDER BY updated_at DESC LIMIT ?
  `).all(...(includeRecent ? [] : where.params), limit)
}

function queryProactiveFragments(db: MemoryV2Database, limit: number): Array<Record<string, unknown>> {
  return db.prepare(`
    SELECT f.*,
      COUNT(DISTINCT fs.source_id) AS source_count,
      GROUP_CONCAT(DISTINCT s.conversation_id) AS source_conversations
    FROM memory_fragments f
    JOIN memory_fragment_sources fs ON fs.fragment_id = f.id
    JOIN memory_sources s ON s.id = fs.source_id
    WHERE f.status IN ('active', 'cooling') AND f.importance >= 0.7
      AND f.certainty <> 'uncertain' AND s.status IN ('active', 'archived')
    GROUP BY f.id
    ORDER BY f.importance DESC, f.last_accessed_at ASC
    LIMIT ?
  `).all(limit)
}

function recencyScore(lastAccessedAt: number, now: number, intent: MemoryQueryIntent): number {
  const days = Math.max(0, now - lastAccessedAt) / DAY_MS
  const halfLife = intent === "long_term" ? 180 : intent === "recent" || intent === "current_state" ? 14 : 60
  return clamp(Math.exp(-Math.log(2) * days / halfLife))
}

function lifecycleFactor(candidate: Candidate, intent: MemoryQueryIntent): number {
  if (candidate.status === "cooling") return intent === "long_term" ? 0.9 : 0.72
  if (candidate.status === "frozen") return intent === "long_term" ? 0.58 : 0.38
  if (candidate.status === "archived") return intent === "long_term" ? 0.7 : 0.25
  if (candidate.status === "mature") return 1.05
  return 1
}

function intentFactor(layer: MemoryRecallLayer, intent: MemoryQueryIntent): number {
  if (layer === "state") return intent === "current_state" || intent === "recent" ? 1.35 : 0.9
  if (layer === "episode") return intent === "long_term" || intent === "recent" ? 1.35 : intent === "fact" ? 0.7 : 1
  if (layer === "saga") return intent === "long_term" ? 1.25 : 0.3
  if (layer === "core_fact") return intent === "fact" ? 1.3 : 1
  return 1
}

function permissionFor(candidate: Candidate, recency: number): MemoryRecallPermission {
  if (candidate.layer === "saga" || candidate.confidence < 0.55 || candidate.certainty === "uncertain") {
    return "association_only"
  }
  if (
    (candidate.layer === "core_fact" || candidate.layer === "state" || candidate.layer === "fragment") &&
    candidate.confidence >= 0.8 &&
    candidate.certainty === "explicit" &&
    candidate.attribution === "user" &&
    candidate.sourceCount > 0 &&
    recency >= 0.35
  ) {
    return "can_quote"
  }
  return "cautious"
}

function formatContext(intent: MemoryQueryIntent, items: MemoryRecallItem[]): string {
  if (items.length === 0) return ""
  const permission = {
    can_quote: "可引用",
    cautious: "谨慎引用",
    association_only: "仅供联想",
  } satisfies Record<MemoryRecallPermission, string>
  const layer = {
    core_fact: "核心事实",
    state: "当前状态",
    fragment: "记忆碎片",
    episode: "共同经历",
    saga: "长期脉络",
  } satisfies Record<MemoryRecallLayer, string>
  return [
    `【相关记忆 · ${intent}】`,
    ...items.map((item) => `· [${permission[item.permission]} / ${layer[item.layer]}] ${item.content}`),
    "引用规则：可引用内容可以自然确认；谨慎引用内容应表达为模糊记忆；仅供联想内容不得作为确定事实声称。不要向用户朗读方括号标签。",
  ].join("\n")
}

export async function recallMemoryV2(
  db: MemoryV2Database,
  query: string,
  options: {
    currentConversationId?: string
    vectorHits?: MemoryVectorHit[]
    now?: number
    maxItems?: number
    maxContextTokens?: number
    purpose?: "chat" | "proactive"
    recordAccess?: boolean
    logMode?: "active" | "shadow" | "proactive" | "benchmark"
  } = {},
): Promise<MemoryRecallResult> {
  const startedAt = Date.now()
  const now = options.now ?? startedAt
  const intent = classifyMemoryIntent(query)
  const terms = tokenizeMemoryQuery(query)
  const candidates = new Map<string, Candidate>()
  let vectorRepairsQueued = 0
  const addRows = (rows: Array<Record<string, unknown>>, layer: MemoryRecallLayer, channel: string, weight = 1) => {
    rows.forEach((row, index) => addChannel(mergeCandidate(candidates, candidateFromRow(row, layer)), channel, index, weight))
  }

  addRows(queryCoreProfile(db), "core_fact", "core_profile", 0.9)
  addRows(queryCoreFacts(db, terms, 8), "core_fact", "core", 1.2)
  addRows(queryStates(db, terms, intent, 12), "state", "state", 1.15)
  addRows(queryFragmentsFts(db, terms, 24), "fragment", "fts", 1.05)
  addRows(queryFragments(db, terms, 24), "fragment", "keyword")
  addRows(queryEntityFragmentsFts(db, terms, 16), "fragment", "entity_fts", 1.15)
  addRows(queryEntityFragments(db, terms, 16), "fragment", "entity", 1.1)
  const proactive = options.purpose === "proactive"
  addRows(queryEpisodes(db, terms, intent, 12, proactive), "episode", "episode", proactive ? 0.85 : 1.05)
  if (!proactive) addRows(queryEpisodesFts(db, terms, intent, 12), "episode", "episode_fts", 1.1)
  if (intent === "long_term" || proactive) addRows(querySagas(db, terms, 6, proactive), "saga", "saga", proactive ? 0.65 : 0.9)
  if (proactive) addRows(queryProactiveFragments(db, 12), "fragment", "proactive", 0.7)

  for (const [index, hit] of (options.vectorHits ?? []).entries()) {
    const memoryId = typeof hit.metadata?.memoryV2Id === "string"
      ? hit.metadata.memoryV2Id
      : typeof hit.metadata?.l2Id === "string" ? hit.metadata.l2Id : hit.id
    const memoryV2Hit = hit.metadata?.memoryV2 === true
    const memoryLayer = hit.metadata?.memoryLayer === "episode" ? "episode" : "fragment"
    if (memoryV2Hit) {
      if (
        Number(hit.metadata?.indexVersion ?? 0) !== 2 ||
        hit.metadata?.indexKey !== vectorIndexKey(memoryLayer, memoryId)
      ) {
        const target = loadVectorTarget(db, memoryLayer, memoryId)
        vectorRepairsQueued += target?.indexable
          ? Number(enqueueVectorUpsert(db, memoryLayer, memoryId, now, 90))
          : Number(enqueueVectorDelete(db, memoryLayer, memoryId, now, 100))
        continue
      }
    }
    const fragment = (!memoryV2Hit || memoryLayer === "fragment") ? db.prepare(`
      SELECT f.*,
        COUNT(DISTINCT fs.source_id) AS source_count,
        GROUP_CONCAT(DISTINCT s.conversation_id) AS source_conversations
      FROM memory_fragments f
      LEFT JOIN memory_fragment_sources fs ON fs.fragment_id = f.id
      LEFT JOIN memory_sources s ON s.id = fs.source_id
      WHERE f.id = ? AND f.status IN ('active', 'cooling')
      GROUP BY f.id
    `).get(memoryId) : undefined
    if (fragment && (!memoryV2Hit || (
      memoryLayer === "fragment" &&
      Number(hit.metadata?.targetRevision ?? 0) === Number(fragment.revision ?? 1) &&
      hit.metadata?.contentHash === vectorContentHash(String(fragment.content))
    ))) {
      addChannel(mergeCandidate(candidates, candidateFromRow(fragment, "fragment")), "vector", index, 1.1)
      continue
    }
    if (fragment && memoryV2Hit) {
      vectorRepairsQueued += Number(enqueueVectorUpsert(db, "fragment", memoryId, now, 90))
      continue
    }
    const allowedEpisodeStatuses = intent === "long_term" ? "('active', 'mature', 'archived')" : "('active', 'mature')"
    const episode = (!memoryV2Hit || memoryLayer === "episode") ? db.prepare(`
      SELECT *, 1 AS source_count, '' AS source_conversations
      FROM memory_episodes WHERE id = ? AND status IN ${allowedEpisodeStatuses}
    `).get(memoryId) : undefined
    if (episode && (!memoryV2Hit || (
      memoryLayer === "episode" &&
      Number(hit.metadata?.targetRevision ?? 0) === Number(episode.version ?? 1) &&
      hit.metadata?.contentHash === vectorContentHash(`${String(episode.title)}\n${String(episode.content)}`)
    ))) {
      addChannel(mergeCandidate(candidates, candidateFromRow(episode, "episode")), "vector", index, 1.1)
      continue
    }
    if (episode && memoryV2Hit) {
      vectorRepairsQueued += Number(enqueueVectorUpsert(db, "episode", memoryId, now, 90))
      continue
    }
    if (memoryV2Hit) {
      vectorRepairsQueued += Number(enqueueVectorDelete(db, memoryLayer, memoryId, now, 100))
    }
  }

  // Reward candidates that cover more meaningful query terms. RRF rank alone
  // cannot distinguish a unique name hit from a shared word such as "project".
  const termDocumentFrequency = new Map<string, number>()
  for (const term of terms) {
    termDocumentFrequency.set(term, [...candidates.values()].filter((candidate) => candidate.content.toLowerCase().includes(term)).length)
  }
  const rareTerms = new Set([...termDocumentFrequency.entries()]
    .filter(([, frequency]) => frequency > 0 && frequency <= Math.max(1, Math.floor(candidates.size * 0.25)))
    .map(([term]) => term))
  const distinctiveKeys = new Set<string>()
  for (const candidate of candidates.values()) {
    if (terms.length === 0) continue
    const text = candidate.content.toLowerCase()
    const matched = terms.filter((term) => text.includes(term)).length
    if (matched > 0) candidate.channels.set("term_coverage", 0.025 * (matched / terms.length))
    if (terms.some((term) => rareTerms.has(term) && text.includes(term))) distinctiveKeys.add(`${candidate.layer}:${candidate.id}`)
  }

  const scored = [...candidates.values()].map((candidate): MemoryRecallItem => {
    const rrf = [...candidate.channels.values()].reduce((sum, value) => sum + value, 0)
    const evidence = clamp(candidate.sourceCount / 2)
    const recency = recencyScore(candidate.lastAccessedAt || candidate.createdAt, now, intent)
    const topic = options.currentConversationId && candidate.sourceConversations.includes(options.currentConversationId) ? 1 : 0
    const lifecycle = lifecycleFactor(candidate, intent)
    const intentWeight = proactive && candidate.layer === "saga" ? 0.8 : intentFactor(candidate.layer, intent)
    const quality = 0.3 * candidate.confidence + 0.25 * evidence + 0.2 * candidate.importance + 0.15 * recency + 0.1 * topic
    const score = rrf * quality * lifecycle * intentWeight
    return {
      id: candidate.id,
      claimId: candidate.claimId,
      layer: candidate.layer,
      content: candidate.content,
      permission: permissionFor(candidate, recency),
      score,
      confidence: candidate.confidence,
      createdAt: candidate.createdAt,
      sources: [...candidate.channels.keys()],
      scoreParts: { rrf, evidence, importance: candidate.importance, recency, topic, lifecycle, intent: intentWeight },
    }
  }).filter((item) => item.score >= 0.0025).sort((a, b) => b.score - a.score)
  const ranked = !proactive && distinctiveKeys.size > 0
    ? scored.filter((item) => distinctiveKeys.has(`${item.layer}:${item.id}`))
    : scored

  // State, Fragment and Relation are projections of one proposition. A claim
  // may be found through several layers, but it only consumes one context slot.
  // Intent weighting above decides which representation is most useful now.
  const collapsed: MemoryRecallItem[] = []
  const seenClaims = new Set<string>()
  for (const item of ranked) {
    if (item.claimId) {
      if (seenClaims.has(item.claimId)) continue
      seenClaims.add(item.claimId)
    }
    collapsed.push(item)
  }

  const caps: Record<MemoryRecallLayer, number> = { core_fact: 4, state: 4, fragment: 5, episode: 2, saga: 1 }
  const used: Record<MemoryRecallLayer, number> = { core_fact: 0, state: 0, fragment: 0, episode: 0, saga: 0 }
  const items: MemoryRecallItem[] = []
  let estimatedTokens = 0
  const maxContextTokens = Math.max(100, options.maxContextTokens ?? 1200)
  for (const item of collapsed) {
    if (items.length >= (options.maxItems ?? 8) || used[item.layer] >= caps[item.layer]) continue
    const itemTokens = Math.max(1, Math.ceil((item.content.match(/[\u3400-\u9fff]/g)?.length ?? 0) + item.content.replace(/[\u3400-\u9fff]/g, " ").trim().split(/\s+/).filter(Boolean).length * 1.4))
    if (estimatedTokens + itemTokens > maxContextTokens) continue
    used[item.layer] += 1
    estimatedTokens += itemTokens
    items.push(item)
  }

  const selectedKeys = new Set(items.map((item) => `${item.layer}:${item.id}`))
  const rejected = ranked.filter((item) => !selectedKeys.has(`${item.layer}:${item.id}`))

  const touchFragment = db.prepare(`
    UPDATE memory_fragments SET last_accessed_at = ?, access_count = access_count + 1 WHERE id = ?
  `)
  const touchEpisode = db.prepare(`
    UPDATE memory_episodes SET last_accessed_at = ?, access_count = access_count + 1 WHERE id = ?
  `)
  if (options.recordAccess !== false) {
    for (const item of items) {
      if (item.layer === "fragment") touchFragment.run(now, item.id)
      if (item.layer === "episode") touchEpisode.run(now, item.id)
    }
  }

  const durationMs = Math.max(0, Date.now() - startedAt)
  db.prepare(`
    INSERT INTO memory_recall_log(
      id, query, intent, candidate_counts_json, injected_items_json,
      rejected_items_json, duration_ms, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    `recall_${randomUUID()}`,
    memoryLogPreview(query, 160),
    intent,
    JSON.stringify({
      total: candidates.size,
      terms: terms.length,
      mode: options.logMode ?? (options.purpose === "proactive" ? "proactive" : "active"),
      estimatedTokens,
      vectorRepairsQueued,
    }),
    JSON.stringify(items.map((item) => ({ id: item.id, layer: item.layer, permission: item.permission, score: item.score }))),
    JSON.stringify(rejected.map((item) => ({ id: item.id, layer: item.layer, score: item.score })).slice(0, 20)),
    durationMs,
    now,
  )

  return { intent, items, context: formatContext(intent, items), durationMs }
}
