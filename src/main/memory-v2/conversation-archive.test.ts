import { describe, expect, it } from "vitest"
import type { ChatSession } from "../../shared/chat-types"
import { archiveConversation, readConversationArchive } from "./conversation-archive"
import { MemoryV2Database } from "./database"

function session(): ChatSession {
  return {
    id: "deleted-branch",
    title: "Memory v2 discussion",
    identityId: null,
    createdAt: 100,
    updatedAt: 300,
    deletedAt: 400,
    schemaVersion: 1,
    messages: [
      { id: "m1", role: "user", content: "保留这段聊天", at: 100 },
      { id: "m2", role: "model", content: "我会记得。", at: 200 },
    ],
  }
}

describe("conversation archive", () => {
  it("compresses, validates and restores a deleted conversation", () => {
    const db = new MemoryV2Database(":memory:")
    db.prepare(`
      INSERT INTO memory_sources(
        id, source_type, conversation_id, message_id, occurred_at,
        quote, status, metadata_json
      ) VALUES ('source-1', 'chat', 'deleted-branch', 'm1', 100, '保留这段聊天', 'active', '{}')
    `).run()

    const archived = archiveConversation(db, session(), 500)
    expect(archived.archived).toBe(true)
    expect(archived.compressedBytes).toBeGreaterThan(0)
    expect(readConversationArchive(db, "deleted-branch")).toEqual(session())
    expect(db.prepare("SELECT archive_status FROM deleted_conversations WHERE conversation_id = ?").get("deleted-branch")?.archive_status)
      .toBe("archived")
    expect(db.prepare("SELECT status FROM memory_sources WHERE id = 'source-1'").get()?.status).toBe("archived")

    const repeated = archiveConversation(db, session(), 600)
    expect(repeated.archived).toBe(false)
    expect(db.prepare("SELECT id FROM conversation_archives").all()).toHaveLength(1)
    db.close()
  })
})
