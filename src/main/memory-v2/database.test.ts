import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, describe, expect, it } from "vitest"
import { MemoryV2Database } from "./database"
import { MEMORY_V2_SCHEMA_VERSION } from "./schema"

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe("MemoryV2Database", () => {
  it("creates the complete schema with WAL and healthy foreign keys", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-memory-v2-"))
    tempDirs.push(dir)
    const db = new MemoryV2Database(path.join(dir, "memory-v2.sqlite"))

    expect(db.getSchemaVersion()).toBe(MEMORY_V2_SCHEMA_VERSION)
    expect(db.getHealth()).toMatchObject({ integrity: "ok", foreignKeyViolations: 0 })

    const tables = new Set(db.prepare(`
      SELECT name FROM sqlite_master WHERE type IN ('table', 'view')
    `).all().map((row) => String(row.name)))
    for (const required of [
      "core_profile",
      "core_facts",
      "memory_event_log",
      "memory_claims",
      "memory_sources",
      "conversation_archives",
      "memory_fragments",
      "memory_entities",
      "memory_states",
      "memory_episodes",
      "memory_sagas",
      "memory_jobs",
      "memory_state_fragments",
      "memory_relation_fragments",
      "memory_vector_index",
      "memory_recall_log",
      "memory_shadow_recall_log",
    ]) {
      expect(tables.has(required), required).toBe(true)
    }
    db.close()
  })

  it("keeps FTS indexes synchronized through triggers", () => {
    const db = new MemoryV2Database(":memory:")
    const now = Date.now()
    db.prepare(`
      INSERT INTO memory_fragments(
        id, content, kind, certainty, attribution, confidence, importance,
        emotional_weight, status, created_at, updated_at, last_accessed_at,
        access_count, pinned, metadata_json
      ) VALUES (?, ?, 'fact', 'explicit', 'user', 1, 0.8, 0.5, 'active', ?, ?, ?, 0, 0, '{}')
    `).run("fragment-1", "purple flowers 用户喜欢紫色花朵", now, now, now)

    expect(db.prepare(`
      SELECT fragment_id FROM memory_fragments_fts WHERE memory_fragments_fts MATCH ?
    `).all("purple")).toHaveLength(1)

    db.prepare("UPDATE memory_fragments SET content = ? WHERE id = ?").run("white flowers 用户喜欢白色花朵", "fragment-1")
    expect(db.prepare(`
      SELECT fragment_id FROM memory_fragments_fts WHERE memory_fragments_fts MATCH ?
    `).all("purple")).toHaveLength(0)
    expect(db.prepare(`
      SELECT fragment_id FROM memory_fragments_fts WHERE memory_fragments_fts MATCH ?
    `).all("white")).toHaveLength(1)
    db.close()
  })

  it("rolls back an entire transaction when a write fails", () => {
    const db = new MemoryV2Database(":memory:")
    expect(() => db.transaction(() => {
      db.prepare(`
        INSERT INTO core_facts(
          id, namespace, key, value, status, confidence, pinned, created_at, updated_at
        ) VALUES ('one', 'user', 'anniversary', 'July', 'active', 1, 0, 1, 1)
      `).run()
      db.prepare(`
        INSERT INTO core_facts(
          id, namespace, key, value, status, confidence, pinned, created_at, updated_at
        ) VALUES ('two', 'user', 'anniversary', 'August', 'active', 1, 0, 1, 1)
      `).run()
    })).toThrow()

    expect(db.prepare("SELECT id FROM core_facts").all()).toHaveLength(0)
    db.close()
  })

  it("creates a readable checkpointed backup without altering the live database", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-memory-v2-backup-"))
    tempDirs.push(dir)
    const db = new MemoryV2Database(path.join(dir, "memory-v2.sqlite"))
    db.prepare("INSERT INTO core_profile(id, preferred_name, updated_at) VALUES (1, 'Master', 1)").run()
    const backupPath = db.backup(Date.UTC(2026, 6, 14))
    expect(backupPath).toBeTruthy()
    expect(fs.existsSync(String(backupPath))).toBe(true)
    db.close()

    const restored = new MemoryV2Database(String(backupPath), { backupBeforeMigration: false })
    expect(restored.prepare("SELECT preferred_name FROM core_profile WHERE id = 1").get()?.preferred_name).toBe("Master")
    expect(restored.getHealth().integrity).toBe("ok")
    restored.close()
  })

  it("migrates an existing schema v2 database without losing memories", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-memory-v2-migrate-"))
    tempDirs.push(dir)
    const filePath = path.join(dir, "memory-v2.sqlite")
    const seeded = new MemoryV2Database(filePath)
    const now = Date.UTC(2026, 6, 14)
    seeded.prepare(`
      INSERT INTO memory_fragments(
        id, content, kind, certainty, attribution, confidence, importance,
        emotional_weight, status, created_at, updated_at, last_accessed_at,
        access_count, pinned, revision, metadata_json
      ) VALUES ('legacy-fragment', 'preserved', 'fact', 'explicit', 'user', 1, 0.8,
        0.5, 'active', ?, ?, ?, 0, 0, 1, '{}')
    `).run(now, now, now)
    seeded.exec("DROP TABLE memory_state_fragments")
    seeded.exec("DROP TABLE memory_relation_fragments")
    seeded.exec("DROP TABLE memory_vector_index")
    seeded.exec("DROP INDEX idx_fragments_claim")
    seeded.exec("DROP INDEX idx_states_claim")
    seeded.exec("DROP INDEX idx_relations_claim")
    seeded.exec("ALTER TABLE memory_fragments DROP COLUMN claim_id")
    seeded.exec("ALTER TABLE memory_fragments DROP COLUMN revision")
    seeded.exec("ALTER TABLE memory_states DROP COLUMN claim_id")
    seeded.exec("ALTER TABLE memory_relations DROP COLUMN claim_id")
    seeded.exec("DROP TABLE memory_claims")
    seeded.exec("DELETE FROM schema_migrations WHERE version = 3")
    seeded.exec("PRAGMA user_version = 2")
    seeded.close()

    const migrated = new MemoryV2Database(filePath)
    expect(migrated.getSchemaVersion()).toBe(MEMORY_V2_SCHEMA_VERSION)
    expect(migrated.prepare("SELECT content, revision FROM memory_fragments WHERE id = 'legacy-fragment'").get())
      .toMatchObject({ content: "preserved", revision: 1 })
    expect(migrated.getHealth()).toMatchObject({ integrity: "ok", foreignKeyViolations: 0 })
    expect(fs.readdirSync(path.join(dir, "backups")).length).toBeGreaterThan(0)
    migrated.close()
  })
})
