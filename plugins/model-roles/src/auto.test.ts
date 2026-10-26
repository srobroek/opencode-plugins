import { describe, expect, test } from "bun:test"
import {
  AUTO_HISTORY_LIMIT,
  type AutoRecord,
  autoEligible,
  buildDeciderPrompt,
  capRole,
  DECIDER_PROMPT_LIMIT,
  DEFAULT_AUTO_TIMEOUT_MS,
  deciderModel,
  formatHistory,
  parseAuto,
  parseDecision,
  pickRole,
  pushHistory,
  roleCosts,
  withAutoTag,
} from "./auto.ts"
import { parseOptions } from "./resolve.ts"

const options = parseOptions({
  roles: { smol: "anthropic/haiku", task: "bedrock/sonnet#high", slow: "bedrock/opus", tiny: "anthropic/haiku" },
  agents: { explore: "smol" },
})
const available = [
  { providerID: "anthropic", id: "haiku", cost: [{ input: 0.8 }] },
  { providerID: "bedrock", id: "sonnet", variants: [{ id: "high" }], cost: [{ input: 3 }] },
  { providerID: "bedrock", id: "opus", cost: [{ input: 5 }] },
]

describe("parseAuto", () => {
  test("is off unless set, and fills in defaults", () => {
    expect(parseAuto(undefined, options)).toBeUndefined()
    expect(parseAuto(false, options)).toBeUndefined()
    expect(parseAuto({ enabled: false }, options)).toBeUndefined()
    expect(parseAuto(true, options)).toEqual({
      decider: "@smol",
      roles: ["smol", "task"],
      default: "task",
      timeoutMs: DEFAULT_AUTO_TIMEOUT_MS,
      capAtParent: true,
    })
  })

  test("keeps configured roles only and a default among them", () => {
    const auto = parseAuto({ decider: "@tiny", roles: ["slow", "nope", "smol", "smol"], default: "task", timeoutMs: 900, capAtParent: false }, options)
    expect(auto).toEqual({ decider: "@tiny", roles: ["slow", "smol"], default: "slow", timeoutMs: 900, capAtParent: false })
    expect(parseAuto({ roles: ["nope"] }, options)).toBeUndefined()
    expect(parseAuto({ timeoutMs: -1 }, options)?.timeoutMs).toBe(DEFAULT_AUTO_TIMEOUT_MS)
  })
})

describe("deciderModel", () => {
  const auto = parseAuto(true, options) as NonNullable<ReturnType<typeof parseAuto>>
  test("resolves a role or checks a model", () => {
    expect(deciderModel({ ...auto, decider: "@tiny" }, options, available)).toEqual({ providerID: "anthropic", id: "haiku" })
    expect(deciderModel({ ...auto, decider: "bedrock/opus" }, options, available)).toEqual({ providerID: "bedrock", id: "opus" })
    expect(deciderModel({ ...auto, decider: "x/y" }, options, available)).toBeUndefined()
    expect(deciderModel({ ...auto, decider: "@missing" }, options, available)).toBeUndefined()
    expect(deciderModel({ ...auto, decider: "garbage" }, options, available)).toBeUndefined()
  })
})

describe("autoEligible", () => {
  test("only fresh spawns of agents without a model or role", () => {
    const plain = { id: "general" }
    expect(autoEligible({ agent: "general", prompt: "x" }, plain, options)).toBe(true)
    expect(autoEligible({ agent: "general", prompt: "x", sessionID: "ses_1" }, plain, options)).toBe(false)
    expect(autoEligible({ agent: "general", prompt: "x", model: "a/b" }, plain, options)).toBe(false)
    expect(autoEligible({ agent: "general", prompt: "x", role: "smol" }, plain, options)).toBe(false)
    expect(autoEligible({ agent: "x" }, { id: "x", model: { providerID: "a", id: "b" } }, options)).toBe(false)
    expect(autoEligible({ agent: "explore" }, { id: "explore" }, options)).toBe(false)
    const header = { id: "h", request: { headers: { "x-opencode-model-role": "task" } } }
    expect(autoEligible({ agent: "h" }, header, options)).toBe(false)
    expect(autoEligible({ agent: "general" }, undefined, options)).toBe(false)
    expect(autoEligible(null, plain, options)).toBe(false)
  })
})

describe("buildDeciderPrompt", () => {
  const choices = [
    { role: "smol", purpose: "cheap lookups", cost: 0.8, available: true },
    { role: "task", purpose: "everyday work", cost: 3, available: true },
  ]
  test("names the roles, the agent, the label and the task", () => {
    const prompt = buildDeciderPrompt({
      agent: { id: "general", description: "General agent." },
      description: "find parser",
      prompt: "where is parseOptions?",
      choices,
    })
    expect(prompt).toContain('{"role": "<one of: smol, task>", "confident": true|false}')
    expect(prompt).toContain("- 'smol': cheap lookups (low cost, $0.8/M input tokens)")
    expect(prompt).toContain("Agent: general — General agent.")
    expect(prompt).toContain("Spawn description: find parser")
    expect(prompt).toContain("<<<\nwhere is parseOptions?\n>>>")
  })

  test("cuts a long prompt", () => {
    const prompt = buildDeciderPrompt({ agent: { id: "g" }, prompt: "a".repeat(DECIDER_PROMPT_LIMIT + 500), choices })
    expect(prompt).toContain(`${"a".repeat(DECIDER_PROMPT_LIMIT)}\n[truncated]`)
    expect(prompt).not.toContain("a".repeat(DECIDER_PROMPT_LIMIT + 1))
    expect(prompt).toContain("Spawn description: (none)")
  })
})

describe("parseDecision", () => {
  const allowed = ["smol", "task"]
  test("reads bare and fenced JSON", () => {
    expect(parseDecision('{"role": "smol", "confident": true}', allowed)).toEqual({ role: "smol", confident: true })
    expect(parseDecision('```json\n{"role": "task", "confident": false}\n```', allowed)).toEqual({ role: "task", confident: false })
    expect(parseDecision('Sure: {"role": " smol ", "confident": true} done', allowed)).toEqual({ role: "smol", confident: true })
  })

  test("rejects anything else", () => {
    expect(parseDecision("smol", allowed)).toBeUndefined()
    expect(parseDecision('{"role": "slow", "confident": true}', allowed)).toBeUndefined()
    expect(parseDecision('{"role": "smol"}', allowed)).toBeUndefined()
    expect(parseDecision('{"role": "smol", "confident": "yes"}', allowed)).toBeUndefined()
    expect(parseDecision("{not json}", allowed)).toBeUndefined()
  })
})

describe("pickRole", () => {
  test("takes a confident decision, else the default with a reason", () => {
    const auto = { default: "task" }
    expect(pickRole({ role: "smol", confident: true }, auto)).toEqual({ role: "smol", reason: "confident" })
    expect(pickRole({ role: "smol", confident: false }, auto)).toEqual({ role: "task", reason: "unsure" })
    expect(pickRole(undefined, auto)).toEqual({ role: "task", reason: "invalid" })
    expect(pickRole({ role: "smol", confident: true }, auto, "timeout")).toEqual({ role: "task", reason: "timeout" })
  })
})

describe("capRole", () => {
  const costs = [
    { role: "smol", cost: 0.8 },
    { role: "task", cost: 3 },
    { role: "slow", cost: 5 },
  ]
  test("steps down to the dearest role at or under the parent's cost", () => {
    expect(capRole("slow", costs, 3)).toBe("task")
    expect(capRole("slow", costs, 1)).toBe("smol")
    expect(capRole("task", costs, 3)).toBe("task")
    expect(capRole("smol", costs, 0.1)).toBe("smol")
    expect(capRole("slow", costs, 0.1)).toBe("smol")
  })

  test("leaves the role alone when a cost is unknown", () => {
    expect(capRole("slow", costs, undefined)).toBe("slow")
    expect(capRole("other", costs, 1)).toBe("other")
    expect(capRole("slow", [{ role: "slow", cost: 5 }, { role: "x", cost: undefined }], 1)).toBe("slow")
  })

  test("roleCosts reads each role's resolved model", () => {
    expect(roleCosts(["smol", "slow", "nope"], options, available)).toEqual([
      { role: "smol", cost: 0.8 },
      { role: "slow", cost: 5 },
      { role: "nope", cost: undefined },
    ])
  })
})

describe("history and tags", () => {
  const record: AutoRecord = { at: 0, agent: "general", role: "smol", reason: "confident", model: { providerID: "a", id: "b" }, ms: 12 }
  test("tags the spawn description", () => {
    expect(withAutoTag("find parser", record)).toBe("find parser [auto: smol, confident]")
    expect(withAutoTag(undefined, { ...record, capped: "slow" })).toBe("[auto: smol, capped from slow]")
  })

  test("keeps the newest records", () => {
    let history: AutoRecord[] = []
    for (let i = 0; i < AUTO_HISTORY_LIMIT + 3; i++) history = pushHistory(history, { ...record, at: i })
    expect(history).toHaveLength(AUTO_HISTORY_LIMIT)
    expect(history[0]?.at).toBe(AUTO_HISTORY_LIMIT + 2)
  })

  test("formats for the check tool", () => {
    expect(formatHistory([])).toEqual([])
    expect(formatHistory([{ ...record, capped: "slow" }])).toEqual([
      "",
      "Recent auto routing (newest first):",
      "  - 1970-01-01T00:00:00.000Z general → smol (a/b; confident, capped from slow; 12 ms)",
    ])
  })
})
