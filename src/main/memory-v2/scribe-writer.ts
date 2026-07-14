import { randomUUID } from "crypto"
import type { MemoryCandidate } from "../memory/memory-types"
import type { MemoryV2Database } from "./database"
import type { MemoryScribeEvent } from "./scribe-queue"
import { findFragmentConflict } from "./conflict-resolver"
import {
  attachFragmentToClaim,
  attachStateToClaim,
  ensureMemoryClaim,
  invalidateFragmentProjections,
} from "./claim-graph"
import { enqueueVectorUpsert } from "./vector-sync"

const DAY_MS = 24 * 60 * 60 * 1000
const SENSITIVE_PATTERN = /(?:authorization\s*:|cookie\s*:|api[ _-]?key|access[ _-]?token|refresh[ _-]?token|password|密码|验证码|银行卡|支付密码|sk-[a-z0-9_-]{12,})/i

export interface ScribeWriteResult {
  coreUpdates: number
  states: number
  fragments: number
  mergedEvidence: number
  rejected: Array<{ content: string; reason: string }>
}

const CORE_FIELDS: Record<string, string> = {
  nickname: "nickname",
  preferredName: "preferred_name",
  occupation: "occupation",
  longTermInterests: "long_term_interests",
  language: "language",
  permanentNote: "permanent_note",
}

const CORE_FACT_FIELDS: Record<string, { namespace: string; key: string }> = {
  importantAnniversary: { namespace: "life", key: "important_anniversary" },
  livingCondition: { namespace: "life", key: "living_condition" },
  primaryDevice: { namespace: "environment", key: "primary_device" },
  accessibilityNeed: { namespace: "interaction", key: "accessibility_need" },
}

export function sanitizeMemoryModelText(text: string): string {
  return text
    .replace(/(authorization\s*:\s*)([^\s,;]+)/gi, "$1[REDACTED]")
    .replace(/(cookie\s*:\s*)([^\n]+)/gi, "$1[REDACTED]")
    .replace(/\bsk-[a-z0-9_-]{12,}\b/gi, "[REDACTED_API_KEY]")
    .replace(/((?:api[ _-]?key|access[ _-]?token|refresh[ _-]?token|password|密码|验证码)\s*[=:：]\s*)([^\s,;，。]+)/gi, "$1[REDACTED]")
}

function importance(value: MemoryCandidate["importance"]): number {
  if (value === "high") return 0.9
  if (value === "low") return 0.4
  return 0.65
}

function kind(content: string): "fact" | "preference" | "plan" | "experience" | "relationship" | "observation" {
  if (/(?:\u559c\u6b22|\u504f\u597d|\u8ba8\u538c|\u4e0d\u559c\u6b22|\blike\b|\blove\b|\bprefer\b|\bdislike\b|\bhate\b)/i.test(content)) return "preference"
  if (/喜欢|偏好|讨厌|不喜欢|习惯/.test(content)) return "preference"
  if (/计划|准备|打算|目标|正在|接下来|当前/.test(content)) return "plan"
  if (/朋友|家人|同事|关系|陪伴/.test(content)) return "relationship"
  if (/看到|屏幕|观察|显示/.test(content)) return "observation"
  if (/一起|共同|完成|经历|那次/.test(content)) return "experience"
  return "fact"
}

function certainty(candidate: MemoryCandidate): "explicit" | "inferred" | "uncertain" {
  if (candidate.certainty === "explicit") return "explicit"
  if (candidate.certainty === "uncertain") return "uncertain"
  return "inferred"
}

function attribution(candidate: MemoryCandidate): "user" | "assistant" | "mixed" {
  if (candidate.attribution === "user_explicit") return "user"
  if (candidate.attribution === "mixed") return "mixed"
  return "assistant"
}

function candidateSources(candidate: MemoryCandidate, events: MemoryScribeEvent[]): string[] {
  const needles = [candidate.triggerText, ...(candidate.evidenceQuotes ?? [])]
    .map((value) => value.trim())
    .filter(Boolean)
  const ids = new Set<string>()
  for (const event of events) {
    const userText = event.userText.trim()
    const assistantText = event.assistantText.trim()
    for (const needle of needles) {
      if (userText && (event.userText.includes(needle) || needle.includes(userText))) ids.add(event.userSourceId)
      if (assistantText && (event.assistantText.includes(needle) || needle.includes(assistantText))) ids.add(event.assistantSourceId)
    }
  }
  if (ids.size === 0 && events.length === 1) {
    const event = events[0]
    if (candidate.attribution === "user_explicit" && event.userText.trim()) ids.add(event.userSourceId)
    if (candidate.attribution === "assistant_inferred" && event.assistantText.trim()) ids.add(event.assistantSourceId)
  }
  return [...ids]
}

function hasUserSource(db: MemoryV2Database, sourceIds: string[]): boolean {
  return sourceIds.some((id) => {
    const row = db.prepare("SELECT metadata_json FROM memory_sources WHERE id = ?").get(id)
    try { return JSON.parse(String(row?.metadata_json ?? "{}"))?.role === "user" } catch { return false }
  })
}

function stateLifetime(content: string): number {
  if (/今天|今晚|明天|本周|这周|周末/.test(content)) return 7
  if (/最近|近期|这段时间|正在|当前/.test(content)) return 30
  return 90
}

function addRevision(
  db: MemoryV2Database,
  targetType: string,
  targetId: string,
  action: string,
  before: unknown,
  after: unknown,
  reason: string,
  confidence: number,
  sourceId: string | null,
  now: number,
): void {
  db.prepare(`
    INSERT INTO memory_revisions(
      id, target_type, target_id, action, before_json, after_json,
      reason, confidence, actor, source_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'assistant', ?, ?)
  `).run(
    `revision_${randomUUID()}`,
    targetType,
    targetId,
    action,
    before === null ? null : JSON.stringify(before),
    after === null ? null : JSON.stringify(after),
    reason,
    Math.max(0, Math.min(1, confidence)),
    sourceId,
    now,
  )
}

function writeCore(
  db: MemoryV2Database,
  candidate: MemoryCandidate,
  sourceIds: string[],
  now: number,
): boolean {
  const column = candidate.field ? CORE_FIELDS[candidate.field] : undefined
  if (!column || candidate.attribution !== "user_explicit" || certainty(candidate) !== "explicit" || candidate.confidence < 0.85) return false
  if (!hasUserSource(db, sourceIds)) return false
  db.prepare("INSERT OR IGNORE INTO core_profile(id, updated_at) VALUES (1, ?)").run(now)
  const before = String(db.prepare(`SELECT ${column} AS value FROM core_profile WHERE id = 1`).get()?.value ?? "")
  const value = candidate.content.trim()
  if (!value || before === value) return false
  db.prepare(`UPDATE core_profile SET ${column} = ?, updated_at = ? WHERE id = 1`).run(value, now)
  addRevision(db, "core_profile", "1", `update_${candidate.field}`, { value: before }, { value }, candidate.reason ?? "Scribe core update", candidate.confidence, sourceIds[0] ?? null, now)
  return true
}

function writeCoreFact(
  db: MemoryV2Database,
  candidate: MemoryCandidate,
  sourceIds: string[],
  now: number,
): boolean {
  if (!candidate.field || candidate.attribution !== "user_explicit" || certainty(candidate) !== "explicit" || candidate.confidence < 0.85) return false
  if (!hasUserSource(db, sourceIds)) return false
  const registered = CORE_FACT_FIELDS[candidate.field]
  const namespace = registered?.namespace ?? "unregistered"
  const key = registered?.key ?? candidate.field.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80)
  if (!key) return false
  const value = candidate.content.trim()
  const previous = db.prepare(`SELECT * FROM core_facts WHERE namespace = ? AND key = ? AND status IN ('pending', 'active')`).get(namespace, key)
  if (previous && String(previous.value) === value) return false
  const id = `core_fact_${randomUUID()}`
  if (previous) {
    db.prepare("UPDATE core_facts SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE id = ?").run(id, now, previous.id)
  }
  const status = registered ? "active" : "pending"
  db.prepare(`INSERT INTO core_facts(
    id, namespace, key, value, value_type, status, confidence, pinned, created_at, updated_at
  ) VALUES (?, ?, ?, ?, 'string', ?, ?, 0, ?, ?)`)
    .run(id, namespace, key, value, status, candidate.confidence, now, now)
  addRevision(
    db,
    "core_fact",
    id,
    previous ? "supersede" : "create",
    previous ?? null,
    { namespace, key, value, status },
    registered ? "Scribe controlled Core fact update" : "Unknown Core fact key requires user confirmation",
    candidate.confidence,
    sourceIds[0] ?? null,
    now,
  )
  return true
}

function writeState(
  db: MemoryV2Database,
  candidate: MemoryCandidate,
  sourceIds: string[],
  now: number,
): boolean {
  if (!hasUserSource(db, sourceIds) || candidate.confidence < 0.65) return false
  const content = candidate.content.trim()
  if (!content) return false
  const duplicate = db.prepare(`
    SELECT id, claim_id FROM memory_states WHERE status = 'active' AND lower(content) = lower(?)
  `).get(content)
  if (duplicate) {
    if (!duplicate.claim_id) {
      const claimId = ensureMemoryClaim(db, {
        content,
        claimType: candidate.field ?? "current",
        confidence: candidate.confidence,
        now,
      })
      attachStateToClaim(db, String(duplicate.id), claimId, now)
    }
    const link = db.prepare("INSERT OR IGNORE INTO memory_state_sources(state_id, source_id) VALUES (?, ?)")
    for (const sourceId of sourceIds) link.run(duplicate.id, sourceId)
    return false
  }
  const id = `state_${randomUUID()}`
  const claimId = ensureMemoryClaim(db, {
    content,
    claimType: candidate.field ?? "current",
    confidence: candidate.confidence,
    status: "active",
    now,
    metadata: { automatic: true },
  })
  const expiresAt = now + stateLifetime(content) * DAY_MS
  db.prepare(`
    INSERT INTO memory_states(
      id, claim_id, state_type, content, status, confidence, importance, starts_at,
      expires_at, resolved_at, superseded_by, pinned, created_at, updated_at, metadata_json
    ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, NULL, NULL, 0, ?, ?, ?)
  `).run(
    id,
    claimId,
    candidate.field ?? "current",
    content,
    candidate.confidence,
    importance(candidate.importance),
    now,
    expiresAt,
    now,
    now,
    JSON.stringify({ automatic: true, sourceLayer: "L1" }),
  )
  const link = db.prepare("INSERT INTO memory_state_sources(state_id, source_id) VALUES (?, ?)")
  for (const sourceId of sourceIds) link.run(id, sourceId)
  attachStateToClaim(db, id, claimId, now)
  addRevision(db, "state", id, "create", null, { content, expiresAt }, candidate.reason ?? "Scribe state extraction", candidate.confidence, sourceIds[0] ?? null, now)
  return true
}

function enqueueFragmentIndex(db: MemoryV2Database, fragmentId: string, now: number): void {
  enqueueVectorUpsert(db, "fragment", fragmentId, now)
}

function writeFragment(
  db: MemoryV2Database,
  candidate: MemoryCandidate,
  sourceIds: string[],
  now: number,
): "created" | "merged" | "rejected" {
  const content = candidate.content.trim().replace(/\s+/g, " ")
  if (!content || content.length > 240 || sourceIds.length === 0) return "rejected"
  const userEvidence = hasUserSource(db, sourceIds)
  if (candidate.attribution === "user_explicit" && !userEvidence) return "rejected"
  const existing = db.prepare(`
    SELECT id, claim_id FROM memory_fragments
    WHERE status IN ('pending', 'active', 'cooling', 'frozen') AND lower(content) = lower(?)
    ORDER BY created_at ASC LIMIT 1
  `).get(content)
  if (existing) {
    if (!existing.claim_id) {
      const claimId = ensureMemoryClaim(db, {
        content,
        claimType: kind(content),
        confidence: candidate.confidence,
        now,
      })
      attachFragmentToClaim(db, String(existing.id), claimId, now)
    }
    const link = db.prepare(`
      INSERT OR IGNORE INTO memory_fragment_sources(fragment_id, source_id, evidence_role)
      VALUES (?, ?, 'support')
    `)
    for (const sourceId of sourceIds) link.run(existing.id, sourceId)
    db.prepare(`
      UPDATE memory_fragments SET confidence = MAX(confidence, ?), importance = MAX(importance, ?), updated_at = ?
      WHERE id = ?
    `).run(candidate.confidence, importance(candidate.importance), now, existing.id)
    return "merged"
  }
  const id = `fragment_${randomUUID()}`
  const fragmentKind = kind(content)
  const conflict = findFragmentConflict(db, content, fragmentKind)
  const canResolveConflict = Boolean(
    conflict
    && candidate.attribution === "user_explicit"
    && certainty(candidate) === "explicit"
    && candidate.confidence >= 0.8,
  )
  const status = conflict && !canResolveConflict
    ? "pending"
    : candidate.confidence >= 0.55 && certainty(candidate) !== "uncertain" ? "active" : "pending"
  const claimId = ensureMemoryClaim(db, {
    content,
    claimType: fragmentKind,
    confidence: candidate.confidence,
    status: status === "active" ? "active" : "pending",
    now,
    metadata: { automatic: true },
  })
  db.prepare(`
    INSERT INTO memory_fragments(
      id, claim_id, content, kind, certainty, attribution, confidence, importance,
      emotional_weight, status, created_at, updated_at, last_accessed_at,
      access_count, pinned, revision, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0.5, ?, ?, ?, ?, 0, 0, 1, ?)
  `).run(
    id,
    claimId,
    content,
    fragmentKind,
    certainty(candidate),
    attribution(candidate),
    candidate.confidence,
    importance(candidate.importance),
    status,
    now,
    now,
    now,
    JSON.stringify({
      sourceLayer: "L2",
      automatic: true,
      ...(conflict ? {
        conflictWith: conflict.id,
        conflictReason: "opposite_preference",
        requiresConfirmation: !canResolveConflict,
      } : {}),
    }),
  )
  const link = db.prepare(`
    INSERT INTO memory_fragment_sources(fragment_id, source_id, evidence_role) VALUES (?, ?, 'support')
  `)
  for (const sourceId of sourceIds) link.run(id, sourceId)
  attachFragmentToClaim(db, id, claimId, now)
  addRevision(db, "fragment", id, "create", null, { content, status }, candidate.reason ?? "Scribe fragment extraction", candidate.confidence, sourceIds[0] ?? null, now)
  if (conflict && canResolveConflict) {
    const before = db.prepare("SELECT * FROM memory_fragments WHERE id = ?").get(conflict.id)
    db.prepare(`
      UPDATE memory_fragments SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE id = ?
    `).run(id, now, conflict.id)
    invalidateFragmentProjections(db, conflict.id, "superseded", now)
    addRevision(
      db,
      "fragment",
      conflict.id,
      "supersede",
      before,
      { status: "superseded", supersededBy: id },
      "Explicit user correction replaced an opposite preference",
      candidate.confidence,
      sourceIds[0] ?? null,
      now,
    )
  }
  if (status === "active") enqueueFragmentIndex(db, id, now)
  return "created"
}

export function writeMemoryCandidatesV2(
  db: MemoryV2Database,
  candidates: MemoryCandidate[],
  events: MemoryScribeEvent[],
  now = Date.now(),
): ScribeWriteResult {
  const result: ScribeWriteResult = { coreUpdates: 0, states: 0, fragments: 0, mergedEvidence: 0, rejected: [] }
  db.transaction(() => {
    for (const candidate of candidates) {
      if (candidate.shouldWrite === false) continue
      const content = candidate.content.trim()
      if (!content || SENSITIVE_PATTERN.test(content)) {
        result.rejected.push({ content: content.slice(0, 80), reason: "sensitive_or_empty" })
        continue
      }
      const sourceIds = candidateSources(candidate, events)
      if (sourceIds.length === 0) {
        result.rejected.push({ content: content.slice(0, 80), reason: "missing_evidence" })
        continue
      }
      if (candidate.layer === "L0") {
        if (writeCore(db, candidate, sourceIds, now) || writeCoreFact(db, candidate, sourceIds, now)) result.coreUpdates += 1
        else result.rejected.push({ content: content.slice(0, 80), reason: "core_requires_explicit_user_evidence" })
      } else if (candidate.layer === "L1") {
        if (writeState(db, candidate, sourceIds, now)) result.states += 1
        else result.rejected.push({ content: content.slice(0, 80), reason: "invalid_or_duplicate_state" })
      } else {
        const written = writeFragment(db, candidate, sourceIds, now)
        if (written === "created") result.fragments += 1
        else if (written === "merged") result.mergedEvidence += 1
        else result.rejected.push({ content: content.slice(0, 80), reason: "invalid_fragment" })
      }
    }
  })
  return result
}
