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

  test("subscription session and usage limits are spent quota", () => {
    // @openchamber/opencode-claude 1.6.0 proxy.js: the 429 the rate-limit gate sends.
    const claude = {
      type: "provider.rate-limit",
      message: "You've hit your session limit · resets 5pm (Europe/Amsterdam) · limit resets in 2h 10m (2026-10-26T14:10:00.000Z)",
      status: 429,
      response: {
        body: JSON.stringify({
          error: {
            message: "You've hit your session limit · resets 5pm (Europe/Amsterdam)",
            type: "rate_limit_error",
            code: "claude_session_limit",
            resets_at: "2026-10-26T14:10:00.000Z",
            retry_after: 7800,
          },
        }),
      },
      retryAfterMs: 7_800_000,
    }
    expect(classifyFailure(claude)).toBe("quota")
    expect(classifyFailure({ status: 429, message: "x", response: { body: '{"error":{"code":"claude_session_limit"}}' } })).toBe("quota")
    expect(classifyFailure({ message: "Claude Code returned an error result: Claude AI usage limit reached|1761500000" })).toBe("quota")
    expect(classifyFailure({ message: "You've reached your weekly limit for Opus" })).toBe("quota")
    // openai/codex api_bridge.rs: the ChatGPT backend's 429 body.
    const chatgpt = {
      type: "provider.rate-limit",
      message: "The usage limit has been reached",
      status: 429,
      response: { body: '{"error":{"type":"usage_limit_reached","message":"The usage limit has been reached","plan_type":"plus","resets_at":1793021400,"resets_in_seconds":5400}}' },
    }
    expect(classifyFailure(chatgpt)).toBe("quota")
    expect(classifyFailure({ status: 429, message: "x", response: { body: '{"error":{"type":"usage_not_included"}}' } })).toBe("quota")
    // OpenCode 2.1.4 chatgpt.ts: token sharing replaces the message and keeps the body.
    expect(
      classifyFailure({
        type: "provider.rate-limit",
        message: "ChatGPT usage limit reached. Check ChatGPT Settings → Usage for details.",
        status: 429,
        response: { body: '{"error":{"code":"subscription_sharing_usage_limit_exceeded"}}' },
      }),
    ).toBe("quota")
    expect(classifyFailure({ status: 429, message: "x", response: { body: "subscription_sharing_usage_limit_exceeded" } })).toBe("quota")
    expect(classifyFailure({ type: "provider.quota", message: "nope" })).toBe("quota")
    expect(failureScope(classifyFailure(claude) ?? "rate-limit")).toBe("provider")
    // A plain rate limit is still the model's, for a short cooldown.
    expect(classifyFailure({ type: "provider.rate-limit", message: "Rate limit reached for requests", status: 429 })).toBe("rate-limit")

    const now = Date.parse("2026-10-26T12:00:00Z")
    expect(quotaReset(claude, now)).toBe(Date.parse("2026-10-26T14:10:00.000Z"))
    expect(quotaReset({ message: "You've hit your session limit · limit resets in 2h 10m" }, now)).toBe(now + 130 * 60_000)
    expect(quotaReset(chatgpt, now)).toBe(1_793_021_400_000)
    expect(quotaReset({ message: "x", response: { body: '{"error":{"resets_in_seconds":5400}}' } }, now)).toBe(now + 5_400_000)
    expect(quotaReset({ message: "x", response: { body: '{"error":{"retry_after":7800}}' } }, now)).toBe(now + 7_800_000)
    expect(quotaReset({ message: "Retry-After: 120" }, now)).toBe(now + 120_000)
    expect(quotaReset({ message: "Claude AI usage limit reached|1793023200" }, now)).toBe(1_793_023_200_000)
    expect(quotaReset({ message: "ChatGPT usage limit reached.", retryAfterMs: 60_000 }, now)).toBe(now + 60_000)
    expect(quotaReset({ message: "ChatGPT usage limit reached." }, now)).toBeUndefined()
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
