import { describe, expect, test } from "bun:test"
import { candidateStatus, checkRoles, formatCheck } from "./check.ts"
import { failureNote, fallbackTarget, retryTarget, rolesListing, staysOnModel, subagentNote, switchNote } from "./fallback.ts"
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

describe("retry switch", () => {
  const base = {
    options,
    available,
    health: healthView(markUnhealthy({}, a, 0, 1_000, "x"), 1),
    role: "task",
    failed: a,
    kind: "server" as const,
    attempt: 4,
    hostRetries: 2,
  }

  test("moves to the role's next healthy candidate", () => {
    expect(retryTarget(base)).toEqual({ role: "task", model: b })
    expect(retryTarget({ ...base, role: undefined })).toEqual({ role: "task", model: b })
  })

  test("transient failures spend the host's retry budget first; permanent ones switch at once", () => {
    expect(staysOnModel("rate-limit", 2, 2)).toBe(true)
    expect(staysOnModel("server", 3, 2)).toBe(true)
    expect(staysOnModel("outage", 3, 2)).toBe(true)
    expect(staysOnModel("rate-limit", 4, 2)).toBe(false)
    expect(staysOnModel("rate-limit", 2, 0)).toBe(false)
    for (const kind of ["quota", "auth", "unavailable", "content-filter"] as const) expect(staysOnModel(kind, 2, 2)).toBe(false)
    expect(retryTarget({ ...base, attempt: 2 })).toBeUndefined()
    expect(retryTarget({ ...base, kind: "quota", attempt: 2 })).toEqual({ role: "task", model: b })
  })

  test("never onto a cooling-down model, so two failures cannot trade places", () => {
    const both = healthView(markUnhealthy(markUnhealthy({}, a, 0, 1_000, "x"), b, 0, 1_000, "y"), 1)
    expect(retryTarget({ ...base, health: both })).toBeUndefined()
    expect(retryTarget({ ...base, role: "slow" })).toBeUndefined()
  })

  test("the switch note names both models", () => {
    const facts = { failed: a, kind: "server" as const, cooldownMs: 600_000, target: { role: "task", model: b } }
    expect(switchNote(facts)).toEndWith("Tier task now resolves to p/b. The request was retried on p/b.")
    expect(failureNote({ ...facts, cooldownMs: 1_000 })).toContain("sits out new resolutions for 1 s.")
  })

  test("notes name the model, the cooldown and the next model", () => {
    const facts = { failed: a, kind: "auth" as const, cooldownMs: 600_000, target: { role: "task", model: b } }
    expect(failureNote(facts)).toBe(
      "Model p/a failed (auth); every p model sits out new resolutions for 10 min. Tier task now resolves to p/b.",
    )
    expect(failureNote({ ...facts, kind: "server" })).toStartWith("Model p/a failed (server); it sits out new resolutions for 10 min.")
    expect(failureNote({ ...facts, kind: "quota", cooldownMs: 6 * 3_600_000 })).toContain("for 6 h.")
    expect(subagentNote({ ...facts, agent: "general" })).toContain("Subagent 'general' failed. Model p/a")
    expect(subagentNote({ ...facts, agent: "general" })).toContain("may be retried")
    expect(subagentNote({ ...facts, target: undefined, agent: undefined })).toContain("same model")
    expect(failureNote({ ...facts, failed: { ...a, variant: "default" } })).toStartWith("Model p/a failed (auth)")
    expect(failureNote({ ...facts, failed: { ...a, variant: "high" } })).toStartWith("Model p/a#high failed (auth)")
    const byRole = subagentNote({ ...facts, agent: "general", spawnRole: "task", resumable: "ses_c" })
    expect(byRole).toContain('Spawn it again with tier: "task"; that tier now runs p/b.')
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
    expect(text).toContain("subagent `tier` parameter:")
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
