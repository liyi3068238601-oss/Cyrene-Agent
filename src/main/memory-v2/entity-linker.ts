import { randomUUID } from "crypto"
import type { MemoryV2Database } from "./database"
import { attachRelationToClaim, ensureMemoryClaim, linkRelationToFragment } from "./claim-graph"

export interface LegacyEntityNode {
  id: string
  name: string
  type: "person" | "place" | "concept" | "preference" | "organization"
  aliases: string[]
  mentionCount: number
  firstMentionedAt: number
  lastMentionedAt: number
}

export interface LegacyEntityRelation {
  id: string
  sourceId: string
  targetId: string
  relation: string
  confidence: number
  strength: number
}

const ENTITY_TYPE_MAP: Record<LegacyEntityNode["type"], string> = {
  person: "person",
  place: "place",
  concept: "concept",
  preference: "interest",
  organization: "organization",
}

function entityId(legacyId: string): string {
  return `legacy_${legacyId}`
}

function relationEvidenceFragments(
  db: MemoryV2Database,
  sourceName: string,
  relationType: string,
  targetName: string,
): string[] {
  const source = sourceName.trim().toLocaleLowerCase("zh-CN")
  const relation = relationType.trim().toLocaleLowerCase("zh-CN")
  const target = targetName.trim().toLocaleLowerCase("zh-CN")
  if (!source || !relation || !target) return []
  return db.prepare(`
    SELECT id, content FROM memory_fragments
    WHERE status IN ('active', 'cooling', 'frozen')
    ORDER BY updated_at DESC
    LIMIT 1000
  `).all()
    .filter((row) => {
      const content = String(row.content).toLocaleLowerCase("zh-CN")
      return content.includes(source) && content.includes(relation) && content.includes(target)
    })
    .map((row) => String(row.id))
}

export function syncLegacyEntityGraph(
  db: MemoryV2Database,
  graph: { entities: LegacyEntityNode[]; relations: LegacyEntityRelation[] },
  now = Date.now(),
): { entities: number; relations: number } {
  let entities = 0
  let relations = 0
  db.transaction(() => {
    const upsertEntity = db.prepare(`
      INSERT INTO memory_entities(
        id, canonical_name, entity_type, aliases_json, overview, status,
        confidence, created_at, updated_at, merged_into
      ) VALUES (?, ?, ?, ?, '', 'active', ?, ?, ?, NULL)
      ON CONFLICT(id) DO UPDATE SET
        canonical_name = excluded.canonical_name,
        entity_type = excluded.entity_type,
        aliases_json = excluded.aliases_json,
        confidence = MAX(memory_entities.confidence, excluded.confidence),
        updated_at = excluded.updated_at
    `)
    for (const node of graph.entities) {
      const confidence = Math.min(0.95, 0.5 + Math.log2(Math.max(1, node.mentionCount)) * 0.08)
      upsertEntity.run(
        entityId(node.id),
        node.name.trim(),
        ENTITY_TYPE_MAP[node.type],
        JSON.stringify([...new Set(node.aliases.map((alias) => alias.trim()).filter(Boolean))]),
        confidence,
        node.firstMentionedAt || now,
        Math.max(node.lastMentionedAt || 0, now),
      )
      entities += 1
    }

    const knownIds = new Set(graph.entities.map((node) => node.id))
    const upsertRelation = db.prepare(`
      INSERT INTO memory_relations(
        id, claim_id, source_entity_id, relation_type, target_entity_id, confidence,
        valid_from, valid_until, status, created_at, updated_at, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        claim_id = excluded.claim_id,
        relation_type = excluded.relation_type,
        confidence = excluded.confidence,
        status = excluded.status,
        updated_at = excluded.updated_at,
        metadata_json = excluded.metadata_json
    `)
    for (const relation of graph.relations) {
      if (!knownIds.has(relation.sourceId) || !knownIds.has(relation.targetId)) continue
      const sourceName = graph.entities.find((entity) => entity.id === relation.sourceId)?.name ?? relation.sourceId
      const targetName = graph.entities.find((entity) => entity.id === relation.targetId)?.name ?? relation.targetId
      const evidenceFragments = relationEvidenceFragments(db, sourceName, relation.relation, targetName)
      const status = evidenceFragments.length > 0 ? "active" : "pending"
      const claimId = ensureMemoryClaim(db, {
        content: `${sourceName} ${relation.relation} ${targetName}`,
        claimType: "relationship",
        confidence: Math.max(0, Math.min(1, relation.confidence)),
        status,
        now,
        metadata: { legacyEntityGraph: true },
      })
      const relationId = `legacy_${relation.id}`
      upsertRelation.run(
        relationId,
        claimId,
        entityId(relation.sourceId),
        relation.relation,
        entityId(relation.targetId),
        Math.max(0, Math.min(1, relation.confidence)),
        status,
        now,
        now,
        JSON.stringify({
          legacyStrength: relation.strength,
          requiresEvidence: evidenceFragments.length === 0,
        }),
      )
      attachRelationToClaim(db, relationId, claimId, now)
      for (const fragmentId of evidenceFragments) linkRelationToFragment(db, relationId, fragmentId, now)
      relations += 1
    }
  })
  return { entities, relations }
}

function parseAliases(raw: unknown): string[] {
  try {
    const parsed = JSON.parse(String(raw ?? "[]"))
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []
  } catch {
    return []
  }
}

function containsName(content: string, name: string): boolean {
  const candidate = name.trim()
  if (candidate.length < 2) return false
  if (/^[a-z0-9 _.-]+$/i.test(candidate)) {
    return content.toLocaleLowerCase().includes(candidate.toLocaleLowerCase())
  }
  return content.includes(candidate)
}

export function linkKnownEntities(db: MemoryV2Database, limit = 500): number {
  const entities = db.prepare(`
    SELECT id, canonical_name, aliases_json
    FROM memory_entities WHERE status IN ('seed', 'active')
    ORDER BY updated_at DESC
  `).all()
  if (entities.length === 0) return 0

  const fragments = db.prepare(`
    SELECT f.id, f.content
    FROM memory_fragments f
    WHERE f.status IN ('active', 'cooling', 'frozen')
      AND EXISTS (
        SELECT 1 FROM memory_entities e
        WHERE e.status IN ('seed', 'active')
          AND NOT EXISTS (
            SELECT 1 FROM memory_fragment_entities fe
            WHERE fe.fragment_id = f.id AND fe.entity_id = e.id
          )
      )
    ORDER BY f.updated_at DESC LIMIT ?
  `).all(limit)

  let linked = 0
  const insert = db.prepare(`
    INSERT OR IGNORE INTO memory_fragment_entities(fragment_id, entity_id, role, confidence)
    VALUES (?, ?, 'mention', ?)
  `)
  db.transaction(() => {
    for (const fragment of fragments) {
      const content = String(fragment.content)
      for (const entity of entities) {
        const names = [String(entity.canonical_name), ...parseAliases(entity.aliases_json)]
        const matched = names.some((name) => containsName(content, name))
        if (!matched) continue
        const result = insert.run(String(fragment.id), String(entity.id), 0.9)
        linked += Number(result.changes)
      }
    }
  })
  return linked
}

export function refreshEntityOverviews(db: MemoryV2Database, now = Date.now()): number {
  const entities = db.prepare(`
    SELECT e.id, e.overview
    FROM memory_entities e
    WHERE e.status IN ('seed', 'active')
      AND (
        TRIM(e.overview) = '' OR EXISTS (
          SELECT 1 FROM memory_revisions r
          WHERE r.target_type = 'entity' AND r.target_id = e.id AND r.action = 'refresh_overview'
        )
      )
  `).all()
  let changed = 0
  db.transaction(() => {
    for (const entity of entities) {
      const fragments = db.prepare(`
        SELECT DISTINCT f.content
        FROM memory_fragment_entities fe
        JOIN memory_fragments f ON f.id = fe.fragment_id
        WHERE fe.entity_id = ? AND f.status IN ('active', 'cooling', 'frozen')
        ORDER BY f.importance DESC, f.confidence DESC, f.updated_at DESC
        LIMIT 3
      `).all(entity.id)
      const overview = [...new Set(fragments.map((row) => String(row.content).trim()).filter(Boolean))]
        .join("；")
        .slice(0, 280)
      if (!overview || overview === String(entity.overview)) continue
      db.prepare("UPDATE memory_entities SET overview = ?, updated_at = ? WHERE id = ?").run(overview, now, entity.id)
      db.prepare(`
        INSERT INTO memory_revisions(
          id, target_type, target_id, action, before_json, after_json,
          reason, confidence, actor, source_id, created_at
        ) VALUES (?, 'entity', ?, 'refresh_overview', ?, ?, ?, 1, 'system', NULL, ?)
      `).run(
        `revision_${randomUUID()}`,
        entity.id,
        JSON.stringify({ overview: entity.overview }),
        JSON.stringify({ overview }),
        "Entity overview rebuilt from its current evidence-backed Fragments.",
        now,
      )
      changed += 1
    }
  })
  return changed
}
