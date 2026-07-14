import { afterEach, describe, expect, it } from "vitest"
import { MemoryV2Database } from "./database"
import { findFragmentConflict, memoryPolarity, memoryTopic } from "./conflict-resolver"

const databases: MemoryV2Database[] = []
afterEach(() => databases.splice(0).forEach((db) => db.close()))

describe("Memory v2 conflict resolver", () => {
  it("recognizes opposite preference statements about the same topic", () => {
    expect(memoryPolarity("\u6211\u559c\u6b22\u559d\u5496\u5561")).toBe("positive")
    expect(memoryPolarity("\u6211\u4e0d\u559c\u6b22\u559d\u5496\u5561")).toBe("negative")
    expect(memoryTopic("\u6211\u559c\u6b22\u559d\u5496\u5561")).toBe(memoryTopic("\u6211\u4e0d\u559c\u6b22\u559d\u5496\u5561"))
  })

  it("finds only a same-topic opposite active fragment", () => {
    const db = new MemoryV2Database(":memory:")
    databases.push(db)
    db.prepare(`INSERT INTO memory_fragments(
      id, content, kind, certainty, attribution, confidence, importance,
      emotional_weight, status, created_at, updated_at, last_accessed_at,
      access_count, pinned, metadata_json
    ) VALUES ('old', ?, 'preference', 'explicit', 'user', .9, .7, .5,
      'active', 1, 1, 1, 0, 0, '{}')`).run("\u6211\u559c\u6b22\u559d\u5496\u5561")
    expect(findFragmentConflict(db, "\u6211\u4e0d\u559c\u6b22\u559d\u5496\u5561", "preference")?.id).toBe("old")
    expect(findFragmentConflict(db, "\u6211\u4e0d\u559c\u6b22\u8336", "preference")).toBeNull()
  })
})
