import { describe, expect, test } from "bun:test"
import {
  type AgentLike,
  type AvailableModel,
  desiredModels,
  isAvailable,
  parseCandidate,
  parseOptions,
  resolveRole,
  roleOf,
  sameModel,
  staleAgents,
  stripRoleHeader,
  userPin,
} from "./resolve.ts"

const available: AvailableModel[] = [
  { providerID: "amazon-bedrock", id: "claude-sonnet", variants: [{ id: "high" }, { id: "low" }] },
  { providerID: "anthropic", id: "claude-haiku", variants: [] },
  { providerID: "opencode", id: "flint", variants: [{ id: "low" }] },
  { providerID: "openai", id: "gpt-off", variants: [], enabled: false },
  { providerID: "openrouter", id: "anthropic/claude", variants: [] },
]

describe("parseCandidate", () => {
  test("provider/model", () => {
    expect(parseCandidate("anthropic/claude-haiku")).toEqual({
      kind: "model",
      ref: { providerID: "anthropic", id: "claude-haiku" },
    })
  })
  test("provider/model#variant", () => {
    expect(parseCandidate(" amazon-bedrock/claude-sonnet#high ")).toEqual({
      kind: "model",
      ref: { providerID: "amazon-bedrock", id: "claude-sonnet", variant: "high" },
    })
  })
  test("model ids may contain slashes and colons", () => {
    expect(parseCandidate("openrouter/anthropic/claude")).toEqual({
      kind: "model",
      ref: { providerID: "openrouter", id: "anthropic/claude" },
    })
    expect(parseCandidate("ollama/qwen3:8b#low")).toEqual({
      kind: "model",
      ref: { providerID: "ollama", id: "qwen3:8b", variant: "low" },
    })
  })
  test("@role", () => {
    expect(parseCandidate("@task")).toEqual({ kind: "role", role: "task" })
  })
  test("rejects malformed input", () => {
    for (const bad of ["", "@", "noslash", "/model", "provider/", "provider/model#", "provider/#high"]) {
      expect(parseCandidate(bad)).toBeUndefined()
    }
  })
})

describe("parseOptions", () => {
  test("accepts strings and arrays, drops junk", () => {
    expect(
      parseOptions({
        roles: { a: "x/y", b: ["x/y", 3, "", "@a"], c: 5 },
        agents: { general: "a", bad: 1, empty: " " },
        fallback: "something-else",
      }),
    ).toEqual({ roles: { a: ["x/y"], b: ["x/y", "@a"], c: [] }, agents: { general: "a" }, fallback: "keep" })
  })
  test("missing or invalid options give an empty mapping", () => {
    const empty = { roles: {}, agents: {}, fallback: "keep" as const }
    expect(parseOptions(undefined)).toEqual(empty)
    expect(parseOptions({ roles: [], agents: "x" })).toEqual(empty)
  })
})

describe("isAvailable", () => {
  test("present model without variant", () => {
    expect(isAvailable({ providerID: "anthropic", id: "claude-haiku" }, available)).toBe(true)
  })
  test("present model with existing variant", () => {
    expect(isAvailable({ providerID: "amazon-bedrock", id: "claude-sonnet", variant: "high" }, available)).toBe(true)
  })
  test("missing variant", () => {
    expect(isAvailable({ providerID: "amazon-bedrock", id: "claude-sonnet", variant: "max" }, available)).toBe(false)
  })
  test("unknown provider", () => {
    expect(isAvailable({ providerID: "nope-provider", id: "claude-sonnet" }, available)).toBe(false)
  })
  test("unknown model on a known provider", () => {
    expect(isAvailable({ providerID: "anthropic", id: "claude-opus" }, available)).toBe(false)
  })
  test("disabled model", () => {
    expect(isAvailable({ providerID: "openai", id: "gpt-off" }, available)).toBe(false)
  })
  test("model without a variants list", () => {
    expect(isAvailable({ providerID: "p", id: "m", variant: "v" }, [{ providerID: "p", id: "m" }])).toBe(false)
    expect(isAvailable({ providerID: "p", id: "m" }, [{ providerID: "p", id: "m" }])).toBe(true)
  })
})

describe("resolveRole", () => {
  test("first available candidate wins", () => {
    const roles = { task: ["amazon-bedrock/claude-sonnet#high", "anthropic/claude-haiku"] }
    expect(resolveRole(roles, available, "task")).toEqual({
      model: { providerID: "amazon-bedrock", id: "claude-sonnet", variant: "high" },
      via: ["task"],
    })
  })
  test("skips unavailable providers, models and variants", () => {
    const roles = {
      task: ["nope-provider/x", "anthropic/claude-opus", "amazon-bedrock/claude-sonnet#max", "openai/gpt-off", "opencode/flint#low"],
    }
    expect(resolveRole(roles, available, "task").model).toEqual({ providerID: "opencode", id: "flint", variant: "low" })
  })
  test("skips malformed candidates", () => {
    expect(resolveRole({ task: ["garbage", "anthropic/claude-haiku"] }, available, "task").model).toEqual({
      providerID: "anthropic",
      id: "claude-haiku",
    })
  })
  test("unknown role", () => {
    expect(resolveRole({ task: ["anthropic/claude-haiku"] }, available, "nope")).toEqual({
      model: undefined,
      reason: "unknown-role",
    })
  })
  test("does not treat prototype keys as roles", () => {
    expect(resolveRole({}, available, "constructor")).toEqual({ model: undefined, reason: "unknown-role" })
  })
  test("nothing available", () => {
    expect(resolveRole({ task: ["nope-provider/x"] }, available, "task")).toEqual({
      model: undefined,
      reason: "unavailable",
    })
  })
  test("empty role", () => {
    expect(resolveRole({ task: [] }, available, "task")).toEqual({ model: undefined, reason: "unavailable" })
  })
  test("@role chains in order", () => {
    const roles = {
      smol: ["anthropic/claude-haiku"],
      slow: ["nope-provider/x", "@smol", "opencode/flint"],
    }
    expect(resolveRole(roles, available, "slow")).toEqual({
      model: { providerID: "anthropic", id: "claude-haiku" },
      via: ["slow", "smol"],
    })
  })
  test("falls through a chained role with nothing available", () => {
    const roles = { smol: ["nope-provider/x"], slow: ["@smol", "opencode/flint"] }
    expect(resolveRole(roles, available, "slow").model).toEqual({ providerID: "opencode", id: "flint" })
  })
  test("multi-level chains", () => {
    const roles = { a: ["@b"], b: ["@c"], c: ["anthropic/claude-haiku"] }
    expect(resolveRole(roles, available, "a")).toEqual({
      model: { providerID: "anthropic", id: "claude-haiku" },
      via: ["a", "b", "c"],
    })
  })
  test("self reference is skipped", () => {
    const roles = { a: ["@a", "anthropic/claude-haiku"] }
    expect(resolveRole(roles, available, "a").model).toEqual({ providerID: "anthropic", id: "claude-haiku" })
  })
  test("cycles terminate and fall through", () => {
    const roles = { a: ["@b", "opencode/flint"], b: ["@a", "nope-provider/x"] }
    expect(resolveRole(roles, available, "a").model).toEqual({ providerID: "opencode", id: "flint" })
    expect(resolveRole(roles, available, "b").model).toEqual({ providerID: "opencode", id: "flint" })
  })
  test("pure cycle resolves to nothing", () => {
    expect(resolveRole({ a: ["@b"], b: ["@a"] }, available, "a")).toEqual({ model: undefined, reason: "unavailable" })
  })
  test("chain to an unknown role is skipped", () => {
    expect(resolveRole({ a: ["@missing", "opencode/flint"] }, available, "a").model).toEqual({
      providerID: "opencode",
      id: "flint",
    })
  })
  test("diamond chains are allowed", () => {
    const roles = { top: ["@left", "@right"], left: ["@base"], right: ["@base"], base: ["opencode/flint"] }
    expect(resolveRole(roles, available, "top")).toMatchObject({ via: ["top", "left", "base"] })
  })
})

describe("roleOf", () => {
  const header = (role: string) => ({ headers: { "x-opencode-model-role": role } })
  test("options mapping wins over the header", () => {
    expect(roleOf({ id: "general", request: header("smol") }, { general: "task" })).toBe("task")
  })
  test("header when not mapped", () => {
    expect(roleOf({ id: "reviewer", request: header(" review ") }, {})).toBe("review")
  })
  test("header name is case-insensitive", () => {
    expect(roleOf({ id: "r", request: { headers: { "X-OpenCode-Model-Role": "task" } } }, {})).toBe("task")
  })
  test("no role", () => {
    expect(roleOf({ id: "build" }, { general: "task" })).toBeUndefined()
    expect(roleOf({ id: "build", request: header("") }, {})).toBeUndefined()
    expect(roleOf({ id: "build", request: {} }, {})).toBeUndefined()
  })
})

describe("desiredModels (failure matrix)", () => {
  const options = parseOptions({
    roles: {
      task: ["amazon-bedrock/claude-sonnet#high", "anthropic/claude-haiku"],
      smol: ["anthropic/claude-haiku"],
      "fake-only": ["nope-provider/some-model"],
    },
    agents: { general: "task", explore: "smol", ghost: "task" },
  })
  const agents: AgentLike[] = [
    { id: "general" },
    { id: "explore", model: { providerID: "opencode", id: "flint" }, request: { headers: { "x-opencode-model-fallback": "opencode/flint" } } },
    { id: "explicit-and-role", model: { providerID: "opencode", id: "flint" }, request: { headers: { "x-opencode-model-role": "task" } } },
    {
      id: "fallback-and-role",
      model: { providerID: "opencode", id: "flint" },
      request: { headers: { "x-opencode-model-role": "task", "X-OpenCode-Model-Fallback": "opencode/flint" } },
    },
    {
      id: "repinned",
      model: { providerID: "anthropic", id: "claude-haiku" },
      request: { headers: { "x-opencode-model-role": "task", "x-opencode-model-fallback": "opencode/flint" } },
    },
    { id: "role-only", request: { headers: { "x-opencode-model-role": "smol" } } },
    { id: "unknown-role", model: { providerID: "opencode", id: "flint" }, request: { headers: { "x-opencode-model-role": "nope" } } },
    { id: "unavailable-role", model: { providerID: "opencode", id: "flint" }, request: { headers: { "x-opencode-model-role": "fake-only" } } },
    { id: "unavailable-role-no-model", request: { headers: { "x-opencode-model-role": "fake-only" } } },
    { id: "no-role", model: { providerID: "opencode", id: "flint" } },
  ]
  const desired = desiredModels(agents, options, available)
  const sonnet = { providerID: "amazon-bedrock", id: "claude-sonnet", variant: "high" }
  const haiku = { providerID: "anthropic", id: "claude-haiku" }

  test("builtin mapped via options gets its role model", () => {
    expect(desired.get("general")).toEqual(sonnet)
    expect(desired.get("explore")).toEqual(haiku)
  })
  test("a user's model pin wins over the role", () => {
    expect(desired.has("explicit-and-role")).toBe(false)
    expect(desired.has("repinned")).toBe(false)
  })
  test("a model the fallback header marks gives way to the role", () => {
    expect(desired.get("fallback-and-role")).toEqual(sonnet)
  })
  test("role-only agent gets a model", () => {
    expect(desired.get("role-only")).toEqual(haiku)
  })
  test("unknown role keeps the agent's model", () => {
    expect(desired.has("unknown-role")).toBe(false)
  })
  test("never sets an unavailable model", () => {
    expect(desired.has("unavailable-role")).toBe(false)
    expect(desired.has("unavailable-role-no-model")).toBe(false)
  })
  test("agents without a role are untouched", () => {
    expect(desired.has("no-role")).toBe(false)
  })
  test("mapped agents that do not exist are not created", () => {
    expect(desired.has("ghost")).toBe(false)
  })
  test("no models available keeps everything", () => {
    expect(desiredModels(agents, options, []).size).toBe(0)
  })
})

describe("sameModel", () => {
  test("ignores key order", () => {
    expect(sameModel({ providerID: "a", id: "b" }, { id: "b", providerID: "a" } as never)).toBe(true)
  })
  test("absent and undefined variant are equal", () => {
    expect(sameModel({ providerID: "a", id: "b" }, { providerID: "a", id: "b", variant: undefined })).toBe(true)
  })
  test("differs on any field", () => {
    expect(sameModel({ providerID: "a", id: "b" }, { providerID: "a", id: "c" })).toBe(false)
    expect(sameModel({ providerID: "a", id: "b" }, { providerID: "x", id: "b" })).toBe(false)
    expect(sameModel({ providerID: "a", id: "b", variant: "high" }, { providerID: "a", id: "b" })).toBe(false)
  })
  test("undefined handling", () => {
    expect(sameModel(undefined, undefined)).toBe(true)
    expect(sameModel(undefined, { providerID: "a", id: "b" })).toBe(false)
  })
})

describe("staleAgents", () => {
  test("lists only agents whose model differs from the desired one", () => {
    const desired = new Map([
      ["a", { providerID: "p", id: "m" }],
      ["b", { providerID: "p", id: "m" }],
      ["c", { providerID: "p", id: "m" }],
    ])
    const agents = [
      { id: "a", model: { id: "m", providerID: "p" } },
      { id: "b", model: { providerID: "p", id: "other" } },
      { id: "c" },
      { id: "d", model: { providerID: "x", id: "y" } },
    ]
    expect(staleAgents(agents, desired)).toEqual(["b", "c"])
  })
})

describe("userPin", () => {
  const flint = { providerID: "opencode", id: "flint" }
  const marked = (value: string) => ({ headers: { "x-opencode-model-fallback": value } })
  test("an unmarked model is a pin; a marked one is not", () => {
    expect(userPin({ id: "a", model: flint })).toEqual(flint)
    expect(userPin({ id: "a", model: flint, request: marked("opencode/flint") })).toBeUndefined()
    expect(userPin({ id: "a" })).toBeUndefined()
  })
  test("a model other than the marked one is a pin", () => {
    expect(userPin({ id: "a", model: flint, request: marked("opencode/flint#high") })).toEqual(flint)
    expect(userPin({ id: "a", model: flint, request: marked("not a model") })).toEqual(flint)
  })
})

describe("stripRoleHeader", () => {
  test("removes every casing and keeps other headers", () => {
    const headers: Record<string, string> = {
      "x-opencode-model-role": "a",
      "X-OpenCode-Model-Role": "b",
      "x-opencode-model-fallback": "p/m",
      authorization: "x",
    }
    expect(stripRoleHeader(headers)).toBe(true)
    expect(headers).toEqual({ authorization: "x" })
  })
  test("no-op when absent", () => {
    const headers = { a: "b" }
    expect(stripRoleHeader(headers)).toBe(false)
    expect(headers).toEqual({ a: "b" })
  })
})
