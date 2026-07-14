import type { MemoryV2Database } from "./database"

let paused = false

export function isMemoryAutomationPaused(): boolean {
  return paused
}

export function initializeMemoryAutomationRuntime(db: MemoryV2Database): boolean {
  paused = String(db.prepare("SELECT value FROM memory_meta WHERE key = 'automation.paused'").get()?.value ?? "false") === "true"
  return paused
}

export function setMemoryAutomationPaused(value: boolean, db?: MemoryV2Database | null, now = Date.now()): boolean {
  paused = value
  db?.prepare(`
    INSERT INTO memory_meta(key, value, updated_at) VALUES ('automation.paused', ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(String(value), now)
  return paused
}
