import { randomUUID } from "crypto"
import type { MemoryV2Database } from "./database"

const SOURCE_QUOTE_LIMIT = 600

export interface MemoryScribeEvent {
  id: string
  conversationId: string
  userText: string
  assistantText: string
  occurredAt: number
  attemptCount: number
  userSourceId: string
  assistantSourceId: string
}

function quote(text: string): string {
  const trimmed = text.trim()
  return trimmed.length > SOURCE_QUOTE_LIMIT ? trimmed.slice(0, SOURCE_QUOTE_LIMIT) : trimmed
}

function eventFromRow(row: Record<string, unknown>): MemoryScribeEvent {
  return {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    userText: String(row.user_text),
    assistantText: String(row.assistant_text),
    occurredAt: Number(row.occurred_at),
    attemptCount: Number(row.attempt_count),
    userSourceId: String(row.user_source_id),
    assistantSourceId: String(row.assistant_source_id),
  }
}

export function appendScribeTurn(
  db: MemoryV2Database,
  userText: string,
  assistantText: string,
  conversationId: string,
  occurredAt = Date.now(),
): MemoryScribeEvent {
  const eventId = `event_${randomUUID()}`
  const userSourceId = `${eventId}:user`
  const assistantSourceId = `${eventId}:assistant`
  db.transaction(() => {
    const insertSource = db.prepare(`
      INSERT INTO memory_sources(
        id, source_type, conversation_id, message_id, occurred_at,
        quote, status, metadata_json
      ) VALUES (?, 'chat', ?, NULL, ?, ?, 'active', ?)
    `)
    insertSource.run(
      userSourceId,
      conversationId,
      occurredAt,
      quote(userText),
      JSON.stringify({ eventId, role: "user" }),
    )
    insertSource.run(
      assistantSourceId,
      conversationId,
      occurredAt,
      quote(assistantText),
      JSON.stringify({ eventId, role: "assistant" }),
    )
    db.prepare(`
      INSERT INTO memory_event_log(
        id, conversation_id, user_text, assistant_text, occurred_at,
        status, attempt_count, user_source_id, assistant_source_id
      ) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?)
    `).run(eventId, conversationId, userText, assistantText, occurredAt, userSourceId, assistantSourceId)
  })
  return {
    id: eventId,
    conversationId,
    userText,
    assistantText,
    occurredAt,
    attemptCount: 0,
    userSourceId,
    assistantSourceId,
  }
}

export function resetInterruptedScribeEvents(db: MemoryV2Database): number {
  const result = db.prepare(`
    UPDATE memory_event_log
    SET status = 'pending', last_error = 'Interrupted before completion'
    WHERE status = 'processing'
  `).run()
  return Number(result.changes)
}

export function countPendingScribeEvents(db: MemoryV2Database): number {
  return Number(db.prepare(`
    SELECT COUNT(*) AS count FROM memory_event_log WHERE status = 'pending'
  `).get()?.count ?? 0)
}

export function claimPendingScribeEvents(db: MemoryV2Database, limit: number): MemoryScribeEvent[] {
  return db.transaction(() => {
    const rows = db.prepare(`
      SELECT * FROM memory_event_log
      WHERE status = 'pending'
      ORDER BY occurred_at ASC, id ASC
      LIMIT ?
    `).all(Math.max(1, limit))
    if (rows.length === 0) return []
    const update = db.prepare(`
      UPDATE memory_event_log
      SET status = 'processing', attempt_count = attempt_count + 1, last_error = NULL
      WHERE id = ? AND status = 'pending'
    `)
    const claimed: MemoryScribeEvent[] = []
    for (const row of rows) {
      if (Number(update.run(String(row.id)).changes) > 0) {
        claimed.push(eventFromRow({ ...row, attempt_count: Number(row.attempt_count) + 1 }))
      }
    }
    return claimed
  })
}

export function completeScribeEvents(db: MemoryV2Database, ids: string[], now = Date.now()): number {
  if (ids.length === 0) return 0
  return db.transaction(() => {
    const statement = db.prepare(`
      UPDATE memory_event_log
      SET status = 'processed', processed_at = ?, last_error = NULL
      WHERE id = ? AND status = 'processing'
    `)
    let changed = 0
    for (const id of ids) changed += Number(statement.run(now, id).changes)
    return changed
  })
}

export function failScribeEvents(db: MemoryV2Database, ids: string[], error: unknown): number {
  if (ids.length === 0) return 0
  const message = error instanceof Error ? error.message : String(error)
  return db.transaction(() => {
    const statement = db.prepare(`
      UPDATE memory_event_log
      SET status = CASE WHEN attempt_count >= 3 THEN 'failed' ELSE 'pending' END,
          last_error = ?
      WHERE id = ? AND status = 'processing'
    `)
    let changed = 0
    for (const id of ids) changed += Number(statement.run(message, id).changes)
    return changed
  })
}
