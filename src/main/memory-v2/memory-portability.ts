import { createHash, randomUUID } from "crypto"
import type { MemoryV2Database } from "./database"
import { backfillMemoryClaims } from "./claim-graph"
import { enqueueVectorUpsert } from "./vector-sync"
import { memoryLogPreview } from "./shadow-recall"

export const MEMORY_EXPORT_FORMAT = "cyrene-memory-v2"
export const MEMORY_EXPORT_VERSION = 1

const DATA_TABLES = [
  "core_profile",
  "core_facts",
  "memory_sources",
  "memory_claims",
  "memory_fragments",
  "memory_entities",
  "memory_relations",
  "memory_states",
  "memory_episodes",
  "memory_sagas",
  "memory_fragment_sources",
  "memory_fragment_entities",
  "memory_relation_sources",
  "memory_relation_fragments",
  "memory_state_sources",
  "memory_state_fragments",
  "memory_episode_sources",
  "memory_episode_fragments",
  "memory_saga_episodes",
  "memory_revisions",
] as const

type ExportTable = typeof DATA_TABLES[number]
type ExportRow = Record<string, unknown>

export interface MemoryExportPackage {
  format: typeof MEMORY_EXPORT_FORMAT
  exportVersion: typeof MEMORY_EXPORT_VERSION
  schemaVersion: number
  exportedAt: number
  privacy: {
    fullChatArchivesIncluded: false
    scribeEventTextIncluded: false
    apiConfigurationIncluded: false
    sourceContextIncluded: false
  }
  data: Record<ExportTable, ExportRow[]>
  checksum: string
}

export interface MemoryImportResult {
  importedRows: number
  backfilledClaims: number
  queuedVectorUpserts: number
}

function redactSourceRow(row: ExportRow): ExportRow {
  return {
    ...row,
    quote: memoryLogPreview(String(row.quote ?? ""), 600),
    context_before: null,
    context_after: null,
  }
}

function exportData(db: MemoryV2Database): Record<ExportTable, ExportRow[]> {
  return Object.fromEntries(DATA_TABLES.map((table) => {
    const rows = db.prepare(`SELECT * FROM ${table}`).all()
    return [table, table === "memory_sources" ? rows.map(redactSourceRow) : rows]
  })) as Record<ExportTable, ExportRow[]>
}

function packageChecksum(data: Record<ExportTable, ExportRow[]>): string {
  return createHash("sha256").update(JSON.stringify(data)).digest("hex")
}

export function createMemoryExport(db: MemoryV2Database, now = Date.now()): MemoryExportPackage {
  const data = exportData(db)
  return {
    format: MEMORY_EXPORT_FORMAT,
    exportVersion: MEMORY_EXPORT_VERSION,
    schemaVersion: db.getSchemaVersion(),
    exportedAt: now,
    privacy: {
      fullChatArchivesIncluded: false,
      scribeEventTextIncluded: false,
      apiConfigurationIncluded: false,
      sourceContextIncluded: false,
    },
    data,
    checksum: packageChecksum(data),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

export function validateMemoryExport(value: unknown): value is MemoryExportPackage {
  if (!isRecord(value)) return false
  if (value.format !== MEMORY_EXPORT_FORMAT || value.exportVersion !== MEMORY_EXPORT_VERSION) return false
  if (!isRecord(value.data) || typeof value.checksum !== "string") return false
  for (const table of DATA_TABLES) {
    const rows = value.data[table]
    if (!Array.isArray(rows) || rows.length > 100_000 || rows.some((row) => !isRecord(row))) return false
  }
  return packageChecksum(value.data as Record<ExportTable, ExportRow[]>) === value.checksum
}

function tableColumns(db: MemoryV2Database, table: string): string[] {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((row) => String(row.name))
}

function insertRows(
  db: MemoryV2Database,
  table: ExportTable,
  rows: ExportRow[],
  deferredColumns: Set<string> = new Set(),
): number {
  if (rows.length === 0) return 0
  const allowed = new Set(tableColumns(db, table))
  let inserted = 0
  for (const row of rows) {
    const columns = Object.keys(row).filter((column) => allowed.has(column))
    if (columns.length === 0) continue
    const values = columns.map((column) => deferredColumns.has(column) ? null : row[column] ?? null)
    db.prepare(`
      INSERT INTO ${table}(${columns.join(", ")})
      VALUES (${columns.map(() => "?").join(", ")})
    `).run(...values)
    inserted += 1
  }
  return inserted
}

function restoreDeferredLinks(
  db: MemoryV2Database,
  table: "memory_claims" | "memory_fragments" | "memory_entities" | "memory_states" | "memory_episodes" | "memory_sagas",
  column: "superseded_by" | "merged_into",
  rows: ExportRow[],
): void {
  const update = db.prepare(`UPDATE ${table} SET ${column} = ? WHERE id = ?`)
  for (const row of rows) {
    if (typeof row.id === "string" && typeof row[column] === "string") update.run(row[column], row.id)
  }
}

export function replaceMemoryFromExport(
  db: MemoryV2Database,
  value: unknown,
  now = Date.now(),
): MemoryImportResult {
  if (!validateMemoryExport(value)) throw new Error("Invalid or corrupted Cyrene Memory v2 export")
  const data = value.data
  let importedRows = 0
  let queuedVectorUpserts = 0
  let backfilledClaims = 0

  db.transaction(() => {
    for (const table of [
      "memory_saga_episodes", "memory_episode_fragments", "memory_episode_sources",
      "memory_state_fragments", "memory_state_sources", "memory_relation_fragments",
      "memory_relation_sources", "memory_fragment_entities", "memory_fragment_sources",
      "memory_revisions", "memory_event_log", "memory_vector_index", "memory_jobs",
      "memory_recall_log", "memory_shadow_recall_log", "memory_sagas", "memory_episodes",
      "memory_relations", "memory_states", "memory_fragments", "memory_entities",
      "memory_claims", "core_facts", "core_profile", "memory_sources",
    ]) db.prepare(`DELETE FROM ${table}`).run()

    importedRows += insertRows(db, "core_profile", data.core_profile)
    importedRows += insertRows(db, "core_facts", data.core_facts, new Set(["superseded_by"]))
    importedRows += insertRows(db, "memory_sources", data.memory_sources)
    importedRows += insertRows(db, "memory_claims", data.memory_claims, new Set(["superseded_by"]))
    importedRows += insertRows(db, "memory_fragments", data.memory_fragments, new Set(["superseded_by"]))
    importedRows += insertRows(db, "memory_entities", data.memory_entities, new Set(["merged_into"]))
    importedRows += insertRows(db, "memory_relations", data.memory_relations)
    importedRows += insertRows(db, "memory_states", data.memory_states, new Set(["superseded_by"]))
    importedRows += insertRows(db, "memory_episodes", data.memory_episodes, new Set(["superseded_by"]))
    importedRows += insertRows(db, "memory_sagas", data.memory_sagas, new Set(["superseded_by"]))

    for (const table of [
      "memory_fragment_sources", "memory_fragment_entities", "memory_relation_sources",
      "memory_relation_fragments", "memory_state_sources", "memory_state_fragments",
      "memory_episode_sources", "memory_episode_fragments", "memory_saga_episodes",
      "memory_revisions",
    ] as const) importedRows += insertRows(db, table, data[table])

    restoreDeferredLinks(db, "memory_claims", "superseded_by", data.memory_claims)
    restoreDeferredLinks(db, "memory_fragments", "superseded_by", data.memory_fragments)
    restoreDeferredLinks(db, "memory_entities", "merged_into", data.memory_entities)
    restoreDeferredLinks(db, "memory_states", "superseded_by", data.memory_states)
    restoreDeferredLinks(db, "memory_episodes", "superseded_by", data.memory_episodes)
    restoreDeferredLinks(db, "memory_sagas", "superseded_by", data.memory_sagas)
    const coreFactUpdate = db.prepare("UPDATE core_facts SET superseded_by = ? WHERE id = ?")
    for (const row of data.core_facts) {
      if (typeof row.id === "string" && typeof row.superseded_by === "string") coreFactUpdate.run(row.superseded_by, row.id)
    }

    const backfill = backfillMemoryClaims(db, now, { transaction: false })
    backfilledClaims = backfill.claims
    for (const row of db.prepare(`SELECT id FROM memory_fragments WHERE status IN ('active', 'cooling')`).all()) {
      enqueueVectorUpsert(db, "fragment", String(row.id), now, 50)
      queuedVectorUpserts += 1
    }
    for (const row of db.prepare(`SELECT id FROM memory_episodes WHERE status IN ('active', 'mature')`).all()) {
      enqueueVectorUpsert(db, "episode", String(row.id), now, 40)
      queuedVectorUpserts += 1
    }
    db.prepare(`
      INSERT INTO memory_meta(key, value, updated_at) VALUES ('portability.lastImport', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(JSON.stringify({ importId: randomUUID(), exportedAt: value.exportedAt, importedRows }), now)
  })

  return { importedRows, backfilledClaims, queuedVectorUpserts }
}
