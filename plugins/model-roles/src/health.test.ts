import { describe, expect, test } from "bun:test"
import {
  childSessionID,
  classifyFailure,
  cooldownFor,
  failureScope,
  healthEntry,
  healthView,
  isTransient,
  markUnhealthy,
  modelFromError,
  nextExpiry,
  pruneHealth,
  quotaReset,
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
    // Bedrock, for a catalog id this region cannot serve.
    expect(
      classifyFailure({ type: "provider.invalid-request", message: "The provided model identifier is invalid.", status: 400 }),
    ).toBe("unavailable")
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

describe("failure classes and scope", () => {
  test("quota, content filter and outage", () => {
    expect(classifyFailure({ type: "api", message: "You exceeded your current quota", status: 429 })).toBe("quota")
    expect(classifyFailure({ message: "Weekly usage limit reached", status: 429 })).toBe("quota")
    expect(classifyFailure({ message: "Your credit balance is too low", status: 400 })).toBe("quota")
    expect(classifyFailure({ message: "nope", status: 402 })).toBe("quota")
    expect(classifyFailure({ message: "Output blocked by content filtering policy", status: 400 })).toBe("content-filter")
    expect(classifyFailure({ message: "fetch failed: ECONNREFUSED 127.0.0.1:1" })).toBe("outage")
    expect(classifyFailure({ message: "The SSO session associated with this profile has expired" })).toBe("auth")
  })

  test("provider-scoped and transient kinds", () => {
    expect(["auth", "quota", "outage"].map((k) => failureScope(k as never))).toEqual(["provider", "provider", "provider"])
    expect(["unavailable", "content-filter", "rate-limit", "server"].map((k) => failureScope(k as never))).toEqual([
      "model",
      "model",
      "model",
      "model",
    ])
    expect(isTransient("rate-limit")).toBe(true)
    expect(isTransient("quota")).toBe(false)
  })

  test("a provider entry covers every model of it", () => {
    const state = markUnhealthy({}, { providerID: "p", id: "a" }, 1_000, 500, "auth: x", "provider")
    expect(Object.keys(state)).toEqual(["p/*"])
    expect(healthView(state, 1_200)({ providerID: "p", id: "zzz" })).toBe(1_000)
    expect(healthView(state, 1_200)({ providerID: "q", id: "a" })).toBeUndefined()
    expect(healthEntry(state, { providerID: "p", id: "b" }, 1_600)).toBeUndefined()
  })

  test("quota reset from the error, else the quota cooldown", () => {
    const now = Date.parse("2026-10-26T12:00:00Z")
    expect(quotaReset({ message: "limit hit, resets at 2026-10-27T00:00:00Z" }, now)).toBe(Date.parse("2026-10-27T00:00:00Z"))
    expect(quotaReset({ message: "x", response: { body: '{"error":{"reset_at":"2026-10-26T15:00:00Z"}}' } }, now)).toBe(
      Date.parse("2026-10-26T15:00:00Z"),
    )
    expect(quotaReset({ message: "Usage limit reached. Resets in 3h 20m" }, now)).toBe(now + 200 * 60_000)
    expect(quotaReset({ message: "retry-after: 90 seconds" }, now)).toBe(now + 90_000)
    expect(quotaReset({ message: `"reset": ${Math.floor(now / 1_000) + 60}` }, now)).toBe(now + 60_000)
    expect(quotaReset({ message: "resets at 2020-01-01T00:00:00Z" }, now)).toBeUndefined()
    const options = { cooldownMs: 600_000, quotaCooldownMs: 6 * 3_600_000 }
    expect(cooldownFor("quota", { message: "quota exceeded" }, now, options)).toBe(6 * 3_600_000)
    expect(cooldownFor("quota", { message: "resets in 2h" }, now, options)).toBe(7_200_000)
    expect(cooldownFor("auth", { message: "resets in 2h" }, now, options)).toBe(600_000)
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

describe("childSessionID", () => {
  test("reads the child session from a subagent tool error", () => {
    expect(childSessionID("Subagent failed (sessionID: ses_e87): Service Unavailable")).toBe("ses_e87")
    expect(childSessionID("Subagent failed (ses_1): x")).toBe("ses_1")
    expect(childSessionID("rate limited")).toBeUndefined()
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
