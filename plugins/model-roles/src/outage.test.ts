import { describe, expect, test } from "bun:test"
import type { FailureClass } from "./health.ts"
import { decideFailureNotice, decideRecovery, type FailureReport, newNoticeState } from "./outage.ts"
import type { ModelRef } from "./resolve.ts"

const bedrock = (id: string): ModelRef => ({ providerID: "amazon-bedrock", id })
const openai = (id: string): ModelRef => ({ providerID: "openai", id })

const report = (failed: ModelRef, kind: FailureClass, now: number, extra: Partial<FailureReport> = {}): FailureReport => ({
  failed,
  kind,
  cooldownMs: 60_000,
  target: undefined,
  now,
  notifyTo: "lead",
  ...extra,
})

describe("provider outage", () => {
  test("20 credential failures over 3 models of one provider give one outage notice and one recovery notice", () => {
    const state = newNoticeState()
    const models = [bedrock("a"), bedrock("b"), bedrock("c")]
    const notices = []
    for (let i = 0; i < 20; i++) {
      const notice = decideFailureNotice(state, report(models[i % 3] as ModelRef, "credentials", 1_000 + i * 10_000, { notifyTo: `s${i % 4}` }))
      if (notice !== undefined) notices.push(notice)
    }
    expect(notices).toHaveLength(1)
    expect(notices[0]?.sessionID).toBe("s0")
    expect(notices[0]?.text).toContain("Provider amazon-bedrock is down (credentials)")
    const recovered = decideRecovery(state, bedrock("b"))
    expect(recovered).toEqual([{ sessionID: "s0", text: "Provider amazon-bedrock recovered (credentials)." }])
    // The outage is over: a second success says nothing, and a new failure is a new outage.
    expect(decideRecovery(state, bedrock("b"))).toEqual([])
    expect(decideFailureNotice(state, report(bedrock("a"), "credentials", 402_000))).toBeDefined()
  })

  test("a failure of the first attempt that does not sit the provider out yet still opens the outage", () => {
    const state = newNoticeState()
    const notice = decideFailureNotice(state, report(bedrock("a"), "credentials", 0, { cooldownMs: 0 }))
    expect(notice?.text).toContain("Provider amazon-bedrock is failing (credentials)")
    expect(decideFailureNotice(state, report(bedrock("b"), "credentials", 1_000))).toBeUndefined()
  })

  test("a second provider's outage and a second class each get their own notice", () => {
    const state = newNoticeState()
    expect(decideFailureNotice(state, report(bedrock("a"), "credentials", 0))).toBeDefined()
    const other = decideFailureNotice(state, report(openai("x"), "credentials", 1_000))
    expect(other?.text).toContain("Provider openai is down (credentials)")
    expect(decideFailureNotice(state, report(bedrock("a"), "quota", 2_000))?.text).toContain("(quota)")
    // Only the provider that came back recovers.
    expect(decideRecovery(state, openai("y")).map((n) => n.text)).toEqual(["Provider openai recovered (credentials)."])
    expect(decideFailureNotice(state, report(bedrock("b"), "credentials", 4_000))).toBeUndefined()
  })

  test("an outage nobody saw end is announced again once its failures have stopped for long enough", () => {
    const state = newNoticeState()
    decideFailureNotice(state, report(bedrock("a"), "credentials", 0))
    expect(decideFailureNotice(state, report(bedrock("a"), "credentials", 3_600_000))).toBeDefined()
  })

  test("subagent failures during an outage are one line per session, then folded into the recovery notice", () => {
    const state = newNoticeState()
    const sub = (sessionID: string | undefined, agent: string, now: number) =>
      decideFailureNotice(state, report(bedrock("a"), "credentials", now, { subagent: { agent, sessionID }, plain: "unused" }))
    const first = sub("c1", "coder", 0)
    expect(first?.text).toContain("Provider amazon-bedrock is down (credentials)")
    expect(first?.text).toContain("Subagent 'coder' stopped: resume it with sessionID c1 when the provider is back.")
    for (let i = 1; i < 9; i++) expect(sub("c1", "coder", i * 1_000)).toBeUndefined()
    const second = sub("c2", "reviewer", 10_000)
    expect(second?.sessionID).toBe("lead")
    expect(second?.text).toBe("Subagent 'reviewer' stopped by the amazon-bedrock outage (credentials): resume it with sessionID c2 when the provider is back.")
    expect(sub("c2", "reviewer", 11_000)).toBeUndefined()
    const [recovery] = decideRecovery(state, bedrock("z"))
    expect(recovery?.text).toBe("Provider amazon-bedrock recovered (credentials). Resume the stopped subagents: coder (c1), reviewer (c2).")
  })

  test("a subagent that names no session is reported once per parent and agent", () => {
    const state = newNoticeState()
    const sub = (agent: string) =>
      decideFailureNotice(state, report(bedrock("a"), "credentials", 0, { subagent: { agent, sessionID: undefined } }))
    expect(sub("coder")?.text).toContain("Subagent 'coder' stopped: spawn it again when the provider is back.")
    expect(sub("coder")).toBeUndefined()
    expect(sub("other")?.text).toContain("Subagent 'other' stopped by the amazon-bedrock outage")
  })
})

describe("model failure", () => {
  test("notifies once per model and class within the window, with the plain text", () => {
    const state = newNoticeState()
    const fail = (id: string, kind: FailureClass, now: number) =>
      decideFailureNotice(state, report(bedrock(id), kind, now, { plain: `${id} ${kind}` }))
    expect(fail("a", "rate-limit", 0)?.text).toBe("a rate-limit")
    expect(fail("a", "rate-limit", 30_000)).toBeUndefined()
    expect(fail("b", "rate-limit", 30_000)?.text).toBe("b rate-limit")
    expect(fail("a", "server", 30_000)?.text).toBe("a server")
    expect(fail("a", "rate-limit", 61_000)?.text).toBe("a rate-limit")
  })

  test("the same model failing for two parents tells both", () => {
    const state = newNoticeState()
    const fail = (to: string) => decideFailureNotice(state, report(bedrock("a"), "rate-limit", 0, { notifyTo: to, plain: "x" }))
    expect(fail("p1")).toBeDefined()
    expect(fail("p2")).toBeDefined()
    expect(fail("p1")).toBeUndefined()
  })

  test("a model failure does not recover or open a provider outage", () => {
    const state = newNoticeState()
    decideFailureNotice(state, report(bedrock("a"), "rate-limit", 0, { plain: "x" }))
    expect(decideRecovery(state, bedrock("a"))).toEqual([])
  })
})
