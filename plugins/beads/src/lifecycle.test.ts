import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { createFakeContext } from "@srobroek/opencode-lib/testing"
import { setBdShowRunForTests } from "./bd-close-gate.ts"
import type { BdRun } from "./gate-admission.ts"
import { HEARTBEAT_INTERVAL_MS, type HeartbeatClock } from "./heartbeat.ts"
import { type AdapterDeps, SKILL_NAMES, setupBeads } from "./index.ts"
import {
  BEADS_SOURCE,
  childFinished,
  goalContinuation,
  isPluginPrompt,
  readExecutionEvent,
  rootStopAction,
  subagentChild,
} from "./lifecycle.ts"

describe("decisions", () => {
  const state = { claims: 1, nudged: false, continuing: false }
  test("a clean stop with claims nudges first, then releases", () => {
    expect(rootStopAction({ kind: "succeeded" }, state)).toBe("nudge")
    expect(rootStopAction({ kind: "succeeded" }, { ...state, nudged: true })).toBe("release")
  })
  test("no claims, a goal continuation, a failure or an interrupt does nothing", () => {
    expect(rootStopAction({ kind: "succeeded" }, { ...state, claims: 0 })).toBe("none")
    expect(rootStopAction({ kind: "succeeded" }, { ...state, continuing: true })).toBe("none")
    expect(rootStopAction({ kind: "failed" }, state)).toBe("none")
    for (const reason of ["user", "shutdown", "superseded", "inactivity"])
      expect(rootStopAction({ kind: "interrupted", reason }, { ...state, nudged: true })).toBe("none")
  })
  test("a subagent is finished unless its execution was superseded", () => {
    expect(childFinished({ kind: "succeeded" })).toBe(true)
    expect(childFinished({ kind: "failed" })).toBe(true)
    expect(childFinished({ kind: "interrupted", reason: "user" })).toBe(true)
    expect(childFinished({ kind: "interrupted", reason: "superseded" })).toBe(false)
  })
  test("goal and beads prompts are not the user speaking", () => {
    expect(isPluginPrompt({ source: "srobroek.goal" })).toBe(true)
    expect(isPluginPrompt({ source: BEADS_SOURCE })).toBe(true)
    expect(isPluginPrompt({ source: "user" })).toBe(false)
    expect(isPluginPrompt(undefined)).toBe(false)
  })
  test("the goal registry is read through its global symbol", () => {
    const holder = globalThis as { [key: symbol]: unknown }
    const key = Symbol.for("srobroek.goal.continuations")
    const previous = holder[key]
    holder[key] = new Map([["ses_goal", "goal"]])
    try {
      expect(goalContinuation("ses_goal")).toBe("goal")
      expect(goalContinuation("ses_other")).toBeUndefined()
    } finally {
      holder[key] = previous
    }
  })
  test("execution events are read; other events are not", () => {
    expect(readExecutionEvent({ id: "e1", type: "session.execution.interrupted", data: { sessionID: "s", reason: "user" } })).toEqual({
      id: "e1",
      type: "session.execution.interrupted",
      sessionID: "s",
      end: { kind: "interrupted", reason: "user" },
    })
    expect(readExecutionEvent({ type: "session.step.started", data: { sessionID: "s" } })).toBeUndefined()
    expect(readExecutionEvent(null)).toBeUndefined()
  })
  test("the subagent result names its child and whether it runs in the background", () => {
    expect(subagentChild({ content: "", metadata: { sessionID: "ses_c", status: "completed" } } as never)).toEqual({
      sessionID: "ses_c",
      background: false,
    })
    expect(subagentChild({ content: "", output: { sessionID: "ses_c", status: "running" } } as never)?.background).toBe(true)
    expect(subagentChild({ content: "" } as never)).toBeUndefined()
  })
})

class FakeClock implements HeartbeatClock {
  #next = 0
  readonly callbacks = new Map<number, () => void>()
  setInterval(callback: () => void, ms: number): unknown {
    expect(ms).toBe(HEARTBEAT_INTERVAL_MS)
    this.callbacks.set(++this.#next, callback)
    return this.#next
  }
  clearInterval(timer: unknown): void {
    this.callbacks.delete(timer as number)
  }
  tick(): void {
    for (const callback of [...this.callbacks.values()]) callback()
  }
}

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

let unique = 0
const sid = (name: string) => `ses_${name}_${++unique}`

type Row = { status: string; assignee?: string }

/** A bd stand-in that remembers who holds what, like the ledger would. */
function ledger(rows: Record<string, Row> = {}) {
  const calls: string[][] = []
  const run: BdRun = async (_cwd, args, _deadline, env) => {
    calls.push(args)
    const [verb, id = ""] = args
    if (verb === "show") {
      const row = rows[id]
      return { output: JSON.stringify({ data: row === undefined ? [] : [{ id, issue_type: "task", ...row }], schema_version: 1 }) }
    }
    if (verb === "unclaim") {
      if (rows[id]?.assignee !== env.BD_ACTOR) return { failure: "bd exited with code 1: assignee mismatch" }
      rows[id] = { status: "open" }
      return { output: "released" }
    }
    if (verb === "heartbeat") return { output: JSON.stringify({ data: { id }, schema_version: 1 }) }
    return { output: "null" }
  }
  return { run, calls, rows }
}

async function start(sessions: Array<{ id: string; parentID?: string }>, deps: AdapterDeps = {}, options: { gates?: Record<string, boolean> } = {}) {
  const directory = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "beads-lifecycle-"))
  roots.push(directory)
  // Lifecycle cases do not exercise Git-hook discovery; avoid native Git probes.
  const fake = createFakeContext({ directory, sessions, options: { ...options, gates: { "binary-git-hooks": false, ...options.gates } } })
  const detached: Array<Promise<unknown>> = []
  const waiters = new Map<string, () => void>()
  const clock = new FakeClock()
  const cleanup = await setupBeads(fake.context, {
    env: { PATH: process.env.PATH, HOME: process.env.HOME } as NodeJS.ProcessEnv,
    pinFor: () => undefined,
    clock,
    detach: (task) => void detached.push(task),
    eventHandled: (event) => {
      const id = (event as { id: string }).id
      waiters.get(id)?.()
      waiters.delete(id)
    },
    ...deps,
  })
  const settle = async () => {
    while (detached.length) await Promise.all(detached.splice(0))
  }
  let event = 0
  const emit = async (type: string, sessionID: string, data: Record<string, unknown> = {}, drain = true) => {
    const id = `evt_${unique}_${++event}`
    const ack = Promise.withResolvers<void>()
    waiters.set(id, ack.resolve)
    fake.emit({ id, type, data: { sessionID, ...data } })
    await ack.promise
    if (drain) await settle()
  }
  const shell = async (sessionID: string, command: string, output: string, id = `call_${++event}`) => {
    const before = { tool: "shell", sessionID, agent: "general", messageID: "msg_1", id, input: { command } }
    await fake.fire.tool("execute.before", before)
    return fake.fire.tool("execute.after", {
      ...before,
      status: "completed" as const,
      result: { content: output, output: { exit: 0, output }, metadata: { exit: 0 } },
    })
  }
  const synthetics = () =>
    fake.calls
      .filter((call) => call.method === "session.synthetic")
      .map((call) => call.input as { sessionID: string; text: string; resume: boolean; delivery: string; metadata: { source: string } })
  return { fake, cleanup, emit, shell, settle, synthetics, clock, directory }
}

describe("stop nudge and release in a root session", () => {
  test("nudges once with resume, releases on the second stop, re-arms on a user prompt", async () => {
    const root = sid("root")
    const bd = ledger({ "proj-1": { status: "in_progress", assignee: "me/main" } })
    const t = await start([{ id: root }], { run: bd.run })
    await t.shell(root, "BEADS_ACTOR=me/main bd update proj-1 --claim", "✓ Claimed proj-1")
    await t.emit("session.execution.succeeded", root)
    const [nudge] = t.synthetics()
    expect(nudge).toMatchObject({ sessionID: root, resume: true, delivery: "queue", metadata: { source: BEADS_SOURCE } })
    expect(nudge?.text).toContain("proj-1 [me/main]")
    expect(nudge?.text).toContain("'--if-assignee' 'me/main'")
    expect(bd.calls.some((args) => args[0] === "unclaim")).toBe(false)

    await t.emit("session.execution.succeeded", root)
    expect(bd.calls.filter((args) => args[0] === "unclaim")).toHaveLength(1)
    const report = t.synthetics()[1]
    expect(report).toMatchObject({ sessionID: root, resume: false })
    expect(report?.text).toContain("released (guarded bd unclaim): proj-1")
    expect(Object.keys((t.fake.storage.get(`claims/${root}`) as { claims: object }).claims)).toHaveLength(0)

    // A new claim after a real prompt is nudged again rather than released at once.
    bd.rows["proj-2"] = { status: "in_progress", assignee: "me/main" }
    await t.fake.fire.session("prompt", { sessionID: root, messageID: "m", prompt: { text: "go on" }, delivery: "queue" })
    await t.shell(root, "BEADS_ACTOR=me/main bd update proj-2 --claim", "✓ Claimed proj-2")
    await t.emit("session.execution.succeeded", root)
    expect(t.synthetics()[2]).toMatchObject({ resume: true })
    expect(bd.calls.filter((args) => args[0] === "unclaim")).toHaveLength(1)
    await t.cleanup()
  })

  test("a goal or plugin prompt does not re-arm the nudge", async () => {
    const root = sid("root")
    const t = await start([{ id: root }], { run: ledger().run })
    await t.shell(root, "BEADS_ACTOR=me/main bd update proj-1 --claim", "✓ Claimed proj-1")
    await t.emit("session.execution.succeeded", root)
    await t.fake.fire.session("prompt", { sessionID: root, metadata: { source: "srobroek.goal" }, prompt: { text: "continue" } })
    expect(t.fake.storage.get(`nudged/${root}`)).toBe(true)
    await t.cleanup()
  })

  test("stands down while the goal plugin continues the session", async () => {
    const root = sid("root")
    const holder = globalThis as { [key: symbol]: unknown }
    const key = Symbol.for("srobroek.goal.continuations")
    const previous = holder[key]
    holder[key] = new Map([[root, "goal"]])
    const t = await start([{ id: root }], { run: ledger().run })
    try {
      await t.shell(root, "BEADS_ACTOR=me/main bd update proj-1 --claim", "✓ Claimed proj-1")
      await t.emit("session.execution.succeeded", root)
      expect(t.synthetics()).toEqual([])
      ;(holder[key] as Map<string, string>).delete(root)
      await t.emit("session.execution.succeeded", root)
      expect(t.synthetics()).toHaveLength(1)
    } finally {
      holder[key] = previous
      await t.cleanup()
    }
  })

  test("a user interrupt, a shutdown or a failure is not a stop", async () => {
    const root = sid("root")
    const t = await start([{ id: root }], { run: ledger().run })
    await t.shell(root, "BEADS_ACTOR=me/main bd update proj-1 --claim", "✓ Claimed proj-1")
    await t.emit("session.execution.interrupted", root, { reason: "user" })
    await t.emit("session.execution.interrupted", root, { reason: "shutdown" })
    await t.emit("session.execution.failed", root, { error: { message: "boom" } })
    expect(t.synthetics()).toEqual([])
    await t.cleanup()
  })

  test("nothing claimed, nothing said; the nudge gate switches it off", async () => {
    const root = sid("root")
    const t = await start([{ id: root }], { run: ledger().run }, { gates: { "beads-stop-nudge": false } })
    await t.emit("session.execution.succeeded", root)
    await t.shell(root, "BEADS_ACTOR=me/main bd update proj-1 --claim", "✓ Claimed proj-1")
    await t.emit("session.execution.succeeded", root)
    expect(t.synthetics()).toEqual([])
    await t.cleanup()
  })

  test("one event delivered to two plugin instances is handled once", async () => {
    const root = sid("root")
    const bd = ledger()
    const directory = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "beads-lifecycle-"))
    roots.push(directory)
    const fake = createFakeContext({ directory, sessions: [{ id: root }], options: { gates: { "binary-git-hooks": false } } })
    const ack = Promise.withResolvers<void>()
    let handled = 0
    const deps = {
      env: {}, pinFor: () => undefined, run: bd.run, clock: new FakeClock(),
      eventHandled: () => {
        if (++handled === 2) ack.resolve()
      },
    }
    const one = await setupBeads(fake.context, deps)
    const two = await setupBeads(fake.context, deps)
    const before = { tool: "shell", sessionID: root, agent: "general", messageID: "m", id: "c1", input: { command: "BEADS_ACTOR=me/main bd update proj-1 --claim" } }
    await fake.fire.tool("execute.before", before)
    await fake.fire.tool("execute.after", { ...before, status: "completed", result: { content: "✓ Claimed proj-1", output: { exit: 0, output: "✓ Claimed proj-1" }, metadata: { exit: 0 } } })
    fake.emit({ id: `evt_dup_${++unique}`, type: "session.execution.succeeded", data: { sessionID: root } })
    await ack.promise
    expect(fake.calls.filter((call) => call.method === "session.synthetic")).toHaveLength(1)
    await one()
    await two()
  })
})

describe("subagent claim release", () => {
  test("a foreground subagent's claims are released in its parent's tool result", async () => {
    const parent = sid("parent")
    const child = sid("child")
    const actor = `opencode/${parent}/general/${child}`
    const bd = ledger({ "proj-7": { status: "in_progress", assignee: actor } })
    const t = await start([{ id: parent }, { id: child, parentID: parent }], { run: bd.run })
    const call = { tool: "subagent", sessionID: parent, agent: "build", messageID: "m", id: "call_sub", input: { prompt: "do it" } }
    await t.fake.fire.tool("execute.before", call)
    await t.shell(child, "bd update proj-7 --claim", "✓ Claimed proj-7")
    await t.emit("session.execution.succeeded", child)
    expect(bd.calls.some((args) => args[0] === "unclaim")).toBe(false)
    const after = await t.fake.fire.tool("execute.after", {
      ...call,
      status: "completed" as const,
      result: { content: `<subagent sessionID=${child} state="completed">done</subagent>`, metadata: { sessionID: child, status: "completed" } },
    })
    expect(bd.calls.filter((args) => args[0] === "unclaim")).toHaveLength(1)
    expect(String(after.result.content)).toContain(`finished subagent session ${child} were released (guarded bd unclaim): proj-7`)
    expect(t.synthetics()).toEqual([])
    await t.cleanup()
  })

  test("a child end that arrives while its foreground release runs is not reported twice", async () => {
    const parent = sid("parent")
    const child = sid("child")
    const bd = ledger({ "proj-6": { status: "in_progress", assignee: `opencode/${parent}/general/${child}` } })
    const showEntered = Promise.withResolvers<void>()
    const allowShow = Promise.withResolvers<void>()
    const run: BdRun = async (cwd, args, deadline, env) => {
      if (args[0] === "show") {
        showEntered.resolve()
        await allowShow.promise
      }
      return bd.run(cwd, args, deadline, env)
    }
    const t = await start([{ id: parent }, { id: child, parentID: parent }], { run })
    const call = { tool: "subagent", sessionID: parent, agent: "build", messageID: "m", id: "call_race", input: { prompt: "x" } }
    await t.fake.fire.tool("execute.before", call)
    await t.shell(child, "bd update proj-6 --claim", "✓ Claimed proj-6")
    const after = t.fake.fire.tool("execute.after", {
      ...call,
      status: "completed" as const,
      result: { content: "done", metadata: { sessionID: child, status: "completed" } },
    })
    await showEntered.promise
    await t.emit("session.execution.succeeded", child, {}, false)
    allowShow.resolve()
    expect(String((await after).result.content)).toContain("released (guarded bd unclaim): proj-6")
    await t.settle()
    expect(t.synthetics()).toEqual([])
    expect(bd.calls.filter((args) => args[0] === "unclaim")).toHaveLength(1)
    await t.cleanup()
  })

  test("an unverified foreground release is appended with its check and release commands", async () => {
    const parent = sid("parent")
    const child = sid("child")
    const bd = ledger({ "proj-8": { status: "in_progress", assignee: `opencode/${parent}/general/${child}` } })
    const run: BdRun = async (cwd, args, deadline, env) =>
      args[0] === "unclaim" ? { failure: "bd command timed out" } : bd.run(cwd, args, deadline, env)
    const t = await start([{ id: parent }, { id: child, parentID: parent }], { run })
    const call = { tool: "subagent", sessionID: parent, agent: "build", messageID: "m", id: "call_sub", input: { prompt: "x" } }
    await t.fake.fire.tool("execute.before", call)
    await t.shell(child, "bd update proj-8 --claim", "✓ Claimed proj-8")
    const after = await t.fake.fire.tool("execute.after", {
      ...call,
      status: "completed" as const,
      result: { content: [{ type: "text", text: "done" }], metadata: { sessionID: child, status: "completed" } },
    })
    const text = JSON.stringify(after.result.content)
    expect(text).toContain("were not verified as released")
    expect(text).toContain("bd show 'proj-8' --json")
    expect(Object.keys((t.fake.storage.get(`claims/${child}`) as { claims: object }).claims)).toHaveLength(1)
    await t.cleanup()
  })

  test("a background subagent's claims are released when it ends and its parent is told without waking", async () => {
    const parent = sid("parent")
    const child = sid("child")
    const bd = ledger({ "proj-9": { status: "blocked", assignee: `opencode/${parent}/general/${child}` } })
    const t = await start([{ id: parent }, { id: child, parentID: parent }], { run: bd.run })
    const call = { tool: "subagent", sessionID: parent, agent: "build", messageID: "m", id: "call_bg", input: { prompt: "x", background: true } }
    await t.fake.fire.tool("execute.before", call)
    await t.fake.fire.tool("execute.after", {
      ...call,
      status: "completed" as const,
      result: { content: "started", metadata: { sessionID: child, status: "running" } },
    })
    await t.shell(child, "bd update proj-9 --claim", "✓ Claimed proj-9")
    await t.emit("session.execution.succeeded", child)
    expect(bd.calls.map((args) => args[0]).filter((verb) => verb !== "gate")).toEqual(["show", "unclaim", "update"])
    const [told] = t.synthetics()
    expect(told).toMatchObject({ sessionID: parent, resume: false, metadata: { source: BEADS_SOURCE } })
    expect(told?.text).toContain(`finished background subagent session ${child} were released`)
    await t.cleanup()
  })

  test("a superseded subagent keeps its claims; the release gate switches release off", async () => {
    const parent = sid("parent")
    const child = sid("child")
    const bd = ledger({ "proj-3": { status: "in_progress", assignee: `opencode/${parent}/general/${child}` } })
    const t = await start([{ id: parent }, { id: child, parentID: parent }], { run: bd.run })
    await t.shell(child, "bd update proj-3 --claim", "✓ Claimed proj-3")
    await t.emit("session.execution.interrupted", child, { reason: "superseded" })
    expect(bd.calls.some((args) => args[0] === "show")).toBe(false)
    await t.cleanup()
    const off = await start([{ id: parent }, { id: child, parentID: parent }], { run: bd.run }, { gates: { "beads-claim-release": false } })
    await off.emit("session.execution.succeeded", child)
    expect(bd.calls.some((args) => args[0] === "show")).toBe(false)
    await off.cleanup()
  })
})

describe("lease heartbeat", () => {
  beforeAll(() =>
    setBdShowRunForTests((argv) => ({
      exitCode: 0,
      stdout: JSON.stringify(argv.filter((word) => /^proj-/.test(word)).map((id) => ({ id, issue_type: "task" }))),
    })),
  )
  afterAll(() => setBdShowRunForTests(null))

  test("renews while executing, pauses between executions, stops on close", async () => {
    const root = sid("root")
    const bd = ledger({ "proj-1": { status: "in_progress", assignee: "me/main" } })
    const t = await start([{ id: root }], { run: bd.run })
    const beats = () => bd.calls.filter((args) => args[0] === "heartbeat").length
    await t.shell(root, "BEADS_ACTOR=me/main bd update proj-1 --claim", "✓ Claimed proj-1")
    expect(Object.values(t.fake.storage.get(`leases/${root}`) as object)).toHaveLength(1)
    t.clock.tick()
    await t.settle()
    expect(beats()).toBe(1)
    await t.emit("session.execution.succeeded", root)
    expect(t.clock.callbacks.size).toBe(0)
    await t.emit("session.execution.started", root)
    expect(beats()).toBe(2)
    expect(t.clock.callbacks.size).toBe(1)
    await t.shell(root, 'BEADS_ACTOR=me/main bd close proj-1 --reason "done"', "✓ Closed proj-1")
    expect(t.clock.callbacks.size).toBe(0)
    expect(t.fake.storage.get(`leases/${root}`)).toEqual({})
    await t.cleanup()
  })

  test("a failed heartbeat drops the lease and tells the session once, without waking it", async () => {
    const root = sid("root")
    const run: BdRun = async (_cwd, args) => (args[0] === "heartbeat" ? { failure: "bd exited with code 1: not the owner" } : { output: "null" })
    const t = await start([{ id: root }], { run })
    await t.shell(root, "BEADS_ACTOR=me/main bd update proj-1 --claim", "✓ Claimed proj-1")
    t.clock.tick()
    await t.settle()
    const [notice] = t.synthetics()
    expect(notice).toMatchObject({ sessionID: root, resume: false })
    expect(notice?.text).toContain("Beads lease heartbeat failed for proj-1")
    expect(t.fake.storage.get(`leases/${root}`)).toEqual({})
    expect(t.clock.callbacks.size).toBe(0)
    await t.cleanup()
  })

  test("a parked status ends the lease; cleanup and session deletion stop every timer", async () => {
    const root = sid("root")
    const t = await start([{ id: root }], { run: ledger().run })
    await t.shell(root, "BEADS_ACTOR=me/main bd update proj-1 --claim", "✓ Claimed proj-1")
    await t.shell(root, "BEADS_ACTOR=me/main bd update proj-2 --claim", "✓ Claimed proj-2")
    expect(t.clock.callbacks.size).toBe(2)
    await t.shell(root, "BEADS_ACTOR=me/main bd update proj-1 --status blocked", "✓ Updated proj-1")
    expect(t.clock.callbacks.size).toBe(1)
    await t.emit("session.deleted", root)
    expect(t.clock.callbacks.size).toBe(0)
    expect(t.fake.storage.get(`leases/${root}`)).toBeUndefined()
    await t.emit("session.execution.started", root)
    expect(t.clock.callbacks.size).toBe(0)
    await t.cleanup()
  })

  test("the heartbeat gate switches renewal off", async () => {
    const root = sid("root")
    const t = await start([{ id: root }], { run: ledger().run }, { gates: { "bd-lease-heartbeat": false } })
    await t.shell(root, "BEADS_ACTOR=me/main bd update proj-1 --claim", "✓ Claimed proj-1")
    expect(t.clock.callbacks.size).toBe(0)
    await t.cleanup()
  })
})

describe("session start", () => {
  test("advisories are frozen into a root session's system text, once", async () => {
    const root = sid("root")
    const child = sid("child")
    let checks = 0
    const t = await start([{ id: root }, { id: child, parentID: root }], {
      run: ledger().run,
      start: {
        hooksAdvisory: () => {
          checks++
          return "Beads appears to have modified a binary Git hook."
        },
      },
    }, { gates: { "binary-git-hooks": true } })
    const request = (sessionID: string) => ({ sessionID, agent: "general", system: [] as Array<{ text: string }> })
    const one = await t.fake.fire.session("context", request(root))
    const two = await t.fake.fire.session("context", request(root))
    expect(one.system).toEqual([{ type: "text", text: "Beads appears to have modified a binary Git hook." }] as never)
    expect(two.system).toEqual(one.system)
    expect(checks).toBe(1)
    const sub = await t.fake.fire.session("context", request(child))
    expect(sub.system).toEqual([])
    await t.cleanup()
  })
})

describe("skills", () => {
  test("registers every shipped skill and removes them on cleanup", async () => {
    const t = await start([], { run: ledger().run })
    expect([...t.fake.skills.keys()].sort()).toEqual([...SKILL_NAMES].sort())
    for (const skill of t.fake.skills.values()) {
      expect(String(skill.content)).not.toMatch(/rule:\/\/|skill:\/\//)
      expect(String(skill.description).length).toBeGreaterThan(20)
    }
    await t.cleanup()
    expect(t.fake.skills.size).toBe(0)
    expect(t.fake.active()).toBe(0)
  })
})
