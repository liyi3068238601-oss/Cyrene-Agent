import { createHash, randomUUID } from "crypto"
import { gunzipSync, gzipSync } from "zlib"
import type { ChatSession } from "../../shared/chat-types"
import type { MemoryV2Database } from "./database"

export interface ConversationArchiveResult {
  archived: boolean
  archiveId: string
  sourceHash: string
  compressedBytes: number
}

function hash(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex")
}

function messageTime(message: ChatSession["messages"][number]): number | undefined {
  return typeof message.at === "number" && Number.isFinite(message.at) ? message.at : undefined
}

export function archiveConversation(
  db: MemoryV2Database,
  session: ChatSession,
  now = Date.now(),
): ConversationArchiveResult {
  const body = Buffer.from(JSON.stringify(session), "utf8")
  const sourceHash = hash(body)
  const compressed = gzipSync(body, { level: 9 })
  const restored = gunzipSync(compressed)
  if (hash(restored) !== sourceHash || !restored.equals(body)) {
    throw new Error(`Conversation archive validation failed for ${session.id}`)
  }

  const existing = db.prepare(`
    SELECT id, source_hash FROM conversation_archives WHERE conversation_id = ?
  `).get(session.id) as { id?: string; source_hash?: string } | undefined
  if (existing?.source_hash === sourceHash && existing.id) {
    return {
      archived: false,
      archiveId: existing.id,
      sourceHash,
      compressedBytes: compressed.byteLength,
    }
  }

  const archiveId = existing?.id ?? `archive_${randomUUID()}`
  const times = session.messages.map(messageTime).filter((value): value is number => value !== undefined)
  const participants = Array.from(new Set(session.messages.map((message) => message.role)))
  const evidence = db.prepare(`
    SELECT id, message_id, quote
    FROM memory_sources
    WHERE conversation_id = ? AND status != 'deleted'
    ORDER BY occurred_at ASC
  `).all(session.id)

  db.transaction(() => {
    db.prepare(`
      INSERT INTO conversation_archives(
        id, conversation_id, started_at, ended_at, participants_json,
        topic_summary, message_count, codec, compressed_body,
        evidence_manifest_json, source_hash, archive_version, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'gzip-json-v1', ?, ?, ?, 1, ?)
      ON CONFLICT(conversation_id) DO UPDATE SET
        started_at = excluded.started_at,
        ended_at = excluded.ended_at,
        participants_json = excluded.participants_json,
        topic_summary = excluded.topic_summary,
        message_count = excluded.message_count,
        codec = excluded.codec,
        compressed_body = excluded.compressed_body,
        evidence_manifest_json = excluded.evidence_manifest_json,
        source_hash = excluded.source_hash,
        archive_version = excluded.archive_version,
        created_at = excluded.created_at
    `).run(
      archiveId,
      session.id,
      times.length > 0 ? Math.min(...times) : session.createdAt,
      times.length > 0 ? Math.max(...times) : session.updatedAt,
      JSON.stringify(participants),
      session.title,
      session.messages.length,
      compressed,
      JSON.stringify(evidence),
      sourceHash,
      now,
    )
    db.prepare(`
      INSERT INTO deleted_conversations(
        conversation_id, deleted_at, archive_status, archive_id, last_error, updated_at
      ) VALUES (?, ?, 'archived', ?, NULL, ?)
      ON CONFLICT(conversation_id) DO UPDATE SET
        archive_status = 'archived',
        archive_id = excluded.archive_id,
        last_error = NULL,
        updated_at = excluded.updated_at
    `).run(session.id, session.deletedAt ?? now, archiveId, now)
    db.prepare(`
      UPDATE memory_sources SET status = 'archived'
      WHERE conversation_id = ? AND status = 'active'
    `).run(session.id)
  })

  return { archived: true, archiveId, sourceHash, compressedBytes: compressed.byteLength }
}

export function readConversationArchive(db: MemoryV2Database, conversationId: string): ChatSession | null {
  const row = db.prepare(`
    SELECT codec, compressed_body, source_hash
    FROM conversation_archives WHERE conversation_id = ?
  `).get(conversationId) as {
    codec?: string
    compressed_body?: Uint8Array
    source_hash?: string
  } | undefined
  if (!row?.compressed_body || row.codec !== "gzip-json-v1") return null
  const restored = gunzipSync(Buffer.from(row.compressed_body))
  if (hash(restored) !== row.source_hash) throw new Error(`Conversation archive hash mismatch for ${conversationId}`)
  return JSON.parse(restored.toString("utf8")) as ChatSession
}
