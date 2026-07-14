import { randomUUID } from "crypto"
import type { MemoryV2Database } from "./database"

function parseAliases(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value ?? "[]"))
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : []
  } catch {
    return []
  }
}

function normalizeName(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/\s+/g, " ").trim()
}

function createsMergeCycle(db: MemoryV2Database, sourceId: string, targetId: string): boolean {
  let current: string | null = targetId
  const seen = new Set<string>()
  while (current && !seen.has(current)) {
    if (current === sourceId) return true
    seen.add(current)
    const row = db.prepare("SELECT merged_into FROM memory_entities WHERE id = ?").get(current)
    current = typeof row?.merged_into === "string" ? row.merged_into : null
  }
  return false
}

function addMergeRevision(
  db: MemoryV2Database,
  targetType: "entity" | "relation",
  targetId: string,
  before: unknown,
  after: unknown,
  reason: string,
  now: number,
): void {
  db.prepare(`
    INSERT INTO memory_revisions(
      id, target_type, target_id, action, before_json, after_json,
      reason, confidence, actor, source_id, created_at
    ) VALUES (?, ?, ?, 'merge', ?, ?, ?, 1, 'user', NULL, ?)
  `).run(`revision_${randomUUID()}`, targetType, targetId, JSON.stringify(before), JSON.stringify(after), reason, now)
}

function mergeDuplicateRelations(db: MemoryV2Database, now: number): number {
  const rows = db.prepare(`
    SELECT * FROM memory_relations WHERE status IN ('pending', 'active')
    ORDER BY confidence DESC, created_at ASC, id ASC
  `).all()
  const keepers = new Map<string, Record<string, unknown>>()
  let merged = 0
  for (const row of rows) {
    if (String(row.source_entity_id) === String(row.target_entity_id)) {
      db.prepare("UPDATE memory_relations SET status = 'deleted', updated_at = ? WHERE id = ?").run(now, row.id)
      addMergeRevision(db, "relation", String(row.id), row, { status: "deleted" }, "Entity merge produced a non-meaningful self relation.", now)
      merged += 1
      continue
    }
    const key = `${row.source_entity_id}\u0000${normalizeName(String(row.relation_type))}\u0000${row.target_entity_id}`
    const keeper = keepers.get(key)
    if (!keeper) {
      keepers.set(key, row)
      continue
    }
    const keeperId = String(keeper.id)
    const duplicateId = String(row.id)
    db.prepare(`
      INSERT OR IGNORE INTO memory_relation_sources(relation_id, source_id)
      SELECT ?, source_id FROM memory_relation_sources WHERE relation_id = ?
    `).run(keeperId, duplicateId)
    db.prepare(`
      INSERT OR IGNORE INTO memory_relation_fragments(
        relation_id, fragment_id, fragment_revision, evidence_role, created_at
      ) SELECT ?, fragment_id, fragment_revision, evidence_role, created_at
        FROM memory_relation_fragments WHERE relation_id = ?
    `).run(keeperId, duplicateId)
    db.prepare(`
      UPDATE memory_relations
      SET status = 'superseded', updated_at = ?,
          metadata_json = json_set(metadata_json, '$.mergedInto', ?)
      WHERE id = ?
    `).run(now, keeperId, duplicateId)
    addMergeRevision(db, "relation", duplicateId, row, { status: "superseded", mergedInto: keeperId }, "Duplicate relation collapsed after entity merge.", now)
    merged += 1
  }
  return merged
}

export function mergeMemoryEntities(
  db: MemoryV2Database,
  sourceId: string,
  targetId: string,
  now = Date.now(),
  options: { transaction?: boolean; actor?: "user" | "system" } = {},
): { merged: boolean; relationsCollapsed: number } {
  if (!sourceId || !targetId || sourceId === targetId) return { merged: false, relationsCollapsed: 0 }
  let result = { merged: false, relationsCollapsed: 0 }
  const work = () => {
    const source = db.prepare("SELECT * FROM memory_entities WHERE id = ? AND status IN ('seed', 'active')").get(sourceId)
    const target = db.prepare("SELECT * FROM memory_entities WHERE id = ? AND status IN ('seed', 'active')").get(targetId)
    if (!source || !target || source.entity_type !== target.entity_type || createsMergeCycle(db, sourceId, targetId)) return

    const aliases = [...new Set(
      [
        ...parseAliases(target.aliases_json),
        String(source.canonical_name),
        ...parseAliases(source.aliases_json),
      ]
        .map((item) => item.trim())
        .filter((item) => item && normalizeName(item) !== normalizeName(String(target.canonical_name))),
    )]
    const overview = String(target.overview ?? "").trim() || String(source.overview ?? "").trim()
    db.prepare(`
      UPDATE memory_entities
      SET aliases_json = ?, overview = ?, confidence = MAX(confidence, ?), updated_at = ?
      WHERE id = ?
    `).run(JSON.stringify(aliases), overview, source.confidence, now, targetId)
    db.prepare(`
      INSERT OR IGNORE INTO memory_fragment_entities(fragment_id, entity_id, role, confidence)
      SELECT fragment_id, ?, role, confidence FROM memory_fragment_entities WHERE entity_id = ?
    `).run(targetId, sourceId)
    db.prepare("DELETE FROM memory_fragment_entities WHERE entity_id = ?").run(sourceId)
    db.prepare("UPDATE memory_relations SET source_entity_id = ?, updated_at = ? WHERE source_entity_id = ?").run(targetId, now, sourceId)
    db.prepare("UPDATE memory_relations SET target_entity_id = ?, updated_at = ? WHERE target_entity_id = ?").run(targetId, now, sourceId)
    db.prepare(`
      UPDATE memory_entities SET status = 'merged', merged_into = ?, updated_at = ? WHERE id = ?
    `).run(targetId, now, sourceId)
    result.relationsCollapsed = mergeDuplicateRelations(db, now)
    const actor = options.actor ?? "user"
    db.prepare(`
      INSERT INTO memory_revisions(
        id, target_type, target_id, action, before_json, after_json,
        reason, confidence, actor, source_id, created_at
      ) VALUES (?, 'entity', ?, 'merge', ?, ?, ?, 1, ?, NULL, ?)
    `).run(
      `revision_${randomUUID()}`,
      sourceId,
      JSON.stringify(source),
      JSON.stringify({ status: "merged", mergedInto: targetId }),
      "Entity aliases and evidence links were merged into a canonical entity.",
      actor,
      now,
    )
    result.merged = true
  }
  if (options.transaction === false) work()
  else db.transaction(work)
  return result
}

export function mergeExactDuplicateEntities(db: MemoryV2Database, now = Date.now()): number {
  const rows = db.prepare(`
    SELECT id, canonical_name, entity_type, created_at
    FROM memory_entities WHERE status IN ('seed', 'active')
    ORDER BY created_at ASC, id ASC
  `).all()
  const keepers = new Map<string, string>()
  let merged = 0
  db.transaction(() => {
    for (const row of rows) {
      const key = `${row.entity_type}:${normalizeName(String(row.canonical_name))}`
      const keeper = keepers.get(key)
      if (!keeper) {
        keepers.set(key, String(row.id))
        continue
      }
      if (mergeMemoryEntities(db, String(row.id), keeper, now, { transaction: false, actor: "system" }).merged) merged += 1
    }
  })
  return merged
}
