export const MEMORY_V2_SCHEMA_VERSION = 4

export const MEMORY_V2_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL,
  description TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_event_log (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  user_text TEXT NOT NULL,
  assistant_text TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'processed', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  processed_at INTEGER,
  last_error TEXT,
  user_source_id TEXT NOT NULL REFERENCES memory_sources(id),
  assistant_source_id TEXT NOT NULL REFERENCES memory_sources(id)
);

CREATE TABLE IF NOT EXISTS core_profile (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  nickname TEXT NOT NULL DEFAULT '',
  preferred_name TEXT NOT NULL DEFAULT '',
  occupation TEXT NOT NULL DEFAULT '',
  long_term_interests TEXT NOT NULL DEFAULT '',
  language TEXT NOT NULL DEFAULT 'zh-CN',
  permanent_note TEXT NOT NULL DEFAULT '',
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  updated_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS core_facts (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  value_type TEXT NOT NULL DEFAULT 'string',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'superseded', 'deleted')),
  confidence REAL NOT NULL DEFAULT 1 CHECK (confidence >= 0 AND confidence <= 1),
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  superseded_by TEXT REFERENCES core_facts(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_core_facts_current_key
  ON core_facts(namespace, key)
  WHERE status IN ('pending', 'active');

CREATE TABLE IF NOT EXISTS memory_sources (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL CHECK (source_type IN ('chat', 'screen', 'tool', 'manual', 'legacy')),
  conversation_id TEXT,
  message_id TEXT,
  occurred_at INTEGER NOT NULL,
  quote TEXT NOT NULL,
  context_before TEXT,
  context_after TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived', 'deleted')),
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS memory_claims (
  id TEXT PRIMARY KEY,
  semantic_key TEXT NOT NULL UNIQUE,
  canonical_text TEXT NOT NULL,
  claim_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('pending', 'active', 'superseded', 'retired')),
  confidence REAL NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  superseded_by TEXT REFERENCES memory_claims(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS deleted_conversations (
  conversation_id TEXT PRIMARY KEY,
  deleted_at INTEGER NOT NULL,
  archive_status TEXT NOT NULL DEFAULT 'pending' CHECK (archive_status IN ('pending', 'archiving', 'archived', 'failed')),
  archive_id TEXT,
  last_error TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation_archives (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL UNIQUE,
  started_at INTEGER,
  ended_at INTEGER,
  participants_json TEXT NOT NULL DEFAULT '[]',
  topic_summary TEXT NOT NULL DEFAULT '',
  message_count INTEGER NOT NULL DEFAULT 0,
  codec TEXT NOT NULL,
  compressed_body BLOB NOT NULL,
  evidence_manifest_json TEXT NOT NULL DEFAULT '[]',
  source_hash TEXT NOT NULL,
  archive_version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_fragments (
  id TEXT PRIMARY KEY,
  claim_id TEXT REFERENCES memory_claims(id),
  content TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('fact', 'preference', 'plan', 'experience', 'relationship', 'observation')),
  certainty TEXT NOT NULL CHECK (certainty IN ('explicit', 'inferred', 'uncertain')),
  attribution TEXT NOT NULL CHECK (attribution IN ('user', 'assistant', 'mixed', 'system')),
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  importance REAL NOT NULL CHECK (importance >= 0 AND importance <= 1),
  emotional_weight REAL NOT NULL DEFAULT 0.5 CHECK (emotional_weight >= 0 AND emotional_weight <= 1),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('pending', 'active', 'cooling', 'frozen', 'superseded', 'tombstone')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_accessed_at INTEGER NOT NULL,
  access_count INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  superseded_by TEXT REFERENCES memory_fragments(id),
  legacy_rag_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS memory_fragment_sources (
  fragment_id TEXT NOT NULL REFERENCES memory_fragments(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES memory_sources(id) ON DELETE RESTRICT,
  evidence_role TEXT NOT NULL DEFAULT 'support' CHECK (evidence_role IN ('support', 'context', 'contradiction')),
  PRIMARY KEY(fragment_id, source_id, evidence_role)
);

CREATE TABLE IF NOT EXISTS memory_entities (
  id TEXT PRIMARY KEY,
  canonical_name TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('person', 'place', 'project', 'interest', 'application', 'event', 'organization', 'concept')),
  aliases_json TEXT NOT NULL DEFAULT '[]',
  overview TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('seed', 'active', 'merged', 'archived')),
  confidence REAL NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  merged_into TEXT REFERENCES memory_entities(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_entities_name_type
  ON memory_entities(canonical_name, entity_type)
  WHERE status IN ('seed', 'active');

CREATE TABLE IF NOT EXISTS memory_fragment_entities (
  fragment_id TEXT NOT NULL REFERENCES memory_fragments(id) ON DELETE CASCADE,
  entity_id TEXT NOT NULL REFERENCES memory_entities(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'subject',
  confidence REAL NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
  PRIMARY KEY(fragment_id, entity_id, role)
);

CREATE TABLE IF NOT EXISTS memory_relations (
  id TEXT PRIMARY KEY,
  claim_id TEXT REFERENCES memory_claims(id),
  source_entity_id TEXT NOT NULL REFERENCES memory_entities(id),
  relation_type TEXT NOT NULL,
  target_entity_id TEXT NOT NULL REFERENCES memory_entities(id),
  confidence REAL NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
  valid_from INTEGER,
  valid_until INTEGER,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('pending', 'active', 'superseded', 'deleted')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS memory_relation_sources (
  relation_id TEXT NOT NULL REFERENCES memory_relations(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES memory_sources(id) ON DELETE RESTRICT,
  PRIMARY KEY(relation_id, source_id)
);

CREATE TABLE IF NOT EXISTS memory_states (
  id TEXT PRIMARY KEY,
  claim_id TEXT REFERENCES memory_claims(id),
  state_type TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('pending', 'active', 'resolved', 'expired', 'superseded')),
  confidence REAL NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
  importance REAL NOT NULL DEFAULT 0.5 CHECK (importance >= 0 AND importance <= 1),
  starts_at INTEGER NOT NULL,
  expires_at INTEGER,
  resolved_at INTEGER,
  superseded_by TEXT REFERENCES memory_states(id),
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS memory_state_sources (
  state_id TEXT NOT NULL REFERENCES memory_states(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES memory_sources(id) ON DELETE RESTRICT,
  PRIMARY KEY(state_id, source_id)
);

CREATE TABLE IF NOT EXISTS memory_state_fragments (
  state_id TEXT NOT NULL REFERENCES memory_states(id) ON DELETE CASCADE,
  fragment_id TEXT NOT NULL REFERENCES memory_fragments(id) ON DELETE RESTRICT,
  fragment_revision INTEGER NOT NULL CHECK (fragment_revision >= 1),
  evidence_role TEXT NOT NULL DEFAULT 'support' CHECK (evidence_role IN ('support', 'context', 'contradiction')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(state_id, fragment_id, evidence_role)
);

CREATE TABLE IF NOT EXISTS memory_relation_fragments (
  relation_id TEXT NOT NULL REFERENCES memory_relations(id) ON DELETE CASCADE,
  fragment_id TEXT NOT NULL REFERENCES memory_fragments(id) ON DELETE RESTRICT,
  fragment_revision INTEGER NOT NULL CHECK (fragment_revision >= 1),
  evidence_role TEXT NOT NULL DEFAULT 'support' CHECK (evidence_role IN ('support', 'context', 'contradiction')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(relation_id, fragment_id, evidence_role)
);

CREATE TABLE IF NOT EXISTS memory_episodes (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'mature', 'archived', 'superseded')),
  confidence REAL NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
  importance REAL NOT NULL DEFAULT 0.5 CHECK (importance >= 0 AND importance <= 1),
  starts_at INTEGER,
  ends_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_accessed_at INTEGER NOT NULL,
  access_count INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  superseded_by TEXT REFERENCES memory_episodes(id),
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS memory_episode_fragments (
  episode_id TEXT NOT NULL REFERENCES memory_episodes(id) ON DELETE CASCADE,
  fragment_id TEXT NOT NULL REFERENCES memory_fragments(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(episode_id, fragment_id)
);

CREATE TABLE IF NOT EXISTS memory_episode_sources (
  episode_id TEXT NOT NULL REFERENCES memory_episodes(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES memory_sources(id) ON DELETE RESTRICT,
  PRIMARY KEY(episode_id, source_id)
);

CREATE TABLE IF NOT EXISTS memory_sagas (
  id TEXT PRIMARY KEY,
  theme TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'archived', 'superseded')),
  confidence REAL NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
  starts_at INTEGER,
  ends_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  superseded_by TEXT REFERENCES memory_sagas(id),
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS memory_saga_episodes (
  saga_id TEXT NOT NULL REFERENCES memory_sagas(id) ON DELETE CASCADE,
  episode_id TEXT NOT NULL REFERENCES memory_episodes(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(saga_id, episode_id)
);

CREATE TABLE IF NOT EXISTS memory_revisions (
  id TEXT PRIMARY KEY,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  action TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  reason TEXT NOT NULL DEFAULT '',
  confidence REAL NOT NULL DEFAULT 1 CHECK (confidence >= 0 AND confidence <= 1),
  actor TEXT NOT NULL CHECK (actor IN ('user', 'assistant', 'system', 'migration')),
  source_id TEXT REFERENCES memory_sources(id),
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_jobs (
  id TEXT PRIMARY KEY,
  job_type TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
  priority INTEGER NOT NULL DEFAULT 0,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_run_at INTEGER NOT NULL,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_vector_index (
  index_key TEXT PRIMARY KEY,
  target_type TEXT NOT NULL CHECK (target_type IN ('fragment', 'episode')),
  target_id TEXT NOT NULL,
  target_revision INTEGER NOT NULL CHECK (target_revision >= 1),
  content_hash TEXT NOT NULL,
  rag_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'synced', 'stale', 'deleting', 'error')),
  last_error TEXT,
  synced_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_recall_log (
  id TEXT PRIMARY KEY,
  query TEXT NOT NULL,
  intent TEXT NOT NULL,
  candidate_counts_json TEXT NOT NULL DEFAULT '{}',
  injected_items_json TEXT NOT NULL DEFAULT '[]',
  rejected_items_json TEXT NOT NULL DEFAULT '[]',
  duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_shadow_recall_log (
  id TEXT PRIMARY KEY,
  query_hash TEXT NOT NULL,
  query_preview TEXT NOT NULL DEFAULT '',
  intent TEXT NOT NULL,
  legacy_items_json TEXT NOT NULL DEFAULT '[]',
  v2_items_json TEXT NOT NULL DEFAULT '[]',
  overlap_count INTEGER NOT NULL DEFAULT 0,
  legacy_duration_ms INTEGER NOT NULL DEFAULT 0,
  v2_duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS legacy_imports (
  source_key TEXT PRIMARY KEY,
  source_schema_version INTEGER NOT NULL,
  source_hash TEXT NOT NULL,
  imported_at INTEGER NOT NULL,
  result_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_fragments_status_access
  ON memory_fragments(status, last_accessed_at);
CREATE INDEX IF NOT EXISTS idx_fragments_claim
  ON memory_fragments(claim_id, status);
CREATE INDEX IF NOT EXISTS idx_states_claim
  ON memory_states(claim_id, status);
CREATE INDEX IF NOT EXISTS idx_relations_claim
  ON memory_relations(claim_id, status);
CREATE INDEX IF NOT EXISTS idx_vector_index_target
  ON memory_vector_index(target_type, target_id, status);
CREATE INDEX IF NOT EXISTS idx_fragments_kind_status
  ON memory_fragments(kind, status);
CREATE INDEX IF NOT EXISTS idx_sources_conversation
  ON memory_sources(conversation_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_states_type_status
  ON memory_states(state_type, status, expires_at);
CREATE INDEX IF NOT EXISTS idx_episodes_status_time
  ON memory_episodes(status, starts_at, ends_at);
CREATE INDEX IF NOT EXISTS idx_jobs_ready
  ON memory_jobs(status, next_run_at, priority);
CREATE INDEX IF NOT EXISTS idx_memory_events_pending
  ON memory_event_log(status, occurred_at);
CREATE INDEX IF NOT EXISTS idx_shadow_recall_created
  ON memory_shadow_recall_log(created_at DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_fragments_fts USING fts5(
  fragment_id UNINDEXED,
  content,
  tokenize = 'unicode61'
);
CREATE VIRTUAL TABLE IF NOT EXISTS memory_entities_fts USING fts5(
  entity_id UNINDEXED,
  canonical_name,
  aliases,
  overview,
  tokenize = 'unicode61'
);
CREATE VIRTUAL TABLE IF NOT EXISTS memory_episodes_fts USING fts5(
  episode_id UNINDEXED,
  title,
  content,
  tokenize = 'unicode61'
);

CREATE TRIGGER IF NOT EXISTS memory_fragments_ai AFTER INSERT ON memory_fragments BEGIN
  INSERT INTO memory_fragments_fts(fragment_id, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER IF NOT EXISTS memory_fragments_au AFTER UPDATE OF content ON memory_fragments BEGIN
  DELETE FROM memory_fragments_fts WHERE fragment_id = old.id;
  INSERT INTO memory_fragments_fts(fragment_id, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER IF NOT EXISTS memory_fragments_ad AFTER DELETE ON memory_fragments BEGIN
  DELETE FROM memory_fragments_fts WHERE fragment_id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS memory_entities_ai AFTER INSERT ON memory_entities BEGIN
  INSERT INTO memory_entities_fts(entity_id, canonical_name, aliases, overview)
  VALUES (new.id, new.canonical_name, new.aliases_json, new.overview);
END;
CREATE TRIGGER IF NOT EXISTS memory_entities_au AFTER UPDATE OF canonical_name, aliases_json, overview ON memory_entities BEGIN
  DELETE FROM memory_entities_fts WHERE entity_id = old.id;
  INSERT INTO memory_entities_fts(entity_id, canonical_name, aliases, overview)
  VALUES (new.id, new.canonical_name, new.aliases_json, new.overview);
END;
CREATE TRIGGER IF NOT EXISTS memory_entities_ad AFTER DELETE ON memory_entities BEGIN
  DELETE FROM memory_entities_fts WHERE entity_id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS memory_episodes_ai AFTER INSERT ON memory_episodes BEGIN
  INSERT INTO memory_episodes_fts(episode_id, title, content) VALUES (new.id, new.title, new.content);
END;
CREATE TRIGGER IF NOT EXISTS memory_episodes_au AFTER UPDATE OF title, content ON memory_episodes BEGIN
  DELETE FROM memory_episodes_fts WHERE episode_id = old.id;
  INSERT INTO memory_episodes_fts(episode_id, title, content) VALUES (new.id, new.title, new.content);
END;
CREATE TRIGGER IF NOT EXISTS memory_episodes_ad AFTER DELETE ON memory_episodes BEGIN
  DELETE FROM memory_episodes_fts WHERE episode_id = old.id;
END;
`

export const MEMORY_V2_MIGRATION_2_SQL = `
CREATE TABLE IF NOT EXISTS memory_event_log (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  user_text TEXT NOT NULL,
  assistant_text TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'processed', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  processed_at INTEGER,
  last_error TEXT,
  user_source_id TEXT NOT NULL REFERENCES memory_sources(id),
  assistant_source_id TEXT NOT NULL REFERENCES memory_sources(id)
);
CREATE INDEX IF NOT EXISTS idx_memory_events_pending
  ON memory_event_log(status, occurred_at);
`

export const MEMORY_V2_MIGRATION_3_SQL = `
CREATE TABLE IF NOT EXISTS memory_claims (
  id TEXT PRIMARY KEY,
  semantic_key TEXT NOT NULL UNIQUE,
  canonical_text TEXT NOT NULL,
  claim_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('pending', 'active', 'superseded', 'retired')),
  confidence REAL NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  superseded_by TEXT REFERENCES memory_claims(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

ALTER TABLE memory_fragments ADD COLUMN claim_id TEXT REFERENCES memory_claims(id);
ALTER TABLE memory_fragments ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1);
ALTER TABLE memory_states ADD COLUMN claim_id TEXT REFERENCES memory_claims(id);
ALTER TABLE memory_relations ADD COLUMN claim_id TEXT REFERENCES memory_claims(id);

CREATE TABLE IF NOT EXISTS memory_state_fragments (
  state_id TEXT NOT NULL REFERENCES memory_states(id) ON DELETE CASCADE,
  fragment_id TEXT NOT NULL REFERENCES memory_fragments(id) ON DELETE RESTRICT,
  fragment_revision INTEGER NOT NULL CHECK (fragment_revision >= 1),
  evidence_role TEXT NOT NULL DEFAULT 'support' CHECK (evidence_role IN ('support', 'context', 'contradiction')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(state_id, fragment_id, evidence_role)
);

CREATE TABLE IF NOT EXISTS memory_relation_fragments (
  relation_id TEXT NOT NULL REFERENCES memory_relations(id) ON DELETE CASCADE,
  fragment_id TEXT NOT NULL REFERENCES memory_fragments(id) ON DELETE RESTRICT,
  fragment_revision INTEGER NOT NULL CHECK (fragment_revision >= 1),
  evidence_role TEXT NOT NULL DEFAULT 'support' CHECK (evidence_role IN ('support', 'context', 'contradiction')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(relation_id, fragment_id, evidence_role)
);

CREATE TABLE IF NOT EXISTS memory_vector_index (
  index_key TEXT PRIMARY KEY,
  target_type TEXT NOT NULL CHECK (target_type IN ('fragment', 'episode')),
  target_id TEXT NOT NULL,
  target_revision INTEGER NOT NULL CHECK (target_revision >= 1),
  content_hash TEXT NOT NULL,
  rag_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'synced', 'stale', 'deleting', 'error')),
  last_error TEXT,
  synced_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_fragments_claim ON memory_fragments(claim_id, status);
CREATE INDEX IF NOT EXISTS idx_states_claim ON memory_states(claim_id, status);
CREATE INDEX IF NOT EXISTS idx_relations_claim ON memory_relations(claim_id, status);
CREATE INDEX IF NOT EXISTS idx_vector_index_target ON memory_vector_index(target_type, target_id, status);
`

export const MEMORY_V2_MIGRATION_4_SQL = `
CREATE TABLE IF NOT EXISTS memory_shadow_recall_log (
  id TEXT PRIMARY KEY,
  query_hash TEXT NOT NULL,
  query_preview TEXT NOT NULL DEFAULT '',
  intent TEXT NOT NULL,
  legacy_items_json TEXT NOT NULL DEFAULT '[]',
  v2_items_json TEXT NOT NULL DEFAULT '[]',
  overlap_count INTEGER NOT NULL DEFAULT 0,
  legacy_duration_ms INTEGER NOT NULL DEFAULT 0,
  v2_duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shadow_recall_created
  ON memory_shadow_recall_log(created_at DESC);
`
