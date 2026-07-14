import * as fs from "fs"
import * as path from "path"
import {
  MEMORY_V2_MIGRATION_2_SQL,
  MEMORY_V2_MIGRATION_3_SQL,
  MEMORY_V2_MIGRATION_4_SQL,
  MEMORY_V2_SCHEMA_SQL,
  MEMORY_V2_SCHEMA_VERSION,
} from "./schema"

export interface SqliteStatement {
  all(...params: unknown[]): Array<Record<string, unknown>>
  get(...params: unknown[]): Record<string, unknown> | undefined
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint }
}

interface SqliteDatabase {
  exec(sql: string): void
  prepare(sql: string): SqliteStatement
  close(): void
}

const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (filePath: string) => SqliteDatabase
}

const SQLITE_MEMORY_PATH = ":memory:"

export interface MemoryV2DatabaseOptions {
  now?: () => number
  backupBeforeMigration?: boolean
}

export interface MemoryV2Health {
  schemaVersion: number
  integrity: string
  foreignKeyViolations: number
  path: string
}

function timestampForFile(now: number): string {
  return new Date(now).toISOString().replace(/[:.]/g, "-")
}

function copyIfPresent(source: string, destination: string): void {
  if (fs.existsSync(source)) fs.copyFileSync(source, destination)
}

function backupDatabaseFiles(filePath: string, now: number): string | null {
  if (filePath === SQLITE_MEMORY_PATH || !fs.existsSync(filePath)) return null
  const backupDir = path.join(path.dirname(filePath), "backups")
  fs.mkdirSync(backupDir, { recursive: true })
  const stem = `memory-v2.${timestampForFile(now)}.sqlite`
  const backupPath = path.join(backupDir, stem)
  copyIfPresent(filePath, backupPath)
  copyIfPresent(`${filePath}-wal`, `${backupPath}-wal`)
  copyIfPresent(`${filePath}-shm`, `${backupPath}-shm`)
  return backupPath
}

export class MemoryV2Database {
  readonly path: string
  private readonly db: SqliteDatabase
  private readonly now: () => number
  private closed = false

  constructor(filePath: string, options: MemoryV2DatabaseOptions = {}) {
    this.path = filePath
    this.now = options.now ?? Date.now
    if (filePath !== SQLITE_MEMORY_PATH) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
    }

    const existed = filePath !== SQLITE_MEMORY_PATH && fs.existsSync(filePath)
    this.db = new DatabaseSync(filePath)
    this.configure()
    const current = this.readSchemaVersion()
    if (existed && current < MEMORY_V2_SCHEMA_VERSION && options.backupBeforeMigration !== false) {
      this.checkpoint()
      backupDatabaseFiles(filePath, this.now())
    }
    this.migrate()
  }

  private configure(): void {
    this.db.exec("PRAGMA foreign_keys = ON;")
    this.db.exec("PRAGMA busy_timeout = 5000;")
    if (this.path !== SQLITE_MEMORY_PATH) {
      this.db.exec("PRAGMA journal_mode = WAL;")
      this.db.exec("PRAGMA synchronous = NORMAL;")
    }
  }

  private migrate(): void {
    const current = this.readSchemaVersion()
    if (current > MEMORY_V2_SCHEMA_VERSION) {
      throw new Error(`Memory v2 schema ${current} is newer than supported ${MEMORY_V2_SCHEMA_VERSION}`)
    }
    if (current === MEMORY_V2_SCHEMA_VERSION) return

    this.transaction(() => {
      if (current < 1) {
        this.db.exec(MEMORY_V2_SCHEMA_SQL)
        const recordMigration = this.db.prepare(`
          INSERT OR IGNORE INTO schema_migrations(version, applied_at, description)
          VALUES (?, ?, ?)
        `)
        recordMigration.run(1, this.now(), "Initial Memory v2 schema")
        recordMigration.run(2, this.now(), "Add persistent global Scribe event log")
        recordMigration.run(3, this.now(), "Add claims, projection dependencies, and vector sync ledger")
        recordMigration.run(4, this.now(), "Add shadow recall comparison telemetry")
      } else if (current < 2) {
        this.db.exec(MEMORY_V2_MIGRATION_2_SQL)
        this.db.prepare(`
          INSERT OR IGNORE INTO schema_migrations(version, applied_at, description)
          VALUES (?, ?, ?)
        `).run(2, this.now(), "Add persistent global Scribe event log")
      }
      if (current >= 1 && current < 3) {
        this.db.exec(MEMORY_V2_MIGRATION_3_SQL)
        this.db.prepare(`
          INSERT OR IGNORE INTO schema_migrations(version, applied_at, description)
          VALUES (?, ?, ?)
        `).run(3, this.now(), "Add claims, projection dependencies, and vector sync ledger")
      }
      if (current >= 1 && current < 4) {
        this.db.exec(MEMORY_V2_MIGRATION_4_SQL)
        this.db.prepare(`
          INSERT OR IGNORE INTO schema_migrations(version, applied_at, description)
          VALUES (?, ?, ?)
        `).run(4, this.now(), "Add shadow recall comparison telemetry")
      }
      this.db.exec(`PRAGMA user_version = ${MEMORY_V2_SCHEMA_VERSION};`)
    })
  }

  prepare(sql: string): SqliteStatement {
    this.assertOpen()
    return this.db.prepare(sql)
  }

  exec(sql: string): void {
    this.assertOpen()
    this.db.exec(sql)
  }

  transaction<T>(work: () => T): T {
    this.assertOpen()
    this.db.exec("BEGIN IMMEDIATE;")
    try {
      const result = work()
      this.db.exec("COMMIT;")
      return result
    } catch (error) {
      try {
        this.db.exec("ROLLBACK;")
      } catch {
        // Preserve the original error.
      }
      throw error
    }
  }

  getSchemaVersion(): number {
    return this.readSchemaVersion()
  }

  getHealth(): MemoryV2Health {
    const integrity = String(this.prepare("PRAGMA integrity_check").get()?.integrity_check ?? "unknown")
    const foreignKeyViolations = this.prepare("PRAGMA foreign_key_check").all().length
    return {
      schemaVersion: this.getSchemaVersion(),
      integrity,
      foreignKeyViolations,
      path: this.path,
    }
  }

  checkpoint(): void {
    if (this.closed || this.path === SQLITE_MEMORY_PATH) return
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE);")
  }

  backup(now = this.now()): string | null {
    this.assertOpen()
    this.checkpoint()
    return backupDatabaseFiles(this.path, now)
  }

  close(): void {
    if (this.closed) return
    this.checkpoint()
    this.db.close()
    this.closed = true
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Memory v2 database is closed")
  }

  private readSchemaVersion(): number {
    return Number(this.db.prepare("PRAGMA user_version").get()?.user_version ?? 0)
  }
}

export function getDefaultMemoryV2Path(userDataPath: string): string {
  return path.join(userDataPath, "cyrene-memory", "memory-v2.sqlite")
}
