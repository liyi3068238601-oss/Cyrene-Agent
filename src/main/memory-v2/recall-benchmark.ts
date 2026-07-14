import type { MemoryRecallPermission } from "./librarian"

export interface RecallBenchmarkCase {
  id: string
  query: string
  mustRecall: string[]
  mayRecall: string[]
  mustNotRecall: string[]
  expectedPermission: MemoryRecallPermission
}

export const RECALL_BENCHMARK_MEMORIES = [
  ["editor", "The user's preferred code editor is AuroraEdit."],
  ["city", "The user currently lives in JadeCity."],
  ["drink", "The user's usual evening drink is LumenTea."],
  ["keyboard", "The user's primary keyboard is NimbusBoard."],
  ["language", "The user's usual working language is OrchidChinese."],
  ["project", "The user's current long-term project is HarborAgent."],
  ["anniversary", "The user's important annual date is SolsticeDay."],
  ["companion", "The user's household companion is named Quartz."],
  ["music", "The user's focus music playlist is CedarNotes."],
  ["timezone", "The user's home timezone is VelvetTime."],
] as const

const QUERY_VARIANTS = [
  "What do you remember about {token}?",
  "Tell me the saved fact for {token}.",
  "Is there a user detail connected to {token}?",
  "Recall {token}.",
  "Which preference mentions {token}?",
  "What was recorded with the keyword {token}?",
  "Do you know the context of {token}?",
  "Find the memory containing {token}.",
  "What user fact includes {token}?",
  "Please remember what {token} refers to.",
]

export const RECALL_BENCHMARK_CASES: RecallBenchmarkCase[] = RECALL_BENCHMARK_MEMORIES.flatMap(
  ([id, content]) => {
    const token = content.match(/\b[A-Z][A-Za-z]+(?:Edit|City|Tea|Board|Chinese|Agent|Day|Notes|Time)?\b/g)?.at(-1)?.replace(/\.$/, "") ?? id
    const expectedId = `benchmark_${id}`
    const forbidden = RECALL_BENCHMARK_MEMORIES.filter(([other]) => other !== id).map(([other]) => `benchmark_${other}`)
    return QUERY_VARIANTS.map((template, index) => ({
      id: `${id}_${index + 1}`,
      query: template.replace("{token}", token),
      mustRecall: [expectedId],
      mayRecall: [],
      mustNotRecall: forbidden,
      expectedPermission: "can_quote" as const,
    }))
  },
)

if (RECALL_BENCHMARK_CASES.length !== 100) {
  throw new Error(`Recall benchmark must contain exactly 100 cases; got ${RECALL_BENCHMARK_CASES.length}`)
}
