import { describe, expect, test } from "bun:test"
import { candidateStatus, checkRoles, formatCheck } from "./check.ts"
import { decideFallback, failureNote, fallbackTarget, rolesListing, subagentNote } from "./fallback.ts"
import { healthView, markUnhealthy } from "./health.ts"
import { parseOptions } from "./resolve.ts"

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
    const byRole = subagentNote({ ...facts, agent: "general", spawnRole: "task", resumable: "ses_c" })
    expect(byRole).toContain('Spawn it again with role: "task"; that role now runs p/b.')
    expect(byRole).toContain("resume it with sessionID ses_c")
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
    expect(report.choices.map((choice) => choice.role)).toEqual(["odd", "other", "slow", "task"])
    expect(text).toContain("subagent `role` parameter:")
    expect(text).toContain("  - 'task': everyday implementation and investigation (cost unknown)")
    expect(formatCheck(checkRoles(parseOptions({}), [], []))).toBe("No roles configured.")
  })

  test("a fully unhealthy role is marked degraded", () => {
    const health = markUnhealthy({}, a, 0, 1_000, "x")
    const report = checkRoles(opts, available, [], health, 10)
    expect(report.roles.find((role) => role.role === "slow")).toMatchObject({ resolved: a, degraded: true })
    expect(formatCheck(report)).toContain("Role slow → p/a (every candidate unhealthy; least recently failed)")
  })
})
