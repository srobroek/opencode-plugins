import { describe, expect, test } from "bun:test"
import {
  classifyFailure,
  healthView,
  markUnhealthy,
  mayRetry,
  modelFromError,
  nextExpiry,
  pruneHealth,
  readHealth,
} from "./health.ts"
import { parseOptions, resolveRole } from "./resolve.ts"

describe("classifyFailure", () => {
  test("provider and model failures", () => {
    expect(classifyFailure({ type: "unknown", message: "Model unavailable: nope/x" })).toBe("unavailable")
    expect(classifyFailure({ message: "Subagent failed (ses_1): Model unavailable: nope/x" })).toBe("unavailable")
    expect(classifyFailure({ type: "api", message: "nope", status: 401 })).toBe("auth")
    expect(classifyFailure({ message: "The security token included in the request is expired" })).toBe("auth")
    expect(classifyFailure({ message: "Could not load credentials from any providers" })).toBe("auth")
    expect(classifyFailure({ type: "api", message: "slow down", status: 429 })).toBe("rate-limit")
    expect(classifyFailure({ message: "ThrottlingException: Too many requests" })).toBe("rate-limit")
    expect(classifyFailure({ message: "Overloaded" })).toBe("server")
    expect(classifyFailure({ type: "api", message: "oops", status: 503 })).toBe("server")
  })

  test("not the model's fault", () => {
    expect(classifyFailure(undefined)).toBeUndefined()
    expect(classifyFailure({ type: "tool", message: "Model unavailable: a/b" })).toBeUndefined()
    expect(classifyFailure({ type: "aborted", message: "aborted by user" })).toBeUndefined()
    expect(classifyFailure({ message: "The operation was cancelled" })).toBeUndefined()
    expect(classifyFailure({ message: "prompt is too long: 250000 tokens", status: 400 })).toBeUndefined()
    expect(classifyFailure({ message: "file not found: src/x.ts" })).toBeUndefined()
    expect(classifyFailure({ message: "bad request", status: 400 })).toBeUndefined()
  })
})

describe("modelFromError", () => {
  test("reads the model from a Model unavailable message", () => {
    expect(modelFromError("Subagent failed (x): Model unavailable: nope-provider/some-model")).toEqual({
      providerID: "nope-provider",
      id: "some-model",
    })
    expect(modelFromError("Model unavailable: a/b#high.")).toEqual({ providerID: "a", id: "b", variant: "high" })
    expect(modelFromError("rate limited")).toBeUndefined()
  })
})

describe("health state", () => {
  const a = { providerID: "p", id: "a" }
  test("marks, views, prunes and expires", () => {
    const state = markUnhealthy({}, a, 1_000, 500, "auth: x")
    expect(state).toEqual({ "p/a": { failedAt: 1_000, until: 1_500, reason: "auth: x" } })
    expect(healthView(state, 1_200)({ ...a, variant: "high" })).toBe(1_000)
    expect(healthView(state, 1_500)(a)).toBeUndefined()
    expect(nextExpiry(state, 1_200)).toBe(1_500)
    expect(nextExpiry(state, 1_600)).toBeUndefined()
    expect(pruneHealth(state, 1_600)).toEqual({})
    expect(markUnhealthy(state, { providerID: "p", id: "b" }, 2_000, 10, "r")).toEqual({
      "p/b": { failedAt: 2_000, until: 2_010, reason: "r" },
    })
  })

  test("readHealth drops junk", () => {
    expect(readHealth({ x: { failedAt: 1, until: 2 }, y: { failedAt: "1" }, z: 3 })).toEqual({
      x: { failedAt: 1, until: 2, reason: "" },
    })
    expect(readHealth([1])).toEqual({})
  })

  test("mayRetry allows one retry per window", () => {
    expect(mayRetry(undefined, 1_000, 500)).toBe(true)
    expect(mayRetry(800, 1_000, 500)).toBe(false)
    expect(mayRetry(400, 1_000, 500)).toBe(true)
  })
})

describe("resolveRole with health", () => {
  const available = [
    { providerID: "p", id: "a" },
    { providerID: "p", id: "b" },
    { providerID: "p", id: "c" },
  ]
  const { roles } = parseOptions({ roles: { r: ["p/a", "@s"], s: ["p/b", "p/c"] } })

  test("skips unhealthy candidates, following links", () => {
    const state = markUnhealthy({}, { providerID: "p", id: "a" }, 0, 1_000, "x")
    expect(resolveRole(roles, available, "r", healthView(state, 10)).model).toEqual({ providerID: "p", id: "b" })
  })

  test("all unhealthy: the least recently failed wins and is flagged", () => {
    let state = markUnhealthy({}, { providerID: "p", id: "a" }, 30, 1_000, "x")
    state = { ...state, ...markUnhealthy({}, { providerID: "p", id: "b" }, 10, 1_000, "x") }
    state = { ...state, ...markUnhealthy({}, { providerID: "p", id: "c" }, 20, 1_000, "x") }
    const resolution = resolveRole(roles, available, "r", healthView(state, 40))
    expect(resolution).toEqual({ model: { providerID: "p", id: "b" }, via: ["r", "s"], unhealthy: true })
  })
})
