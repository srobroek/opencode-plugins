import { describe, expect, test } from "bun:test"
import {
  cheaperAlternatives,
  type GuardFacts,
  type GuardModel,
  inputCost,
  isExpensive,
  judgeModelOverride,
  judgeSpawn,
  parseGuard,
  summarize,
} from "./guard.ts"
import { parseOptions } from "./resolve.ts"

const opus = { providerID: "amazon-bedrock", id: "global.anthropic.claude-opus-5-5" }
const sonnet = { providerID: "amazon-bedrock", id: "global.anthropic.claude-sonnet-5-5" }
const haiku = { providerID: "anthropic", id: "claude-haiku" }
const available: GuardModel[] = [
  { ...opus, cost: [{ input: 4.4 }] },
  { ...sonnet, variants: [{ id: "high" }], cost: [{ input: 2 }] },
  { ...haiku, cost: [{ tier: { type: "context", size: 100_000 }, input: 0.55 }, { input: 0.11 }] },
]
const options = parseOptions({ roles: { task: "amazon-bedrock/global.anthropic.claude-sonnet-5-5", slow: "amazon-bedrock/global.anthropic.claude-opus-5-5" } })

const facts = (overrides: Partial<GuardFacts> = {}): GuardFacts => ({
  guard: parseGuard(true) as NonNullable<ReturnType<typeof parseGuard>>,
  options,
  target: "general",
  agents: [
    { id: "general", mode: "subagent" },
    { id: "explore", mode: "subagent", model: haiku, description: "Read-only search\nmore" },
    { id: "build", mode: "primary", model: haiku },
    { id: "secret", mode: "subagent", hidden: true, model: haiku },
    { id: "deep", mode: "subagent", model: opus },
  ],
  available,
  sessionModel: opus,
  ...overrides,
})

describe("parseGuard", () => {
  test("off unless configured", () => {
    expect(parseGuard(undefined)).toBeUndefined()
    expect(parseGuard(false)).toBeUndefined()
    expect(parseGuard({ enabled: false })).toBeUndefined()
  })

  test("true and {} mean auto with the default threshold", () => {
    expect(parseGuard(true)).toEqual({ expensive: "auto", threshold: 4, allowInherit: [], allowModels: [], mode: "refuse" })
    expect(parseGuard({})).toEqual({ expensive: "auto", threshold: 4, allowInherit: [], allowModels: [], mode: "refuse" })
  })

  test("reads a list, a threshold and allowInherit, dropping junk", () => {
    expect(
      parseGuard({ expensive: ["a/b", 3, " "], threshold: 10, allowInherit: ["x", 1], allowModels: ["c/d", null] }),
    ).toEqual({ expensive: ["a/b"], threshold: 10, allowInherit: ["x"], allowModels: ["c/d"], mode: "refuse" })
    expect(parseGuard({ expensive: "a/b", threshold: -1 })?.expensive).toEqual(["a/b"])
    expect(parseGuard({ mode: "auto" })?.mode).toBe("auto")
    expect(parseGuard({ mode: "other" })?.mode).toBe("refuse")
    expect(parseGuard({ threshold: -1 })?.threshold).toBe(4)
  })
})

describe("isExpensive", () => {
  test("auto compares the base-tier input cost", () => {
    const guard = parseGuard(true) as NonNullable<ReturnType<typeof parseGuard>>
    expect(inputCost(haiku, available)).toBe(0.11)
    expect(isExpensive(opus, guard, available)).toBe(true)
    expect(isExpensive(sonnet, guard, available)).toBe(false)
    expect(isExpensive({ providerID: "x", id: "unknown" }, guard, available)).toBe(false)
  })

  test("a list matches provider/model, and a listed variant only that variant", () => {
    const guard = parseGuard({ expensive: ["amazon-bedrock/global.anthropic.claude-sonnet-5-5#high"] }) as NonNullable<
      ReturnType<typeof parseGuard>
    >
    expect(isExpensive({ ...sonnet, variant: "high" }, guard, available)).toBe(true)
    expect(isExpensive(sonnet, guard, available)).toBe(false)
    expect(isExpensive(opus, guard, available)).toBe(false)
    const any = parseGuard({ expensive: ["amazon-bedrock/global.anthropic.claude-opus-5-5"] }) as NonNullable<
      ReturnType<typeof parseGuard>
    >
    expect(isExpensive({ ...opus, variant: "max" }, any, available)).toBe(true)
  })
})

describe("judgeSpawn", () => {
  test("denies an inheriting agent under an expensive session model and names cheaper options", () => {
    const decision = judgeSpawn(facts())
    expect(decision.allow).toBe(false)
    if (decision.allow) return
    expect(decision.reason).toContain("inherit this session's expensive model amazon-bedrock/global.anthropic.claude-opus-5-5")
    expect(decision.reason).toContain("Or spawn an agent that pins a cheaper model: explore (anthropic/claude-haiku)\n")
    expect(decision.reason).toContain('role: "task" (runs amazon-bedrock/global.anthropic.claude-sonnet-5-5, $2/M input tokens)')
    expect(decision.reason).not.toContain("slow")
    expect(decision.reason).not.toContain("build")
    expect(decision.reason).not.toContain("secret")
    expect(decision.reason).not.toContain("deep (")
    expect(decision.reason).toContain("guard.allowInherit")
  })

  test("allows an explicit model, even an expensive one", () => {
    expect(judgeSpawn(facts({ target: "deep" })).allow).toBe(true)
    expect(judgeSpawn(facts({ target: "explore" })).allow).toBe(true)
  })

  test("allows an agent whose role resolves, by option or header", () => {
    expect(judgeSpawn(facts({ options: { ...options, agents: { general: "task" } } })).allow).toBe(true)
    const agents = [{ id: "general", request: { headers: { "X-OpenCode-Model-Role": "task" } } }]
    expect(judgeSpawn(facts({ agents })).allow).toBe(true)
  })

  test("denies when the role cannot resolve", () => {
    const decision = judgeSpawn(facts({ options: { ...options, agents: { general: "missing" } } }))
    expect(decision.allow).toBe(false)
  })

  test("allows a cheap session model, an unknown session model, an unknown agent and allowInherit", () => {
    expect(judgeSpawn(facts({ sessionModel: sonnet })).allow).toBe(true)
    expect(judgeSpawn(facts({ sessionModel: undefined })).allow).toBe(true)
    expect(judgeSpawn(facts({ target: "ghost" })).allow).toBe(true)
    const guard = parseGuard({ allowInherit: ["general"] }) as NonNullable<ReturnType<typeof parseGuard>>
    expect(judgeSpawn(facts({ guard })).allow).toBe(true)
  })

  test("asks for the cheapest fitting role first", () => {
    const roles = parseOptions({ roles: { ...options.roles, smol: "anthropic/claude-haiku" } })
    const decision = judgeSpawn(facts({ options: roles }))
    if (decision.allow) throw new Error("allowed")
    expect(decision.reason).toContain('Re-issue the spawn with role: "smol" (runs anthropic/claude-haiku, $0.11/M input tokens)')
    expect(decision.reason).toContain("Other cheaper roles: task → amazon-bedrock/global.anthropic.claude-sonnet-5-5 ($2/M input tokens)")
    expect(decision.reason).not.toContain("general-")
  })

  test("says so when no role is cheaper", () => {
    const decision = judgeSpawn(facts({ options: parseOptions({ roles: { slow: "amazon-bedrock/global.anthropic.claude-opus-5-5" } }) }))
    if (decision.allow) throw new Error("allowed")
    expect(decision.reason).toContain("No model role resolves to a cheaper model right now.")
    expect(decision.reason).toContain("Or spawn an agent that pins a cheaper model: explore (anthropic/claude-haiku: Read-only search)")
  })

  test("an explicit expensive model is refused unless a role, the agent or allowModels backs it", () => {
    const withSmol = parseOptions({ roles: { ...options.roles, smol: "anthropic/claude-haiku" } })
    const decision = judgeModelOverride({ ...facts({ options: withSmol }), model: opus })
    if (decision.allow) throw new Error("allowed")
    expect(decision.reason).toContain("This spawn sets model amazon-bedrock/global.anthropic.claude-opus-5-5 itself")
    expect(decision.reason).toContain('Drop `model` and pass role: "smol"')
    expect(decision.reason).toContain('pass role: "slow" instead; it resolves to that model')
    expect(decision.reason).toContain("guard.allowModels")
    expect(judgeModelOverride({ ...facts(), model: sonnet }).allow).toBe(true)
    expect(judgeModelOverride({ ...facts({ target: "deep" }), model: opus }).allow).toBe(true)
    const guard = parseGuard({ allowModels: ["amazon-bedrock/global.anthropic.claude-opus-5-5"] }) as NonNullable<
      ReturnType<typeof parseGuard>
    >
    expect(judgeModelOverride({ ...facts({ guard }), model: { ...opus, variant: "max" } }).allow).toBe(true)
  })

  test("alternatives are bounded and sorted", () => {
    const agents = Array.from({ length: 20 }, (_, i) => ({ id: `a${String(i).padStart(2, "0")}`, model: haiku }))
    const result = cheaperAlternatives(facts({ agents }))
    expect(result.agents).toHaveLength(12)
    expect(result.agents[0]).toEqual({ id: "a00", model: haiku })
    const decision = judgeSpawn(facts({ agents: [{ id: "general" }, ...agents] }))
    if (decision.allow) throw new Error("allowed")
    expect(decision.reason).toContain("a04 (anthropic/claude-haiku); 7 more")
    expect(decision.reason.split("\n")).toHaveLength(4)
  })

  test("summaries are the first sentence, capped", () => {
    expect(summarize("Read-only search. Use it for lookups.\nmore")).toBe("Read-only search")
    expect(summarize("v1.2 parser")).toBe("v1.2 parser")
    expect(summarize(`${"x".repeat(100)}`)).toBe(`${"x".repeat(77)}...`)
    expect(summarize("  \n")).toBeUndefined()
  })

  test("drops the host's #default variant from labels", () => {
    const decision = judgeSpawn(facts({ sessionModel: { ...opus, variant: "default" } }))
    if (decision.allow) throw new Error("allowed")
    expect(decision.reason).toContain("expensive model amazon-bedrock/global.anthropic.claude-opus-5-5.")
  })
})
