import { describe, expect, test } from "bun:test"
import { healthView, markUnhealthy } from "./health.ts"
import { parseOptions } from "./resolve.ts"
import {
  cheapestCost,
  costTier,
  inputModel,
  parseRuntime,
  planSpawn,
  ROLE_ALIAS_DESCRIPTION,
  ROLE_TOOL_NOTE,
  roleChoices,
  roleParamDescription,
  toJsonSchema,
  withRoleNote,
  withRoleParam,
} from "./spawn-role.ts"

const haiku = { providerID: "anthropic", id: "claude-haiku" }
const sonnet = { providerID: "amazon-bedrock", id: "claude-sonnet" }
const available = [
  { ...haiku, cost: [{ input: 0.8 }] },
  { ...sonnet, variants: [{ id: "high" }], cost: [{ input: 3 }] },
  { providerID: "off", id: "m", enabled: false, cost: [{ input: 0.01 }] },
]
const options = parseOptions({
  roles: {
    smol: ["off/m", "anthropic/claude-haiku"],
    task: ["amazon-bedrock/claude-sonnet#high", "@smol"],
    custom: "amazon-bedrock/claude-sonnet",
    ghost: "nope/x",
  },
})

/** The built-in `subagent` input as its Effect struct AST looks at runtime (OpenCode 2.1.4). */
const effectInput = {
  fields: {},
  mapFields: () => undefined,
  ast: {
    _tag: "Objects",
    indexSignatures: [],
    propertySignatures: [
      { name: "agent", type: { _tag: "String", annotations: { description: "The agent" } } },
      { name: "prompt", type: { _tag: "String" } },
      { name: "model", type: { _tag: "String", annotations: { description: "NEVER set" }, context: { isOptional: true } } },
      {
        name: "sessionID",
        type: {
          _tag: "String",
          context: { isOptional: true },
          checks: [
            {
              _tag: "Filter",
              annotations: {
                description: "Continue a session",
                representation: { id: "effect/schema/isStartingWith", payload: { startsWith: "ses" } },
              },
            },
          ],
        },
      },
      { name: "background", type: { _tag: "Boolean", context: { isOptional: true } } },
    ],
  },
}

describe("runtime options", () => {
  test("defaults, and purposes only for configured roles", () => {
    expect(parseRuntime({}, options)).toEqual({
      cooldownMs: 600_000,
      quotaCooldownMs: 21_600_000,
      hostRetries: 2,
      switchTimeoutMs: 2_000,
      purposes: {},
    })
    const raw = { cooldownMs: 5, quotaCooldownMs: 7, hostRetries: 0, switchTimeoutMs: 9, purposes: { custom: " mine ", nope: "x", task: 3 } }
    expect(parseRuntime(raw, options)).toEqual({
      cooldownMs: 5,
      quotaCooldownMs: 7,
      hostRetries: 0,
      switchTimeoutMs: 9,
      purposes: { custom: "mine" },
    })
    expect(parseRuntime({ hostRetries: 1.5, switchTimeoutMs: 0 }, options)).toMatchObject({ hostRetries: 2, switchTimeoutMs: 2_000 })
  })
})

describe("role choices", () => {
  test("cost tier comes from the cheapest available candidate, through links", () => {
    expect(costTier(0.11)).toBe("low cost, $0.11/M input tokens")
    expect(costTier(4.4)).toBe("high cost, $4.4/M input tokens")
    expect(cheapestCost(options.roles, available, "smol")).toBe(0.8)
    expect(cheapestCost(options.roles, available, "task")).toBe(0.8)
    expect(cheapestCost(options.roles, available, "ghost")).toBeUndefined()
  })

  test("every configured role, with purpose and tier", () => {
    const choices = roleChoices(options, available, { custom: "my purpose" })
    expect(choices.map((c) => c.role)).toEqual(["custom", "ghost", "smol", "task"])
    const text = roleParamDescription(choices)
    expect(text).toContain("- 'custom': my purpose (medium cost, $3/M input tokens)")
    expect(text).toContain("- 'smol': cheap and fast")
    expect(text).toContain("(low cost, $0.8/M input tokens)")
    expect(text).toContain("- 'ghost': work that suits the 'ghost' model role (no model available now")
  })
})

describe("subagent schema", () => {
  test("reads the built-in Effect struct as JSON Schema", () => {
    expect(toJsonSchema(effectInput)).toEqual({
      type: "object",
      properties: {
        agent: { type: "string", description: "The agent" },
        prompt: { type: "string" },
        model: { type: "string", description: "NEVER set" },
        sessionID: { type: "string", pattern: "^ses", description: "Continue a session" },
        background: { type: "boolean" },
      },
      required: ["agent", "prompt"],
      additionalProperties: false,
    })
  })

  test("gives up on shapes it cannot express", () => {
    const signatures = [...effectInput.ast.propertySignatures, { name: "x", type: { _tag: "Union" } }]
    const unknown = { ...effectInput, ast: { ...effectInput.ast, propertySignatures: signatures } }
    expect(toJsonSchema(unknown)).toBeUndefined()
    expect(toJsonSchema({ fields: {} })).toBeUndefined()
    expect(toJsonSchema(undefined)).toBeUndefined()
  })

  test("adds an optional tier enum and a free-form role alias, idempotently", () => {
    const schema = toJsonSchema(effectInput)
    if (schema === undefined) throw new Error("no schema")
    const once = withRoleParam(schema, ["cheap", "standard"], "pick one")
    expect(once.properties.tier).toEqual({ type: "string", enum: ["cheap", "standard"], description: "pick one" })
    expect(once.properties.role).toEqual({ type: "string", description: ROLE_ALIAS_DESCRIPTION })
    expect(once.required).toEqual(["agent", "prompt"])
    const again = withRoleParam(toJsonSchema(once) as typeof once, ["cheap"], "again")
    expect(again.properties.tier?.enum).toEqual(["cheap"])
    expect(schema.properties.role).toBeUndefined()
    expect(withRoleNote(withRoleNote("Spawns."))).toBe(`Spawns.\n${ROLE_TOOL_NOTE}`)
  })
})

describe("planSpawn", () => {
  const spawn = { agent: "general", description: "d", prompt: "p" }

  test("a role sets the model it resolves to and is removed", () => {
    expect(planSpawn({ ...spawn, role: "task" }, options, available)).toEqual({
      input: { ...spawn, model: "amazon-bedrock/claude-sonnet#high" },
      role: "task",
      model: { ...sonnet, variant: "high" },
    })
  })

  test("the role re-resolves around unhealthy models", () => {
    const health = healthView(markUnhealthy({}, sonnet, 0, 1_000, "x"), 1)
    expect(planSpawn({ ...spawn, role: "task" }, options, available, health).input).toEqual({
      ...spawn,
      model: "anthropic/claude-haiku",
    })
  })

  test("an explicit model wins over the role", () => {
    const input = { ...spawn, role: "smol", model: "amazon-bedrock/claude-sonnet" }
    expect(planSpawn(input, options, available)).toEqual({ input: { ...spawn, model: "amazon-bedrock/claude-sonnet" } })
  })

  test("a user pin on the target wins over the role, which is still checked", () => {
    expect(planSpawn({ ...spawn, tier: "task" }, options, available, undefined, undefined, true)).toEqual({ input: spawn })
    expect(planSpawn({ ...spawn, tier: "huge" }, options, available, undefined, undefined, true).error).toContain("Unknown model tier")
  })

  test("a resumed spawn keeps its model", () => {
    expect(planSpawn({ ...spawn, role: "smol", sessionID: "ses_1" }, options, available)).toEqual({
      input: { ...spawn, sessionID: "ses_1" },
    })
  })

  test("no role leaves the input untouched; an empty one is dropped", () => {
    const input = { ...spawn }
    expect(planSpawn(input, options, available).input).toBe(input)
    expect(planSpawn({ ...spawn, role: " " }, options, available)).toEqual({ input: spawn })
    expect(planSpawn(null, options, available)).toEqual({ input: null })
  })

  test("a role with nothing available falls through to the agent", () => {
    expect(planSpawn({ ...spawn, role: "ghost" }, options, available)).toEqual({ input: spawn, role: "ghost" })
  })

  test("an unknown role is an error naming the configured ones", () => {
    expect(planSpawn({ ...spawn, role: "huge" }, options, available).error).toBe(
      "Unknown model tier 'huge'. Pass one of: custom, ghost, smol, task.",
    )
  })

  test("inputModel reads the model argument", () => {
    expect(inputModel({ model: "a/b#c" })).toEqual({ providerID: "a", id: "b", variant: "c" })
    expect(inputModel({ model: "@smol" })).toBeUndefined()
    expect(inputModel({})).toBeUndefined()
  })
})
