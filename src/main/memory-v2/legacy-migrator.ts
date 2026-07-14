import { createHash } from "crypto"
import type { L2Memory, MemoryEvidence, MemoryStore } from "../memory/memory-types"
import type { MemoryV2Database } from "./database"

export interface LegacyMigrationResult {
  skipped: boolean
  coreProfiles: number
  states: number
  fragments: number
  episodes: number
  sources: number
  revisions: number
  deletedConversations: number
}

const EMPTY_RESULT: LegacyMigrationResult = {
  skipped: false,
  coreProfiles: 0,
  states: 0,
  fragments: 0,
  episodes: 0,
  sources: 0,
  revisions: 0,
  deletedConversations: 0,
}

function hashStore(store: MemoryStore): string {
  return createHash("sha256").update(JSON.stringify(store)).digest("hex")
}

function json(value: unknown): string {
  return JSON.stringify(value ?? null)
}

function bool(value: boolean | undefined): number {
  return value ? 1 : 0
}

function normalizedWeight(value: number | undefined): number {
  if (!Number.isFinite(value)) return 0.5
  return Math.max(0, Math.min(1, Number(value) / 100))
}

function fragmentStatus(memory: L2Memory): "active" | "cooling" | "frozen" | "superseded" {
  if (memory.status === "aging") return "cooling"
  if (memory.status === "archived") return "frozen"
  if (memory.status === "superseded" || memory.status === "merged") return "superseded"
  return "active"
}

function episodeStatus(memory: L2Memory): "active" | "archived" | "superseded" {
  if (memory.status === "archived") return "archived"
  if (memory.status === "superseded" || memory.status === "merged") return "superseded"
  return "active"
}

function inferKind(memory: L2Memory): "fact" | "preference" | "plan" | "experience" | "relationship" | "observation" {
  const text = `${memory.triggerText}\n${memory.content}`
  if (/喜欢|偏好|讨厌|不喜欢|习惯/.test(text)) return "preference"
  if (/计划|准备|打算|目标|正在|接下来/.test(text)) return "plan"
  if (/关系|朋友|家人|同事|陪伴/.test(text)) return "relationship"
  if (/看到|屏幕|观察/.test(text)) return "observation"
  if (/完成|经历|一起|曾经|上次/.test(text)) return "experience"
  return "fact"
}

function sourceStatus(evidence: MemoryEvidence): "active" | "archived" | "deleted" {
  if (evidence.sourceStatus === "deleted") return "deleted"
  if (evidence.sourceStatus === "archived") return "archived"
  return "active"
}

function stateRows(store: MemoryStore): Array<{ id: string; type: string; content: string }> {
  return [
    { id: "legacy-state:recent-goals", type: "goal", content: store.l1.recentGoals },
    { id: "legacy-state:recent-preferences", type: "recent_preference", content: store.l1.recentPreferences },
    { id: "legacy-state:current-project", type: "project", content: store.l1.currentProject },
  ]
}

export function syncLegacySnapshot(
  db: MemoryV2Database,
  store: MemoryStore,
  now = Date.now(),
): LegacyMigrationResult {
  const result = { ...EMPTY_RESULT }
  const evidenceByMemory = new Map<string, MemoryEvidence[]>()
  for (const evidence of store.evidence ?? []) {
    const list = evidenceByMemory.get(evidence.memoryId) ?? []
    list.push(evidence)
    evidenceByMemory.set(evidence.memoryId, list)
  }

  db.transaction(() => {
    db.prepare(`
      INSERT INTO core_profile(
        id, nickname, preferred_name, occupation, long_term_interests,
        language, permanent_note, pinned, updated_at
      ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        nickname = excluded.nickname,
        preferred_name = excluded.preferred_name,
        occupation = excluded.occupation,
        long_term_interests = excluded.long_term_interests,
        language = excluded.language,
        permanent_note = excluded.permanent_note,
        pinned = excluded.pinned,
        updated_at = excluded.updated_at
    `).run(
      store.l0.nickname,
      store.l0.preferredName,
      store.l0.occupation,
      store.l0.longTermInterests,
      store.l0.language,
      store.l0.permanentNote,
      bool(store.l0.isPinned),
      store.l0.updatedAt,
    )
    result.coreProfiles = 1

    const upsertState = db.prepare(`
      INSERT INTO memory_states(
        id, state_type, content, status, confidence, importance, starts_at,
        expires_at, resolved_at, pinned, created_at, updated_at, metadata_json
      ) VALUES (?, ?, ?, 'active', 0.7, 0.6, ?, NULL, NULL, 0, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        content = excluded.content,
        status = 'active',
        resolved_at = NULL,
        updated_at = excluded.updated_at,
        metadata_json = excluded.metadata_json
    `)
    const resolveState = db.prepare(`
      UPDATE memory_states
      SET status = 'resolved', resolved_at = ?, updated_at = ?
      WHERE id = ? AND status = 'active'
    `)
    for (const row of stateRows(store)) {
      if (row.content.trim()) {
        upsertState.run(
          row.id,
          row.type,
          row.content.trim(),
          store.l1.generatedAt || now,
          store.l1.generatedAt || now,
          now,
          json({ legacyField: row.type }),
        )
        result.states += 1
      } else {
        resolveState.run(now, now, row.id)
      }
    }

    const upsertSource = db.prepare(`
      INSERT INTO memory_sources(
        id, source_type, conversation_id, message_id, occurred_at, quote,
        context_before, context_after, status, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        conversation_id = excluded.conversation_id,
        message_id = excluded.message_id,
        quote = excluded.quote,
        context_before = excluded.context_before,
        context_after = excluded.context_after,
        status = excluded.status,
        metadata_json = excluded.metadata_json
    `)
    for (const evidence of store.evidence ?? []) {
      upsertSource.run(
        evidence.id,
        "chat",
        evidence.conversationId ?? null,
        evidence.messageIds?.[0] ?? null,
        evidence.createdAt,
        evidence.quoteSnippet,
        evidence.contextBeforeSnippet ?? null,
        evidence.contextAfterSnippet ?? null,
        sourceStatus(evidence),
        json({ messageIds: evidence.messageIds ?? [], legacyMemoryId: evidence.memoryId }),
      )
      result.sources += 1
    }

    const upsertFragment = db.prepare(`
      INSERT INTO memory_fragments(
        id, content, kind, certainty, attribution, confidence, importance,
        emotional_weight, status, created_at, updated_at, last_accessed_at,
        access_count, pinned, superseded_by, legacy_rag_id, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        content = excluded.content,
        kind = excluded.kind,
        confidence = excluded.confidence,
        importance = excluded.importance,
        status = excluded.status,
        updated_at = excluded.updated_at,
        last_accessed_at = excluded.last_accessed_at,
        access_count = excluded.access_count,
        pinned = excluded.pinned,
        superseded_by = excluded.superseded_by,
        legacy_rag_id = excluded.legacy_rag_id,
        metadata_json = excluded.metadata_json
    `)
    const upsertEpisode = db.prepare(`
      INSERT INTO memory_episodes(
        id, title, content, status, confidence, importance, starts_at, ends_at,
        created_at, updated_at, last_accessed_at, access_count, version,
        superseded_by, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        content = excluded.content,
        status = excluded.status,
        confidence = excluded.confidence,
        importance = excluded.importance,
        updated_at = excluded.updated_at,
        last_accessed_at = excluded.last_accessed_at,
        access_count = excluded.access_count,
        superseded_by = excluded.superseded_by,
        metadata_json = excluded.metadata_json
    `)
    const linkSource = db.prepare(`
      INSERT OR IGNORE INTO memory_fragment_sources(fragment_id, source_id, evidence_role)
      VALUES (?, ?, 'support')
    `)
    const linkEpisodeFragment = db.prepare(`
      INSERT OR IGNORE INTO memory_episode_fragments(episode_id, fragment_id, position)
      VALUES (?, ?, ?)
    `)
    const linkEpisodeSource = db.prepare(`
      INSERT OR IGNORE INTO memory_episode_sources(episode_id, source_id)
      VALUES (?, ?)
    `)

    for (const memory of store.l2) {
      if (memory.isSummary) {
        upsertEpisode.run(
          memory.id,
          memory.content.slice(0, 60),
          memory.content,
          episodeStatus(memory),
          evidenceByMemory.has(memory.id) ? 0.75 : 0.55,
          Math.max(0.4, normalizedWeight(memory.weight)),
          memory.createdAt,
          memory.createdAt,
          memory.createdAt,
          now,
          memory.lastAccessedAt,
          memory.accessCount,
          null,
          json({
            legacy: true,
            sourceConversationIds: memory.sourceConversationIds ?? [memory.sourceConversationId],
            ragId: memory.ragId,
            syncStatus: memory.syncStatus,
          }),
        )
        for (const source of evidenceByMemory.get(memory.id) ?? []) {
          linkEpisodeSource.run(memory.id, source.id)
        }
        result.episodes += 1
        continue
      }

      const evidence = evidenceByMemory.get(memory.id) ?? []
      upsertFragment.run(
        memory.id,
        memory.content,
        inferKind(memory),
        evidence.length > 0 ? "explicit" : "inferred",
        evidence.length > 0 ? "user" : "system",
        evidence.length > 0 ? 0.75 : 0.55,
        Math.max(0.35, normalizedWeight(memory.weight)),
        0.5,
        fragmentStatus(memory),
        memory.createdAt,
        now,
        memory.lastAccessedAt,
        memory.accessCount,
        bool(memory.isPinned),
        null,
        memory.ragId ?? null,
        json({
          legacy: true,
          triggerText: memory.triggerText,
          sourceConversationId: memory.sourceConversationId,
          sourceConversationIds: memory.sourceConversationIds,
          sourceDeletedAt: memory.sourceDeletedAt,
          syncStatus: memory.syncStatus,
          conflictWith: memory.conflictWith,
        }),
      )

      if (evidence.length === 0) {
        const sourceId = `legacy-source:${memory.id}`
        upsertSource.run(
          sourceId,
          "legacy",
          memory.sourceConversationId,
          memory.sourceMessageIds?.[0] ?? null,
          memory.createdAt,
          memory.triggerText || memory.content,
          null,
          null,
          memory.sourceDeletedAt ? "archived" : "active",
          json({ synthetic: true, legacyMemoryId: memory.id }),
        )
        linkSource.run(memory.id, sourceId)
        result.sources += 1
      } else {
        for (const source of evidence) linkSource.run(memory.id, source.id)
      }
      result.fragments += 1
    }

    for (const memory of store.l2.filter((item) => item.isSummary)) {
      for (const [position, fragmentId] of (memory.subEntryIds ?? []).entries()) {
        const exists = db.prepare("SELECT 1 FROM memory_fragments WHERE id = ?").get(fragmentId)
        if (exists) linkEpisodeFragment.run(memory.id, fragmentId, position)
      }
    }

    const linkFragmentRevision = db.prepare(`
      UPDATE memory_fragments SET superseded_by = ? WHERE id = ?
    `)
    const linkEpisodeRevision = db.prepare(`
      UPDATE memory_episodes SET superseded_by = ? WHERE id = ?
    `)
    for (const memory of store.l2) {
      const targetId = memory.supersededBy ?? memory.mergedInto
      if (!targetId) continue
      if (memory.isSummary) {
        const target = db.prepare("SELECT 1 FROM memory_episodes WHERE id = ?").get(targetId)
        if (target) linkEpisodeRevision.run(targetId, memory.id)
      } else {
        const target = db.prepare("SELECT 1 FROM memory_fragments WHERE id = ?").get(targetId)
        if (target) linkFragmentRevision.run(targetId, memory.id)
      }
    }

    const upsertDeletedConversation = db.prepare(`
      INSERT INTO deleted_conversations(
        conversation_id, deleted_at, archive_status, updated_at
      ) VALUES (?, ?, 'pending', ?)
      ON CONFLICT(conversation_id) DO UPDATE SET
        deleted_at = excluded.deleted_at,
        updated_at = excluded.updated_at
    `)
    for (const [conversationId, deletedAt] of Object.entries(store.deletedConversations ?? {})) {
      upsertDeletedConversation.run(conversationId, deletedAt, now)
      result.deletedConversations += 1
    }

    const insertRevision = db.prepare(`
      INSERT OR IGNORE INTO memory_revisions(
        id, target_type, target_id, action, before_json, after_json,
        reason, confidence, actor, source_id, created_at
      ) VALUES (?, 'fragment', ?, 'legacy_conflict', NULL, ?, ?, ?, 'migration', NULL, ?)
    `)
    for (const conflict of store.conflictLogs ?? []) {
      insertRevision.run(
        `legacy-conflict:${conflict.id}`,
        conflict.targetL2Id,
        json(conflict),
        conflict.reason,
        Math.max(0, Math.min(1, conflict.confidence)),
        conflict.createdAt,
      )
      result.revisions += 1

      if (conflict.resolutionType || conflict.resolutionReason || conflict.resolverStatus === "resolved") {
        const resolutionVersion = conflict.resolverFinishedAt ?? conflict.createdAt
        db.prepare(`
          INSERT OR IGNORE INTO memory_revisions(
            id, target_type, target_id, action, before_json, after_json,
            reason, confidence, actor, source_id, created_at
          ) VALUES (?, 'fragment', ?, 'legacy_conflict_resolution', ?, ?, ?, ?, ?, NULL, ?)
        `).run(
          `legacy-resolution:${conflict.id}:${resolutionVersion}`,
          conflict.targetL2Id,
          json({ sourceL2Id: conflict.sourceL2Id, targetL2Id: conflict.targetL2Id, conflictReason: conflict.reason }),
          json({
            resolutionType: conflict.resolutionType,
            resolutionMemoryId: conflict.resolutionMemoryId,
            resolutionReason: conflict.resolutionReason,
            resolutionConfidence: conflict.resolutionConfidence,
            shouldAskUser: conflict.shouldAskUser,
            clarificationNeeded: conflict.clarificationNeeded,
          }),
          conflict.resolutionReason ?? conflict.reason,
          Math.max(0, Math.min(1, conflict.resolutionConfidence ?? conflict.confidence)),
          conflict.detector === "manual" ? "user" : "assistant",
          resolutionVersion,
        )
        result.revisions += 1
      }
    }

    db.prepare(`
      INSERT INTO memory_meta(key, value, updated_at)
      VALUES ('legacy_last_snapshot_hash', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(hashStore(store), now)
  })

  return result
}

export function migrateLegacyStore(
  db: MemoryV2Database,
  store: MemoryStore,
  sourceKey = `memory.json:v${store.schemaVersion}`,
  now = Date.now(),
): LegacyMigrationResult {
  const sourceHash = hashStore(store)
  const existing = db.prepare(`
    SELECT source_hash FROM legacy_imports WHERE source_key = ?
  `).get(sourceKey) as { source_hash?: string } | undefined

  if (existing?.source_hash === sourceHash) return { ...EMPTY_RESULT, skipped: true }

  const result = syncLegacySnapshot(db, store, now)
  db.prepare(`
    INSERT INTO legacy_imports(source_key, source_schema_version, source_hash, imported_at, result_json)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(source_key) DO UPDATE SET
      source_schema_version = excluded.source_schema_version,
      source_hash = excluded.source_hash,
      imported_at = excluded.imported_at,
      result_json = excluded.result_json
  `).run(sourceKey, store.schemaVersion, sourceHash, now, json(result))
  return result
}
