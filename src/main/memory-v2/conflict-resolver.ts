import type { MemoryV2Database } from "./database"

export type MemoryPolarity = "positive" | "negative" | "neutral"

export interface FragmentConflict {
  id: string
  content: string
  topic: string
  polarity: Exclude<MemoryPolarity, "neutral">
}

const POSITIVE = /(?:\u559c\u6b22|\u504f\u597d|\u7231\u5403|\u7231\u559d|(?:^|\s)(?:like|love|prefer)\b)/i
const NEGATIVE = /(?:\u4e0d\u559c\u6b22|\u8ba8\u538c|\u4e0d\u7231|(?:^|\s)(?:dislike|hate)\b)/i

export function memoryPolarity(content: string): MemoryPolarity {
  if (NEGATIVE.test(content)) return "negative"
  if (POSITIVE.test(content)) return "positive"
  return "neutral"
}

export function memoryTopic(content: string): string {
  return content
    .toLowerCase()
    .replace(NEGATIVE, " ")
    .replace(POSITIVE, " ")
    .replace(/[\s,.;:!?，。；：！？、'"“”‘’（）()\[\]{}]+/g, "")
}

export function findFragmentConflict(
  db: MemoryV2Database,
  content: string,
  kind: string,
): FragmentConflict | null {
  const polarity = memoryPolarity(content)
  const topic = memoryTopic(content)
  if (polarity === "neutral" || topic.length < 1) return null

  const rows = db.prepare(`
    SELECT id, content FROM memory_fragments
    WHERE status IN ('active', 'cooling', 'frozen') AND kind = ?
    ORDER BY updated_at DESC LIMIT 100
  `).all(kind)
  for (const row of rows) {
    const oldContent = String(row.content)
    const oldPolarity = memoryPolarity(oldContent)
    if (oldPolarity === "neutral" || oldPolarity === polarity) continue
    if (memoryTopic(oldContent) !== topic) continue
    return { id: String(row.id), content: oldContent, topic, polarity: oldPolarity }
  }
  return null
}
