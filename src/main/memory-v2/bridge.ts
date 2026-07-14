import { randomUUID } from "crypto"
import type { MemoryStore } from "../memory/memory-types"
import { appendMemoryTrace } from "../memory/memory-trace"
import { MemoryV2Database, getDefaultMemoryV2Path, type MemoryV2Health } from "./database"
import { migrateLegacyStore, syncLegacySnapshot, type LegacyMigrationResult } from "./legacy-migrator"
import { archiveConversation, type ConversationArchiveResult } from "./conversation-archive"
import type { ChatSession } from "../../shared/chat-types"
import { initializeMemoryAutomationRuntime } from "./memory-runtime"
import {
  appendScribeTurn,
  claimPendingScribeEvents,
  completeScribeEvents,
  countPendingScribeEvents,
  failScribeEvents,
  resetInterruptedScribeEvents,
  type MemoryScribeEvent,
} from "./scribe-queue"
import {
  confirmPendingMemory,
  listPendingMemories,
  proposeScreenObservation,
  rejectPendingMemory,
  type PendingMemoryItem,
} from "./pending-memory"

export type MemoryEngineMode = "legacy" | "v2-shadow" | "v2"

export interface MemoryV2BridgeStatus {
  mode: MemoryEngineMode
  initialized: boolean
  path?: string
  health?: MemoryV2Health
  lastSyncAt?: number
  lastError?: string
}

let mode: MemoryEngineMode = "v2-shadow"
let database: MemoryV2Database | null = null
let lastSyncAt: number | undefined
let lastError: string | undefined

function queueRepair(store: MemoryStore, error: unknown): void {
  if (!database) return
  const now = Date.now()
  const message = error instanceof Error ? error.message : String(error)
  try {
    database.prepare(`
      INSERT INTO memory_jobs(
        id, job_type, idempotency_key, payload_json, status, priority,
        attempt_count, next_run_at, last_error, created_at, updated_at
      ) VALUES (?, 'legacy_snapshot_repair', 'legacy_snapshot_repair', ?, 'pending', 100, 0, ?, ?, ?, ?)
      ON CONFLICT(idempotency_key) DO UPDATE SET
        payload_json = excluded.payload_json,
        status = 'pending',
        next_run_at = excluded.next_run_at,
        last_error = excluded.last_error,
        updated_at = excluded.updated_at
    `).run(
      `job_${randomUUID()}`,
      JSON.stringify({ schemaVersion: store.schemaVersion }),
      now + 60_000,
      message,
      now,
      now,
    )
  } catch {
    // The database itself may be unavailable; keep the legacy write successful.
  }
}

export function initializeMemoryV2(
  userDataPath: string,
  legacyStore: MemoryStore,
  requestedMode: MemoryEngineMode = "v2-shadow",
): LegacyMigrationResult | null {
  mode = requestedMode
  if (mode === "legacy") return null
  if (database) return migrateLegacyStore(database, legacyStore)

  const dbPath = getDefaultMemoryV2Path(userDataPath)
  try {
    database = new MemoryV2Database(dbPath)
    initializeMemoryAutomationRuntime(database)
    resetInterruptedScribeEvents(database)
    const result = migrateLegacyStore(database, legacyStore)
    lastSyncAt = Date.now()
    lastError = undefined
    appendMemoryTrace({
      op: "v2.initialize",
      layer: "migration",
      status: "ok",
      details: { dbPath, mode, result, health: database.getHealth() },
    })
    return result
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error)
    database?.close()
    database = null
    appendMemoryTrace({
      op: "v2.initialize",
      layer: "migration",
      status: "error",
      error: lastError,
      details: { dbPath, mode },
    })
    throw error
  }
}

export function mirrorLegacyStoreToMemoryV2(store: MemoryStore): boolean {
  // Legacy snapshots are only a comparison feed. Once v2 is authoritative,
  // mirroring old files back would overwrite edits made in the v2 memory UI.
  if (mode !== "v2-shadow" || !database) return false
  try {
    syncLegacySnapshot(database, store)
    lastSyncAt = Date.now()
    lastError = undefined
    return true
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error)
    queueRepair(store, error)
    appendMemoryTrace({
      op: "v2.shadowWrite",
      layer: "migration",
      status: "error",
      error: lastError,
      details: { schemaVersion: store.schemaVersion },
    })
    return false
  }
}

export function getMemoryEngineMode(): MemoryEngineMode {
  return mode
}

export function setMemoryEngineMode(nextMode: MemoryEngineMode): MemoryV2BridgeStatus {
  mode = nextMode
  appendMemoryTrace({
    op: "v2.modeChange",
    layer: "migration",
    status: "ok",
    details: { mode: nextMode, initialized: Boolean(database) },
  })
  return getMemoryV2BridgeStatus()
}

export function backupMemoryV2(): string | null {
  if (!database) return null
  return database.backup()
}

export function getMemoryV2BridgeStatus(): MemoryV2BridgeStatus {
  return {
    mode,
    initialized: Boolean(database),
    path: database?.path,
    health: database?.getHealth(),
    lastSyncAt,
    lastError,
  }
}

export function closeMemoryV2(): void {
  database?.close()
  database = null
}

export function archiveConversationToMemoryV2(session: ChatSession): ConversationArchiveResult | null {
  if (!database || mode === "legacy") return null
  try {
    const result = archiveConversation(database, session)
    lastError = undefined
    return result
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error)
    const now = Date.now()
    try {
      database.prepare(`
        UPDATE deleted_conversations
        SET archive_status = 'failed', last_error = ?, updated_at = ?
        WHERE conversation_id = ?
      `).run(lastError, now, session.id)
    } catch {
      // Preserve the archive error.
    }
    return null
  }
}

export function getMemoryV2Database(): MemoryV2Database | null {
  return database
}

export const getMemoryV2DatabaseForTesting = getMemoryV2Database

export function enqueueMemoryScribeTurn(
  userText: string,
  assistantText: string,
  conversationId: string,
): MemoryScribeEvent | null {
  if (!database || mode === "legacy") return null
  return appendScribeTurn(database, userText, assistantText, conversationId)
}

export function getPendingMemoryScribeCount(): number {
  if (!database || mode === "legacy") return 0
  return countPendingScribeEvents(database)
}

export function claimMemoryScribeEvents(limit: number): MemoryScribeEvent[] {
  if (!database || mode === "legacy") return []
  return claimPendingScribeEvents(database, limit)
}

export function completeMemoryScribeEvents(ids: string[]): number {
  if (!database || mode === "legacy") return 0
  return completeScribeEvents(database, ids)
}

export function failMemoryScribeEvents(ids: string[], error: unknown): number {
  if (!database || mode === "legacy") return 0
  return failScribeEvents(database, ids, error)
}

export function proposeScreenObservationMemory(text: string, observedAt = Date.now()): PendingMemoryItem | null {
  if (!database || mode === "legacy") return null
  return proposeScreenObservation(database, text, observedAt)
}

export function getPendingMemoryItems(limit = 100): PendingMemoryItem[] {
  if (!database || mode === "legacy") return []
  return listPendingMemories(database, limit)
}

export function confirmPendingMemoryItem(id: string): boolean {
  return Boolean(database && mode !== "legacy" && confirmPendingMemory(database, id))
}

export function rejectPendingMemoryItem(id: string): boolean {
  return Boolean(database && mode !== "legacy" && rejectPendingMemory(database, id))
}
