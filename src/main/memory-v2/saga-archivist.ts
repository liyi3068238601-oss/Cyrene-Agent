import { createHash, randomUUID } from "crypto"
import type { MemoryV2Database } from "./database"
import type { DeepArchivistModel } from "./deep-archivist"

export interface SagaCandidateEpisode {
  id: string
  title: string
  content: string
  createdAt: number
  entityIds: string[]
}

export interface SagaCandidateGroup {
  key: string
  label: string
  episodes: SagaCandidateEpisode[]
}

export interface SagaDraft {
  theme: string
  content: string
  episodeIds: string[]
  confidence: number
}

export interface SagaArchivistResult {
  candidateGroups: number
  draftsReceived: number
  sagasCreated: number
  draftsRejected: number
}

function parseIds(value: unknown): string[] {
  return String(value ?? "").split(",").map((item) => item.trim()).filter(Boolean)
}

export function findSagaCandidateGroups(db: MemoryV2Database, minEpisodes = 3): SagaCandidateGroup[] {
  const episodes = db.prepare(`
    SELECT ep.id, ep.title, ep.content, ep.created_at,
      GROUP_CONCAT(DISTINCT fe.entity_id) AS entity_ids
    FROM memory_episodes ep
    JOIN memory_episode_fragments ef ON ef.episode_id = ep.id
    LEFT JOIN memory_fragment_entities fe ON fe.fragment_id = ef.fragment_id
    WHERE ep.status IN ('active', 'mature', 'archived')
    GROUP BY ep.id
    ORDER BY ep.created_at ASC
  `).all().map((row): SagaCandidateEpisode => ({
    id: String(row.id),
    title: String(row.title),
    content: String(row.content),
    createdAt: Number(row.created_at),
    entityIds: parseIds(row.entity_ids),
  }))
  const groups = new Map<string, SagaCandidateEpisode[]>()
  for (const episode of episodes) {
    for (const entityId of episode.entityIds) {
      const group = groups.get(entityId) ?? []
      group.push(episode)
      groups.set(entityId, group)
    }
  }
  const names = new Map(db.prepare("SELECT id, canonical_name FROM memory_entities").all()
    .map((row) => [String(row.id), String(row.canonical_name)]))
  return [...groups.entries()]
    .filter(([, group]) => group.length >= Math.max(3, minEpisodes))
    .map(([key, group]) => ({ key, label: names.get(key) ?? key, episodes: group.slice(-12) }))
    .sort((left, right) => right.episodes.length - left.episodes.length)
}

function parseDrafts(raw: string): SagaDraft[] {
  const text = raw.replace(/```(?:json)?/gi, "").trim()
  const start = text.indexOf("[")
  const end = text.lastIndexOf("]")
  if (start < 0 || end <= start) return []
  try {
    const rows = JSON.parse(text.slice(start, end + 1))
    if (!Array.isArray(rows)) return []
    return rows.map((value): SagaDraft | null => {
      if (!value || typeof value !== "object") return null
      const row = value as Record<string, unknown>
      const theme = typeof row.theme === "string" ? row.theme.trim() : ""
      const content = typeof row.content === "string" ? row.content.trim() : ""
      const episodeIds = Array.isArray(row.episodeIds)
        ? [...new Set(row.episodeIds.filter((id): id is string => typeof id === "string"))]
        : []
      if (!theme || !content || episodeIds.length < 3) return null
      return {
        theme: theme.slice(0, 100),
        content,
        episodeIds,
        confidence: Math.max(0.35, Math.min(0.85, Number(row.confidence ?? 0.65))),
      }
    }).filter((draft): draft is SagaDraft => Boolean(draft))
  } catch {
    return []
  }
}

export function validateSagaDraft(draft: SagaDraft, allowed: Map<string, SagaCandidateEpisode>): boolean {
  if (draft.content.length < 80 || draft.content.length > 1200) return false
  if (draft.episodeIds.some((id) => !allowed.has(id))) return false
  const sources = draft.episodeIds.map((id) => allowed.get(id)!.content).join("\n")
  const sourceNumbers = new Set(sources.match(/\d+(?:\.\d+)?/g) ?? [])
  if ((draft.content.match(/\d+(?:\.\d+)?/g) ?? []).some((number) => !sourceNumbers.has(number))) return false
  if (/(?:永远|从来不|唯一|绝不会)/.test(draft.content) && !/(?:永远|从来不|唯一|绝不会)/.test(sources)) return false
  return true
}

function sagaFingerprint(episodeIds: string[]): string {
  return createHash("sha256").update([...episodeIds].sort().join("\n")).digest("hex")
}

export function publishSagaDraft(
  db: MemoryV2Database,
  draft: SagaDraft,
  now = Date.now(),
): { created: boolean; sagaId: string } {
  const fingerprint = sagaFingerprint(draft.episodeIds)
  const existingFingerprint = db.prepare(`
    SELECT id FROM memory_sagas WHERE metadata_json LIKE ?
  `).get(`%\"fingerprint\":\"${fingerprint}\"%`)
  if (existingFingerprint) return { created: false, sagaId: String(existingFingerprint.id) }

  const episodes = draft.episodeIds.map((id) => db.prepare(`
    SELECT id, starts_at, ends_at, created_at FROM memory_episodes
    WHERE id = ? AND status IN ('active', 'mature', 'archived')
  `).get(id))
  if (episodes.some((episode) => !episode)) throw new Error("Saga draft references unavailable Episodes")
  const previous = db.prepare(`
    SELECT id, version FROM memory_sagas
    WHERE status = 'active' AND lower(theme) = lower(?)
    ORDER BY version DESC LIMIT 1
  `).get(draft.theme)
  const version = Number(previous?.version ?? 0) + 1
  const sagaId = `saga_${fingerprint.slice(0, 20)}_v${version}`
  const startsAt = Math.min(...episodes.map((episode) => Number(episode!.starts_at ?? episode!.created_at)))
  const endsAt = Math.max(...episodes.map((episode) => Number(episode!.ends_at ?? episode!.created_at)))

  db.transaction(() => {
    db.prepare(`
      INSERT INTO memory_sagas(
        id, theme, content, status, confidence, starts_at, ends_at,
        created_at, updated_at, version, superseded_by, metadata_json
      ) VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, NULL, ?)
    `).run(
      sagaId,
      draft.theme,
      draft.content,
      draft.confidence,
      startsAt,
      endsAt,
      now,
      now,
      version,
      JSON.stringify({ fingerprint, generatedBy: "deep-archivist" }),
    )
    const link = db.prepare(`INSERT INTO memory_saga_episodes(saga_id, episode_id, position) VALUES (?, ?, ?)`)
    draft.episodeIds.forEach((episodeId, position) => link.run(sagaId, episodeId, position))
    if (previous) {
      db.prepare(`UPDATE memory_sagas SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE id = ?`)
        .run(sagaId, now, previous.id)
    }
    db.prepare(`
      INSERT INTO memory_revisions(
        id, target_type, target_id, action, before_json, after_json,
        reason, confidence, actor, source_id, created_at
      ) VALUES (?, 'saga', ?, ?, ?, ?, ?, ?, 'assistant', NULL, ?)
    `).run(
      `revision_${randomUUID()}`,
      sagaId,
      previous ? "version" : "create",
      previous ? JSON.stringify({ previousId: previous.id, previousVersion: previous.version }) : null,
      JSON.stringify({ version, episodeIds: draft.episodeIds }),
      "Deep Archivist generated a weak, evidence-linked long-term narrative.",
      draft.confidence,
      now,
    )
  })
  return { created: true, sagaId }
}

export async function runSagaArchivist(
  db: MemoryV2Database,
  model: DeepArchivistModel,
  now = Date.now(),
): Promise<SagaArchivistResult> {
  const groups = findSagaCandidateGroups(db)
  if (groups.length === 0) return { candidateGroups: 0, draftsReceived: 0, sagasCreated: 0, draftsRejected: 0 }
  const allowed = new Map(groups.flatMap((group) => group.episodes).map((episode) => [episode.id, episode]))
  const prompt = groups.map((group) => [
    `THEME CANDIDATE (${group.label})`,
    ...group.episodes.map((episode) => `- [${episode.id}] ${episode.title}: ${episode.content}`),
  ].join("\n")).join("\n\n")
  const raw = await model([
    {
      role: "system",
      content: [
        "你是 Cyrene 的长期记忆 Archivist。把至少三个 Episode 整理成长期 Saga。",
        "Saga 是弱叙事，只能概括给定 Episode，不得增加新的事实、数字、动机或保证。",
        "输出 JSON 数组，每项字段：theme、content、episodeIds、confidence。不要输出解释。",
      ].join("\n"),
    },
    { role: "user", content: prompt },
  ], 1800)
  const drafts = parseDrafts(raw)
  let created = 0
  let rejected = 0
  for (const draft of drafts) {
    if (!validateSagaDraft(draft, allowed)) {
      rejected += 1
      continue
    }
    try {
      if (publishSagaDraft(db, draft, now).created) created += 1
    } catch {
      rejected += 1
    }
  }
  return { candidateGroups: groups.length, draftsReceived: drafts.length, sagasCreated: created, draftsRejected: rejected }
}
