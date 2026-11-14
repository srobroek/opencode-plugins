import { describe, expect, test } from "bun:test"
import type { FailureClass } from "./health.ts"
import { decideFailureNotice, decideRecovery, type FailureReport, forgetSession, MAX_STOPPED, MAX_TRACKED, newNoticeState, type RequestLog, recordRequest, settleRequest } from "./outage.ts"
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

  test("a re-announced quiet outage keeps its resume list and does not repeat a child", () => {
    const state = newNoticeState()
    const sub = (id: string, now: number) =>
      decideFailureNotice(state, report(bedrock("a"), "credentials", now, { subagent: { agent: "coder", sessionID: id } }))
    sub("c1", 0)
    const again = sub("c1", 3_600_000)
    expect(again?.text).toContain("Provider amazon-bedrock is down (credentials)")
    expect(again?.text).not.toContain("Subagent 'coder'")
    const fresh = sub("c2", 3_601_000)
    expect(fresh?.text).toContain("Subagent 'coder' stopped by the amazon-bedrock outage")
    expect(decideRecovery(state, bedrock("a"))[0]?.text).toContain("coder (c1), coder (c2)")
  })

  test("sessions that succeeded or were deleted leave the resume list", () => {
    const state = newNoticeState()
    for (const id of ["c1", "c2", "c3"])
      decideFailureNotice(state, report(bedrock("a"), "credentials", 0, { subagent: { agent: "coder", sessionID: id } }))
    forgetSession(state, "c1")
    forgetSession(state, "c3")
    expect(decideRecovery(state, bedrock("a"))[0]?.text).toBe(
      "Provider amazon-bedrock recovered (credentials). Resume the stopped subagents: coder (c2).",
    )
  })

  test("every new child is named once; the recovery summary names 20 and counts the rest", () => {
    const state = newNoticeState()
    const sub = (i: number) =>
      decideFailureNotice(state, report(bedrock("a"), "credentials", i, { subagent: { agent: "coder", sessionID: `c${i}` } }))
    const notices = Array.from({ length: 25 }, (_, i) => sub(i)?.text ?? "")
    for (const [i, text] of notices.entries()) expect(text).toContain(`sessionID c${i}`)
    expect(sub(24)).toBeUndefined()
    const text = decideRecovery(state, bedrock("a"))[0]?.text ?? ""
    expect(text).toContain(`coder (c${MAX_STOPPED - 1}), +5 more.`)
    expect(text).not.toContain(`c${MAX_STOPPED})`)
  })

  test("the remembered stopped sessions are bounded, dropping the oldest", () => {
    const state = newNoticeState()
    const sub = (i: number) =>
      decideFailureNotice(state, report(bedrock("a"), "credentials", i, { subagent: { agent: "coder", sessionID: `c${i}` } }))
    for (let i = 0; i < MAX_TRACKED + 1; i++) sub(i)
    expect(sub(MAX_TRACKED)).toBeUndefined()
    expect(sub(0)?.text).toContain("sessionID c0")
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

describe("request log", () => {
  test("an end is credited to the latest request started by then; later requests stay for later ends", () => {
    const log: RequestLog = new Map()
    recordRequest(log, "s", bedrock("a"), 100)
    recordRequest(log, "s", openai("x"), 300)
    expect(settleRequest(log, "s", 200)).toEqual(bedrock("a"))
    expect(settleRequest(log, "s", 200)).toBeUndefined()
    expect(settleRequest(log, "s", 400)).toEqual(openai("x"))
    expect(log.size).toBe(0)
  })

  test("a request in the millisecond of an end belongs to the next execution", () => {
    const log: RequestLog = new Map()
    recordRequest(log, "s", bedrock("a"), 100)
    recordRequest(log, "s", openai("x"), 200)
    expect(settleRequest(log, "s", 200)).toEqual(bedrock("a"))
    expect(settleRequest(log, "s", 300)).toEqual(openai("x"))
  })

  test("an end with no earlier request, and another session's request, are credited to nobody", () => {
    const log: RequestLog = new Map()
    recordRequest(log, "s", bedrock("a"), 100)
    expect(settleRequest(log, "s", 50)).toBeUndefined()
    expect(settleRequest(log, "other", 500)).toBeUndefined()
    expect(settleRequest(log, "s", 500)).toEqual(bedrock("a"))
  })

  test("a backlog of unsettled requests stays bounded", () => {
    const log: RequestLog = new Map()
    for (let i = 0; i < 50; i++) recordRequest(log, "s", bedrock(`m${i}`), i)
    expect(log.get("s")?.length).toBeLessThanOrEqual(8)
    expect(settleRequest(log, "s", 1_000)).toEqual(bedrock("m49"))
  })
})
