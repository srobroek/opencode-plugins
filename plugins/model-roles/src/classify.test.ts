import { describe, expect, test } from "bun:test"
import {
  agentHash,
  buildClassifyPrompt,
  CLASSIFY_FALLBACK,
  parseClassification,
  planImplicit,
  readClassification,
  textHash,
} from "./classify.ts"
import { TIER_PURPOSE, type TierMeta } from "./tiers.ts"

const header = "x-opencode-model-role"
const tiers: Record<string, TierMeta> = Object.fromEntries(
  ["cheap", "standard", "strong"].map((name) => [name, { purpose: TIER_PURPOSE[name] as string, distinctVendor: false, source: "derived", cost: "" }]),
)

describe("planImplicit", () => {
  const agents = [
    { id: "general", mode: "subagent" },
    { id: "explore", mode: "subagent" },
    { id: "title", mode: "primary" },
    { id: "docs", mode: "subagent", description: "Writes docs" },
    { id: "pinned", mode: "subagent", model: { providerID: "a", id: "b" } },
    { id: "headed", mode: "subagent", request: { headers: { "X-OpenCode-Model-Role": "strong" } } },
    { id: "configured", mode: "subagent" },
    { id: "build", mode: "primary" },
  ]
  const base = { agents, configured: { configured: "cheap" }, header, classified: {}, autoGeneral: false }

  test("general on standard, built-ins on their defaults, unclassified subagents pending", () => {
    const plan = planImplicit(base)
    expect(plan.implicit).toEqual({ general: "standard", explore: "cheap", title: "tiny" })
    expect(plan.pending.map((a) => a.id)).toEqual(["docs"])
  })

  test("the auto picker owns general; a cached classification applies only to the same description", () => {
    const docs = { tier: "cheap", hash: agentHash({ description: "Writes docs" }) }
    expect(planImplicit({ ...base, autoGeneral: true, classified: { docs } }).implicit).toEqual({
      explore: "cheap",
      title: "tiny",
      docs: "cheap",
    })
    const stale = planImplicit({ ...base, classified: { docs: { ...docs, hash: "00000000" } } })
    expect(stale.implicit.docs).toBeUndefined()
    expect(stale.pending.map((a) => a.id)).toEqual(["docs"])
  })

  test("a failed classification falls back to standard for the run", () => {
    const failed = new Set([`docs\0${agentHash({ description: "Writes docs" })}`])
    const plan = planImplicit({ ...base, failed })
    expect(plan.implicit.docs).toBe(CLASSIFY_FALLBACK)
    expect(plan.pending).toEqual([])
  })
})

describe("classification prompt and reply", () => {
  test("names every tier with its purpose and the description", () => {
    const prompt = buildClassifyPrompt({ id: "docs", description: "Writes docs" }, tiers)
    expect(prompt).toContain('{"tier": "<one of: cheap, standard, strong>"}')
    expect(prompt).toContain(`- 'strong': ${TIER_PURPOSE.strong}`)
    expect(prompt).toContain("Agent: docs")
    expect(prompt).toContain("Writes docs")
  })

  test("reads the first JSON object, rejecting unknown tiers", () => {
    expect(parseClassification('```json\n{"tier": "cheap"}\n```', ["cheap"])).toBe("cheap")
    expect(parseClassification('{"tier": "huge"}', ["cheap"])).toBeUndefined()
    expect(parseClassification("no", ["cheap"])).toBeUndefined()
    expect(parseClassification("{nope}", ["cheap"])).toBeUndefined()
  })

  test("hashes are stable and storage values are checked", () => {
    expect(textHash("abc")).toBe(textHash("abc"))
    expect(textHash("abc")).not.toBe(textHash("abd"))
    expect(textHash("")).toMatch(/^[0-9a-f]{8}$/)
    expect(readClassification({ hash: "1", tier: "cheap" })).toEqual({ hash: "1", tier: "cheap" })
    expect(readClassification({ tier: "cheap" })).toBeUndefined()
    expect(readClassification(null)).toBeUndefined()
  })
})
