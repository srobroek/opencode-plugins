import { describe, expect, test } from "bun:test"
import { candidateStatus, checkRoles, formatCheck } from "./check.ts"
import { decideFallback, failureNote, fallbackTarget, rolesListing, subagentNote } from "./fallback.ts"
import { healthView, markUnhealthy } from "./health.ts"
import { parseOptions, ROLE_HEADER } from "./resolve.ts"
import { costTier, parseRuntime, roleAgentDescription, shapeRoleAgent } from "./role-agents.ts"

const a = { providerID: "p", id: "a" }
const b = { providerID: "p", id: "b" }
const available = [a, b, { providerID: "q", id: "x", variants: [{ id: "high" }] }, { providerID: "off", id: "m", enabled: false }]
const options = parseOptions({ roles: { task: ["p/a", "p/b"], slow: ["p/a"], other: ["q/x"] }, agents: { general: "task" } })

describe("fallbackTarget", () => {
  test("moves the agent's role to its next healthy candidate", () => {
    const health = healthView(markUnhealthy({}, a, 0, 1_000, "x"), 1)
    expect(fallbackTarget(options, available, health, "task", a)).toEqual({ role: "task", model: b })
  })

  test("without a role, uses the first role that lists the failed model", () => {
    expect(rolesListing(options, { ...a, variant: "high" })).toEqual(["slow", "task"])
    const health = healthView(markUnhealthy({}, a, 0, 1_000, "x"), 1)
    expect(fallbackTarget(options, available, health, undefined, a)).toEqual({ role: "task", model: b })
    expect(fallbackTarget(options, available, health, "nope", b)).toBeUndefined()
  })

  test("no target when the role still resolves to the failed model", () => {
    const health = healthView(markUnhealthy({}, a, 0, 1_000, "x"), 1)
    expect(fallbackTarget(options, available, health, "slow", a)).toBeUndefined()
  })
})

describe("decideFallback", () => {
  const base = { isChild: false, retryOnFallback: true, failed: a, next: b, lastRetryAt: undefined, now: 1_000, windowMs: 500 }
  test("retries a root session once per window", () => {
    expect(decideFallback(base)).toBe("retry")
    expect(decideFallback({ ...base, lastRetryAt: 900 })).toBe("notify")
    expect(decideFallback({ ...base, lastRetryAt: 100 })).toBe("retry")
  })
  test("notifies when retry is off or there is nothing new", () => {
    expect(decideFallback({ ...base, retryOnFallback: false })).toBe("notify")
    expect(decideFallback({ ...base, next: undefined })).toBe("notify")
    expect(decideFallback({ ...base, next: a })).toBe("notify")
    expect(decideFallback({ ...base, isChild: true })).toBe("notify-parent")
  })
  test("notes name the model, the cooldown and the next model", () => {
    const facts = { failed: a, kind: "auth" as const, cooldownMs: 600_000, target: { role: "task", model: b } }
    expect(failureNote(facts)).toBe("Model p/a failed (auth); it sits out new resolutions for 10 min. Role task now resolves to p/b.")
    expect(subagentNote({ ...facts, agent: "general" })).toContain("Subagent 'general' failed. Model p/a")
    expect(subagentNote({ ...facts, agent: "general" })).toContain("may be retried")
    expect(subagentNote({ ...facts, target: undefined, agent: undefined })).toContain("same model")
  })
})

describe("role agents", () => {
  test("parseRuntime defaults and intersects roleAgents with configured roles", () => {
    expect(parseRuntime({}, options)).toEqual({ cooldownMs: 600_000, retryOnFallback: true, roleAgents: ["task", "slow"] })
    expect(parseRuntime({ roleAgents: [], cooldownMs: 5, retryOnFallback: false }, options)).toEqual({
      cooldownMs: 5,
      retryOnFallback: false,
      roleAgents: [],
    })
    expect(parseRuntime({ roleAgents: ["other", "nope", 3] }, options).roleAgents).toEqual(["other"])
  })

  test("descriptions state purpose and cost tier", () => {
    expect(costTier(0.11)).toBe("low cost, $0.11/M input tokens")
    expect(costTier(4.4)).toBe("high cost, $4.4/M input tokens")
    const text = roleAgentDescription("smol", { providerID: "anthropic", id: "haiku" }, 0.1)
    expect(text).toContain("'smol' model role: cheap and fast")
    expect(text).toContain("runs anthropic/haiku (low cost")
    expect(roleAgentDescription("odd", undefined, undefined)).toContain("inherits yours")
  })

  test("shapeRoleAgent clones general and sets the role header", () => {
    const general = { system: "be general", steps: 9, permissions: [{ action: "edit", resource: "*", effect: "allow" }] }
    const draft: Record<string, unknown> = { mode: "primary", permissions: [] }
    shapeRoleAgent(draft, general, "smol", "desc", true)
    expect(draft).toEqual({
      name: "general-smol",
      description: "desc",
      mode: "subagent",
      hidden: false,
      system: "be general",
      steps: 9,
      permissions: [{ action: "edit", resource: "*", effect: "allow" }],
      request: { headers: { [ROLE_HEADER]: "smol" } },
    })
    const configured: Record<string, unknown> = { name: "Mine", description: "mine", mode: "all", permissions: [{ action: "x" }] }
    shapeRoleAgent(configured, general, "smol", "desc", false)
    expect(configured.description).toBe("mine")
    expect(configured.mode).toBe("all")
    expect(configured.permissions).toEqual([{ action: "edit", resource: "*", effect: "allow" }, { action: "x" }])
  })
})

describe("check", () => {
  const roles = { ...options.roles, odd: ["q/x#low", "q/y", "off/m", "nope/z", "@task", "@ghost", "bad"] }
  const opts = { ...options, roles }

  test("candidate statuses across every listed model", () => {
    const health = markUnhealthy({}, a, 0, 1_000, "auth: denied")
    const status = (entry: string) => candidateStatus(entry, available, roles, health, 10)
    expect(status("p/a")).toEqual({ status: "unhealthy", until: 1_000, reason: "auth: denied" })
    expect(status("p/b")).toEqual({ status: "available" })
    expect(status("q/x#high")).toEqual({ status: "available" })
    expect(status("q/x#low")).toEqual({ status: "unknown-variant", variants: ["high"] })
    expect(status("q/y")).toEqual({ status: "unknown-id" })
    expect(status("off/m")).toEqual({ status: "provider-unavailable" })
    expect(status("nope/z")).toEqual({ status: "provider-unavailable" })
    expect(status("@ghost")).toEqual({ status: "role-link", role: "ghost", known: false })
    expect(status("bad")).toEqual({ status: "invalid" })
  })

  test("report and text", () => {
    const report = checkRoles(opts, available, [{ id: "general" }, { id: "build" }], {}, 0)
    expect(report.agents).toEqual([{ id: "general", role: "task", resolved: a }])
    const text = formatCheck(report)
    expect(text).toContain("Role odd → p/a")
    expect(text).toContain("  - q/x#low: unknown variant (has: high)")
    expect(text).toContain("  - @ghost: link to unknown role ghost")
    expect(text).toContain("  - general (role task) → p/a")
    expect(formatCheck(checkRoles(parseOptions({}), [], []))).toBe("No roles configured.")
  })

  test("a fully unhealthy role is marked degraded", () => {
    const health = markUnhealthy({}, a, 0, 1_000, "x")
    const report = checkRoles(opts, available, [], health, 10)
    expect(report.roles.find((role) => role.role === "slow")).toMatchObject({ resolved: a, degraded: true })
    expect(formatCheck(report)).toContain("Role slow → p/a (every candidate unhealthy; least recently failed)")
  })
})
