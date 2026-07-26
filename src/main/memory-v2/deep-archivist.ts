import { createHash, randomUUID } from "crypto"
import type { MemoryV2Database } from "./database"
import { enqueueVectorUpsert } from "./vector-sync"

export interface EpisodeCandidateFragment {
  id: string
  content: string
  kind: string
  createdAt: number
  sourceCount: number
  entityIds: string[]
}

export interface EpisodeCandidateGroup {
  key: string
  label: string
  fragments: EpisodeCandidateFragment[]
}

export interface EpisodeDraft {
  title: string
  content: string
  fragmentIds: string[]
  confidence: number
  importance: number
}

export interface DeepArchivistResult {
  candidateGroups: number
  draftsReceived: number
  episodesCreated: number
  draftsRejected: number
}

export type DeepArchivistModel = (
  messages: Array<{ role: "system" | "user"; content: string }>,
  maxTokens?: number,
) => Promise<string>

function parseJsonArray(raw: string): unknown[] {
  const text = raw.replace(/```(?:json)?/gi, "").trim()
  const start = text.indexOf("[")
  const end = text.lastIndexOf("]")
  if (start < 0 || end <= start) return []
  try {
    const value = JSON.parse(text.slice(start, end + 1))
    return Array.isArray(value) ? value : []
  } catch {
    return []
  }
}

function parseEntityIds(value: unknown): string[] {
  return String(value ?? "").split(",").map((item) => item.trim()).filter(Boolean)
}

function loadCandidates(db: MemoryV2Database, limit: number): EpisodeCandidateFragment[] {
  return db.prepare(`
    SELECT f.id, f.content, f.kind, f.created_at,
      COUNT(DISTINCT fs.source_id) AS source_count,
      GROUP_CONCAT(DISTINCT fe.entity_id) AS entity_ids
    FROM memory_fragments f
    LEFT JOIN memory_fragment_sources fs ON fs.fragment_id = f.id
    LEFT JOIN memory_fragment_entities fe ON fe.fragment_id = f.id
    WHERE f.status IN ('active', 'cooling')
      AND f.certainty <> 'uncertain'
      AND NOT EXISTS (
        SELECT 1 FROM memory_episode_fragments ef WHERE ef.fragment_id = f.id
      )
    GROUP BY f.id
    HAVING source_count > 0
    ORDER BY f.created_at ASC
    LIMIT ?
  `).all(limit).map((row) => ({
    id: String(row.id),
    content: String(row.content),
    kind: String(row.kind),
    createdAt: Number(row.created_at),
    sourceCount: Number(row.source_count),
    entityIds: parseEntityIds(row.entity_ids),
  }))
}

export function findEpisodeCandidateGroups(
  db: MemoryV2Database,
  options: { minFragments?: number; maxFragmentsPerGroup?: number; scanLimit?: number } = {},
): EpisodeCandidateGroup[] {
  const minFragments = Math.max(3, options.minFragments ?? 3)
  const maxFragments = Math.max(minFragments, options.maxFragmentsPerGroup ?? 10)
  const fragments = loadCandidates(db, options.scanLimit ?? 200)
  const groups = new Map<string, EpisodeCandidateFragment[]>()

  for (const fragment of fragments) {
    const keys = fragment.entityIds.length > 0
      ? fragment.entityIds.map((id) => `entity:${id}`)
      : [`kind:${fragment.kind}`]
    for (const key of keys) {
      const group = groups.get(key) ?? []
      if (group.length < maxFragments) group.push(fragment)
      groups.set(key, group)
    }
  }

  const entityNames = new Map(db.prepare(`
    SELECT id, canonical_name FROM memory_entities
  `).all().map((row) => [String(row.id), String(row.canonical_name)]))
  return [...groups.entries()]
    .filter(([, group]) => group.length >= minFragments)
    .sort((left, right) => right[1].length - left[1].length)
    .map(([key, group]) => ({
      key,
      label: key.startsWith("entity:") ? (entityNames.get(key.slice(7)) ?? key.slice(7)) : key.slice(5),
      fragments: group,
    }))
}

function promptForGroups(groups: EpisodeCandidateGroup[]): string {
  return groups.map((group, groupIndex) => [
    `GROUP ${groupIndex + 1} (${group.key} / ${group.label})`,
    ...group.fragments.map((fragment) => `- [${fragment.id}] ${fragment.content}`),
  ].join("\n")).join("\n\n")
}

function normalizeDraft(value: unknown): EpisodeDraft | null {
  if (!value || typeof value !== "object") return null
  const row = value as Record<string, unknown>
  const title = typeof row.title === "string" ? row.title.trim() : ""
  const content = typeof row.content === "string" ? row.content.trim() : ""
  const fragmentIds = Array.isArray(row.fragmentIds)
    ? [...new Set(row.fragmentIds.filter((id): id is string => typeof id === "string" && id.length > 0))]
    : []
  if (!title || !content || fragmentIds.length < 3) return null
  return {
    title: title.slice(0, 80),
    content,
    fragmentIds,
    confidence: Math.max(0.4, Math.min(1, Number(row.confidence ?? 0.7))),
    importance: Math.max(0.3, Math.min(1, Number(row.importance ?? 0.6))),
  }
}

function unsupportedAbsoluteClaim(content: string, sources: string[]): boolean {
  const sourceText = sources.join("\n")
  for (const phrase of content.match(/(?:永远|从来不|一定会|绝不会|唯一)[^，。！？]{0,24}/g) ?? []) {
    if (!sourceText.includes(phrase)) return true
  }
  const sourceNumbers = new Set(sourceText.match(/\d+(?:\.\d+)?/g) ?? [])
  return (content.match(/\d+(?:\.\d+)?/g) ?? []).some((number) => !sourceNumbers.has(number))
}

export function validateEpisodeDraft(
  draft: EpisodeDraft,
  allowed: Map<string, EpisodeCandidateFragment>,
): { valid: boolean; reason?: string } {
  if (draft.content.length < 40 || draft.content.length > 600) return { valid: false, reason: "invalid_length" }
  if (draft.fragmentIds.some((id) => !allowed.has(id))) return { valid: false, reason: "unknown_fragment" }
  const sources = draft.fragmentIds.map((id) => allowed.get(id)!.content)
  if (unsupportedAbsoluteClaim(draft.content, sources)) return { valid: false, reason: "unsupported_claim" }
  const sourceCharacters = new Set(sources.join("").replace(/[\s，。！？、；：,.!?;:'"“”‘’（）()\[\]]/g, ""))
  const contentCharacters = draft.content.replace(/[\s，。！？、；：,.!?;:'"“”‘’（）()\[\]]/g, "")
  const overlap = [...contentCharacters].filter((character) => sourceCharacters.has(character)).length / Math.max(1, contentCharacters.length)
  if (overlap < 0.45) return { valid: false, reason: "weak_source_overlap" }
  return { valid: true }
}

function episodeId(fragmentIds: string[]): string {
  const fingerprint = createHash("sha256").update([...fragmentIds].sort().join("\n")).digest("hex")
  return `episode_${fingerprint.slice(0, 24)}`
}

export function publishEpisodeDraft(
  db: MemoryV2Database,
  draft: EpisodeDraft,
  now = Date.now(),
): { created: boolean; episodeId: string } {
  const id = episodeId(draft.fragmentIds)
  if (db.prepare("SELECT 1 FROM memory_episodes WHERE id = ?").get(id)) return { created: false, episodeId: id }

  const rows = draft.fragmentIds.map((fragmentId) => db.prepare(`
    SELECT id, created_at FROM memory_fragments
    WHERE id = ? AND status IN ('active', 'cooling')
      AND EXISTS (SELECT 1 FROM memory_fragment_sources fs WHERE fs.fragment_id = memory_fragments.id)
  `).get(fragmentId))
  if (rows.some((row) => !row)) throw new Error("Episode draft references unavailable or unsupported fragments")
  const times = rows.map((row) => Number(row!.created_at))
  const fingerprint = id.slice("episode_".length)

  db.transaction(() => {
    db.prepare(`
      INSERT INTO memory_episodes(
        id, title, content, status, confidence, importance, starts_at, ends_at,
        created_at, updated_at, last_accessed_at, access_count, version,
        superseded_by, metadata_json
      ) VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, 0, 1, NULL, ?)
    `).run(
      id,
      draft.title,
      draft.content,
      draft.confidence,
      draft.importance,
      Math.min(...times),
      Math.max(...times),
      now,
      now,
      now,
      JSON.stringify({ fingerprint, generatedBy: "deep-archivist" }),
    )
    const linkFragment = db.prepare(`
      INSERT INTO memory_episode_fragments(episode_id, fragment_id, position) VALUES (?, ?, ?)
    `)
    draft.fragmentIds.forEach((fragmentId, position) => linkFragment.run(id, fragmentId, position))
    db.prepare(`
      INSERT OR IGNORE INTO memory_episode_sources(episode_id, source_id)
      SELECT ?, fs.source_id
      FROM memory_fragment_sources fs
      WHERE fs.fragment_id IN (${draft.fragmentIds.map(() => "?").join(",")})
    `).run(id, ...draft.fragmentIds)
    db.prepare(`
      INSERT INTO memory_revisions(
        id, target_type, target_id, action, before_json, after_json,
        reason, confidence, actor, source_id, created_at
      ) VALUES (?, 'episode', ?, 'create', NULL, ?, ?, ?, 'assistant', NULL, ?)
    `).run(
      `revision_${randomUUID()}`,
      id,
      JSON.stringify({ title: draft.title, fragmentIds: draft.fragmentIds, version: 1 }),
      "Deep Archivist created an evidence-backed Episode.",
      draft.confidence,
      now,
    )
    enqueueVectorUpsert(db, "episode", id, now, 10)
  })
  return { created: true, episodeId: id }
}

export async function runDeepArchivist(
  db: MemoryV2Database,
  model: DeepArchivistModel,
  now = Date.now(),
): Promise<DeepArchivistResult> {
  const groups = findEpisodeCandidateGroups(db)
  if (groups.length === 0) return { candidateGroups: 0, draftsReceived: 0, episodesCreated: 0, draftsRejected: 0 }
  const allowed = new Map(groups.flatMap((group) => group.fragments).map((fragment) => [fragment.id, fragment]))
  const raw = await model([
    {
      role: "system",
      content: [
        "你是 Cyrene 记忆系统的 Archivist。把同一事件或项目阶段的原子记忆整理为 Episode。",
        "只使用给出的 fragment，不补充来源中不存在的动机、结果、时间或评价。",
        "每个 Episode 至少引用 3 个 fragment；正文建议 100-300 个汉字。",
        "输出 JSON 数组，每项字段：title、content、fragmentIds、confidence、importance。不要输出解释。",
      ].join("\n"),
    },
    { role: "user", content: promptForGroups(groups) },
  ], 50000)
  const normalized = parseJsonArray(raw).map(normalizeDraft).filter((draft): draft is EpisodeDraft => Boolean(draft))
  let created = 0
  let rejected = 0
  for (const draft of normalized) {
    const validation = validateEpisodeDraft(draft, allowed)
    if (!validation.valid) {
      rejected += 1
      continue
    }
    try {
      if (publishEpisodeDraft(db, draft, now).created) created += 1
    } catch {
      rejected += 1
    }
  }
  return {
    candidateGroups: groups.length,
    draftsReceived: normalized.length,
    episodesCreated: created,
    draftsRejected: rejected,
  }
}
