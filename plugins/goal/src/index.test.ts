import { describe, expect, test } from "bun:test"
import { tmpdir } from "node:os"
import { createFakeContext, type FakeContext } from "@srobroek/opencode-lib/testing"

import { activeContinuation, CONTINUATION_REGISTRY, GOAL_SOURCE } from "./continuation.ts"
import { createGoal } from "./goal.ts"
import plugin from "./index.ts"

const ROOT = "ses_root"
const settle = (ms = 15) => Bun.sleep(ms)

type Call = { method: string; input: Record<string, unknown> }

const waiters = new WeakMap<FakeContext, Set<() => void>>()

/** Wake `waitFor` callers after every prompt and synthetic message the plugin sends. */
function observe(fake: FakeContext): void {
  const listeners = new Set<() => void>()
  waiters.set(fake, listeners)
  const session = fake.context.session as unknown as Record<string, (input: unknown) => Promise<unknown>>
  for (const method of ["prompt", "synthetic"]) {
    const original = session[method] as (input: unknown) => Promise<unknown>
    session[method] = async (input) => {
      const result = await original(input)
      for (const listener of [...listeners]) listener()
      return result
    }
  }
}

/**
 * Resolve once `predicate` holds, re-checked after each message the plugin sends.
 * For outcomes behind a real subprocess (loop conditions), whose latency a fixed sleep cannot bound.
 */
function waitFor(fake: FakeContext, predicate: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  const listeners = waiters.get(fake)
  if (!listeners) throw new Error("fake context is not observed")
  if (predicate()) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const check = () => {
      if (!predicate()) return
      listeners.delete(check)
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      listeners.delete(check)
      reject(new Error(`timed out waiting for ${label}`))
    }, timeoutMs)
    listeners.add(check)
  })
}

async function start(options: Record<string, unknown> = {}, extra: Parameters<typeof createFakeContext>[0] = {}) {
  const fake = createFakeContext({ directory: tmpdir(), options: { delayMs: 0, ...options }, ...extra })
  observe(fake)
  const cleanup = (await plugin.setup(fake.context)) as () => Promise<void>
  await settle(1)
  return { fake, cleanup }
}

function calls(fake: FakeContext, method: string): Call[] {
  return fake.calls.filter((call) => call.method === method) as Call[]
}

function kinds(fake: FakeContext): string[] {
  return fake.calls
    .filter((call) => call.method === "session.synthetic" || call.method === "session.prompt")
    .map((call) => String(((call.input as Call["input"]).metadata as { kind?: unknown } | undefined)?.kind))
}

function notices(fake: FakeContext): string[] {
  return calls(fake, "session.synthetic")
    .filter((call) => (call.input.metadata as { kind?: unknown }).kind === "notice")
    .map((call) => String(call.input.text))
}

async function run(fake: FakeContext, command: "goal" | "loop", text: string, sessionID = ROOT) {
  const entry = fake.commands.get(command)
  if (!entry) throw new Error(`no /${command}`)
  await (entry.execute as (input: unknown) => Promise<void>)({ sessionID, prompt: { text }, delivery: "queue" })
}

const event = (type: string, data: Record<string, unknown>) => ({ type, data })

/** One agent turn: started, optional tool calls, then the terminal event. */
async function turn(
  fake: FakeContext,
  options: {
    sessionID?: string
    tools?: Array<{ name: string; input: unknown }>
    end?: "succeeded" | "failed" | "interrupted"
    reason?: string
    agent?: string
  } = {},
) {
  const sessionID = options.sessionID ?? ROOT
  fake.emit(event("session.execution.started", { sessionID }))
  fake.emit(event("session.step.started", { sessionID, agent: options.agent ?? "build" }))
  for (const [index, tool] of (options.tools ?? []).entries()) {
    const id = `call_${index}`
    fake.emit(event("session.tool.input.started", { sessionID, id, name: tool.name }))
    fake.emit(event("session.tool.called", { sessionID, id, input: tool.input }))
    fake.emit(event("session.tool.success", { sessionID, id, content: [{ type: "text", text: "ok" }] }))
  }
  const end = options.end ?? "succeeded"
  const data: Record<string, unknown> = { sessionID }
  if (end === "failed") data.error = { type: "api", message: "boom" }
  if (end === "interrupted") data.reason = options.reason ?? "user"
  fake.emit(event(`session.execution.${end}`, data))
  await settle()
}

describe("setup", () => {
  test("registers commands, tools and the compaction hook, and cleans them up", async () => {
    const { fake, cleanup } = await start()
    expect([...fake.commands.keys()].sort()).toEqual(["goal", "loop"])
    expect([...fake.tools.keys()].sort()).toEqual(["goal_complete", "goal_get"])
    expect(fake.hooks("session")).toEqual(["compaction"])
    expect(fake.calls.some((call) => call.method === "event.subscribe")).toBe(true)
    await cleanup()
    expect(fake.active()).toBe(0)
    expect(fake.commands.size).toBe(0)
  })

  test("the tool descriptions and inputs are static", async () => {
    const { fake, cleanup } = await start()
    expect(fake.tools.get("goal_complete")?.input).toMatchObject({ required: ["evidence"] })
    await cleanup()
  })
})

describe("/goal", () => {
  test("starts the goal with the objective and goal context, then continues after each turn", async () => {
    const { fake, cleanup } = await start()
    await run(fake, "goal", "write two files")
    const [first] = calls(fake, "session.prompt")
    expect(first?.input).toMatchObject({ sessionID: ROOT, metadata: { source: GOAL_SOURCE, kind: "goal-start" } })
    expect(String(first?.input.text)).toStartWith("write two files\n\n<goal_context>")
    expect(fake.storage.get(`goal:${ROOT}`)).toMatchObject({ objective: "write two files", status: "active" })
    expect(activeContinuation(ROOT)).toBe("goal")

    await turn(fake, { tools: [{ name: "write", input: { path: "a" } }] })
    const continuation = calls(fake, "session.synthetic").at(-1)
    expect(continuation?.input).toMatchObject({
      sessionID: ROOT,
      description: "Goal: continue #1",
      metadata: { source: GOAL_SOURCE, kind: "goal-continuation", iteration: 1 },
      delivery: "queue",
      resume: true,
    })
    expect(String(continuation?.input.text)).toContain("write two files")

    await turn(fake, { tools: [{ name: "write", input: { path: "b" } }] })
    expect(kinds(fake)).toEqual(["goal-start", "goal-continuation", "goal-continuation"])
    await cleanup()
  })

  test("goal_complete needs evidence and ends continuation", async () => {
    const { fake, cleanup } = await start()
    await run(fake, "goal", "do it")
    const complete = fake.tools.get("goal_complete")?.execute as (input: unknown, ctx: unknown) => Promise<unknown>
    await expect(complete({ evidence: " " }, { sessionID: ROOT })).rejects.toThrow("needs evidence")
    const result = await complete({ evidence: "ls shows both files" }, { sessionID: ROOT })
    expect(result).toMatchObject({ content: expect.stringContaining("Goal complete") })
    expect(fake.storage.get(`goal:${ROOT}`)).toMatchObject({ status: "complete", evidence: "ls shows both files" })
    expect(activeContinuation(ROOT)).toBeUndefined()
    await turn(fake, { tools: [{ name: "goal_complete", input: {} }] })
    expect(kinds(fake)).toEqual(["goal-start"])
    await cleanup()
  })

  test("goal_get reads the goal, also from a subagent", async () => {
    const { fake, cleanup } = await start({}, { sessions: [{ id: "ses_child", parentID: ROOT }] })
    const get = fake.tools.get("goal_get")?.execute as (input: unknown, ctx: unknown) => Promise<{ content: string }>
    expect((await get({}, { sessionID: ROOT })).content).toBe("No goal is set for this session.")
    await run(fake, "goal", "do it")
    expect((await get({}, { sessionID: "ses_child" })).content).toContain("Goal: do it")
    await cleanup()
  })

  test("a continuation turn without tool calls stops auto-continue until the user writes", async () => {
    const { fake, cleanup } = await start()
    await run(fake, "goal", "do it")
    await turn(fake, { tools: [{ name: "read", input: { path: "a" } }] })
    await turn(fake)
    expect(notices(fake).at(-1)).toContain("no tools")
    expect(activeContinuation(ROOT)).toBeUndefined()
    const sent = kinds(fake).length
    await turn(fake, { tools: [{ name: "read", input: { path: "b" } }] })
    expect(kinds(fake).length).toBe(sent)

    fake.emit(event("session.inbox.enqueued", { sessionID: ROOT, item: { type: "user", payload: { text: "go on" } } }))
    await settle()
    await turn(fake, { tools: [{ name: "read", input: { path: "c" } }] })
    expect(kinds(fake).at(-1)).toBe("goal-continuation")
    await cleanup()
  })

  test("two continuation turns with identical activity stop auto-continue", async () => {
    const { fake, cleanup } = await start()
    await run(fake, "goal", "do it")
    const same = [{ name: "read", input: { path: "a" } }]
    await turn(fake, { tools: same })
    await turn(fake, { tools: same })
    await turn(fake, { tools: same })
    expect(notices(fake).at(-1)).toContain("repeated")
    expect(kinds(fake).filter((kind) => kind === "goal-continuation")).toHaveLength(2)
    await cleanup()
  })

  test("Esc pauses the goal; /goal resume continues it", async () => {
    const { fake, cleanup } = await start()
    await run(fake, "goal", "do it")
    await turn(fake, { end: "interrupted", reason: "user" })
    expect(fake.storage.get(`goal:${ROOT}`)).toMatchObject({ status: "paused", pauseReason: "interrupted" })
    expect(notices(fake).at(-1)).toContain("Goal paused")
    expect(kinds(fake)).toEqual(["goal-start", "notice"])

    await run(fake, "goal", "resume")
    await settle()
    expect(kinds(fake).slice(-2)).toEqual(["notice", "goal-continuation"])
    expect(calls(fake, "session.synthetic").at(-2)?.input).toMatchObject({ delivery: "steer", resume: false })
    await cleanup()
  })

  test("an interrupt that is not the user's does not pause", async () => {
    const { fake, cleanup } = await start()
    await run(fake, "goal", "do it")
    await turn(fake, { end: "interrupted", reason: "superseded" })
    expect(fake.storage.get(`goal:${ROOT}`)).toMatchObject({ status: "active" })
    await cleanup()
  })

  test("a failed turn pauses the goal", async () => {
    const { fake, cleanup } = await start()
    await run(fake, "goal", "do it")
    await turn(fake, { end: "failed" })
    expect(fake.storage.get(`goal:${ROOT}`)).toMatchObject({ status: "paused", pauseReason: "turn failed" })
    expect(notices(fake).at(-1)).toContain("boom")
    await cleanup()
  })

  test("real user input cancels a pending continuation", async () => {
    const { fake, cleanup } = await start({ delayMs: 40 })
    await run(fake, "goal", "do it")
    await turn(fake, { tools: [{ name: "read", input: {} }] })
    fake.emit(event("session.inbox.enqueued", { sessionID: ROOT, item: { type: "user", payload: { text: "wait" } } }))
    await settle(60)
    expect(kinds(fake)).toEqual(["goal-start"])
    await cleanup()
  })

  test("our own prompts do not count as user input", async () => {
    const { fake, cleanup } = await start({ delayMs: 40 })
    await run(fake, "goal", "do it")
    await turn(fake, { tools: [{ name: "read", input: {} }] })
    fake.emit(
      event("session.inbox.enqueued", {
        sessionID: ROOT,
        item: { type: "user", payload: { text: "x", metadata: { source: GOAL_SOURCE } } },
      }),
    )
    await settle(60)
    expect(kinds(fake)).toEqual(["goal-start", "goal-continuation"])
    await cleanup()
  })

  test("skips the plan agent", async () => {
    const { fake, cleanup } = await start()
    await run(fake, "goal", "do it")
    await turn(fake, { agent: "plan", tools: [{ name: "read", input: {} }] })
    expect(kinds(fake)).toEqual(["goal-start"])
    await cleanup()
  })

  test("waits for running subagents and background shells", async () => {
    const { fake, cleanup } = await start()
    await run(fake, "goal", "do it")
    fake.emit(event("session.created", { sessionID: "ses_child", parentID: ROOT }))
    fake.emit(event("session.execution.started", { sessionID: "ses_child" }))
    fake.emit(event("session.shell.started", { sessionID: ROOT, shell: { id: "sh_1", status: "running" } }))
    await turn(fake, { tools: [{ name: "task", input: {} }] })
    expect(kinds(fake)).toEqual(["goal-start"])

    fake.emit(event("session.execution.succeeded", { sessionID: "ses_child" }))
    await settle()
    expect(kinds(fake)).toEqual(["goal-start"])
    fake.emit(event("session.shell.ended", { sessionID: ROOT, shell: { id: "sh_1", status: "exited" } }))
    await settle()
    expect(kinds(fake)).toEqual(["goal-start", "goal-continuation"])
    await cleanup()
  })

  test("stops at the continuation cap", async () => {
    const { fake, cleanup } = await start({ maxContinuations: 2 })
    await run(fake, "goal", "do it")
    for (const path of ["a", "b", "c"]) await turn(fake, { tools: [{ name: "read", input: { path } }] })
    expect(kinds(fake).filter((kind) => kind === "goal-continuation")).toHaveLength(2)
    expect(notices(fake).at(-1)).toContain("after 2 continuations")
    await cleanup()
  })

  test("token budget from step.ended, including subagent steps, limits the goal", async () => {
    const { fake, cleanup } = await start({}, { sessions: [{ id: "ses_child", parentID: ROOT }] })
    await run(fake, "goal", "do it")
    await run(fake, "goal", "budget 100")
    const tokens = { input: 40, output: 20, reasoning: 0, cache: { read: 5000, write: 0 } }
    fake.emit(event("session.step.ended", { sessionID: ROOT, cost: 0.01, tokens }))
    await settle()
    expect(fake.storage.get(`goal:${ROOT}`)).toMatchObject({ tokensUsed: 60, status: "active" })
    fake.emit(event("session.step.ended", { sessionID: "ses_child", cost: 0.01, tokens }))
    await settle()
    expect(fake.storage.get(`goal:${ROOT}`)).toMatchObject({ tokensUsed: 120, status: "budget-limited" })
    const steer = calls(fake, "session.synthetic").at(-1)
    expect(steer?.input).toMatchObject({ delivery: "steer", metadata: { kind: "goal-budget-limit" } })
    await turn(fake, { tools: [{ name: "read", input: {} }] })
    expect(kinds(fake).filter((kind) => kind === "goal-continuation")).toHaveLength(0)
    await cleanup()
  })

  test("USD budget", async () => {
    const { fake, cleanup } = await start()
    await run(fake, "goal", "do it")
    await run(fake, "goal", "budget $0.05")
    fake.emit(event("session.step.ended", { sessionID: ROOT, cost: 0.06, tokens: {} }))
    await settle()
    expect(fake.storage.get(`goal:${ROOT}`)).toMatchObject({ status: "budget-limited", costBudget: 0.05 })
    await cleanup()
  })

  test("show, pause, drop and replacing", async () => {
    const { fake, cleanup } = await start()
    await expect(run(fake, "goal", "")).rejects.toThrow("No goal")
    await run(fake, "goal", "first")
    await expect(run(fake, "goal", "second")).rejects.toThrow("already set")
    await run(fake, "goal", "show")
    expect(notices(fake).at(-1)).toContain("first")
    await run(fake, "goal", "pause")
    expect(fake.storage.get(`goal:${ROOT}`)).toMatchObject({ status: "paused" })
    await run(fake, "goal", "set second")
    expect(fake.storage.get(`goal:${ROOT}`)).toMatchObject({ objective: "second", status: "active" })
    await run(fake, "goal", "drop")
    expect(fake.storage.has(`goal:${ROOT}`)).toBe(false)
    expect(activeContinuation(ROOT)).toBeUndefined()
    await cleanup()
  })

  test("refused in a subagent session", async () => {
    const { fake, cleanup } = await start({}, { sessions: [{ id: "ses_child", parentID: ROOT }] })
    await expect(run(fake, "goal", "do it", "ses_child")).rejects.toThrow("top-level session")
    await cleanup()
  })

  test("an active goal is restored paused after a restart", async () => {
    const stored = createGoal("survive restarts", 1, "g1")
    const { fake, cleanup } = await start({}, { storage: { [`goal:${ROOT}`]: stored, "goal:bad": { nope: 1 } } })
    expect(fake.storage.get(`goal:${ROOT}`)).toMatchObject({ status: "paused", pauseReason: "restarted" })
    await turn(fake, { tools: [{ name: "read", input: {} }] })
    expect(kinds(fake)).toEqual([])
    await cleanup()
  })

  test("compaction keeps the objective; other requests are untouched", async () => {
    const { fake, cleanup } = await start()
    const idle = await fake.fire.session("compaction", { sessionID: ROOT, system: [] as unknown[] })
    expect(idle.system).toEqual([])
    await run(fake, "goal", "keep me")
    const fired = await fake.fire.session("compaction", { sessionID: ROOT, system: [] as unknown[] })
    expect(fired.system).toEqual([{ type: "text", text: expect.stringContaining("keep me") }])
    await cleanup()
  })
})

describe("/loop", () => {
  test("repeats an inline prompt up to the count, then disables", async () => {
    const { fake, cleanup } = await start()
    await run(fake, "loop", "2 say hi")
    expect(notices(fake)).toEqual([])
    expect(calls(fake, "session.prompt").at(-1)?.input).toMatchObject({
      text: "say hi",
      metadata: { source: GOAL_SOURCE, kind: "loop", iteration: 0 },
    })
    expect(activeContinuation(ROOT)).toBe("loop")
    await turn(fake)
    await turn(fake)
    await turn(fake)
    expect(calls(fake, "session.prompt").map((call) => (call.input.metadata as { iteration: number }).iteration)).toEqual(
      [0, 1, 2],
    )
    expect(notices(fake).at(-1)).toBe("Loop limit reached. Loop mode disabled.")
    expect(fake.storage.has(`loop:${ROOT}`)).toBe(false)
    await cleanup()
  })

  test("without a prompt, the next user prompt repeats", async () => {
    const { fake, cleanup } = await start()
    await run(fake, "loop", "")
    expect(notices(fake).at(-1)).toContain("Loop mode enabled. Your next prompt will repeat")
    await turn(fake)
    expect(calls(fake, "session.prompt")).toHaveLength(0)
    fake.emit(event("session.inbox.enqueued", { sessionID: ROOT, item: { type: "user", payload: { text: "again" } } }))
    await settle()
    await turn(fake)
    expect(calls(fake, "session.prompt").at(-1)?.input).toMatchObject({ text: "again" })
    await cleanup()
  })

  test("--until stops once the command succeeds", async () => {
    const { fake, cleanup } = await start()
    try {
      await run(fake, "loop", "--until 'exit 0' go")
      await turn(fake)
      await waitFor(fake, () => notices(fake).length > 0, "the --until notice")
      expect(calls(fake, "session.prompt")).toHaveLength(1)
      expect(notices(fake).at(-1)).toContain("is now satisfied")
      expect(fake.storage.has(`loop:${ROOT}`)).toBe(false)
    } finally {
      await cleanup()
    }
  }, 15_000)

  test("--while continues on exit 0 and a broken condition disables the loop", async () => {
    const { fake, cleanup } = await start()
    try {
      await run(fake, "loop", "--while 'true' go")
      await turn(fake)
      await waitFor(fake, () => calls(fake, "session.prompt").length >= 2, "the second --while prompt")
      expect(calls(fake, "session.prompt")).toHaveLength(2)
      await run(fake, "loop", "")
      await run(fake, "loop", "--while 'exit 3' go")
      await turn(fake)
      await waitFor(fake, () => /^Loop condition/.test(notices(fake).at(-1) ?? ""), "the broken-condition notice")
      expect(notices(fake).at(-1)).toContain("failed (exit 3)")
    } finally {
      await cleanup()
    }
  }, 15_000)

  test("Esc suspends the loop; the next prompt resumes it; /loop toggles it off", async () => {
    const { fake, cleanup } = await start()
    await run(fake, "loop", "go")
    await turn(fake, { end: "interrupted" })
    expect(notices(fake).at(-1)).toContain("Loop suspended")
    expect(activeContinuation(ROOT)).toBeUndefined()
    await turn(fake)
    expect(calls(fake, "session.prompt")).toHaveLength(1)
    fake.emit(event("session.inbox.enqueued", { sessionID: ROOT, item: { type: "user", payload: { text: "next" } } }))
    await settle()
    await turn(fake)
    expect(calls(fake, "session.prompt").at(-1)?.input).toMatchObject({ text: "next" })
    await run(fake, "loop", "")
    expect(notices(fake).at(-1)).toBe("Loop mode disabled.")
    await cleanup()
  })

  test("argument errors are reported", async () => {
    const { fake, cleanup } = await start()
    await expect(run(fake, "loop", "--nope")).rejects.toThrow("Unknown /loop flag")
    expect(fake.storage.has(`loop:${ROOT}`)).toBe(false)
    await cleanup()
  })

  test("goal and loop are mutually exclusive", async () => {
    const { fake, cleanup } = await start()
    await run(fake, "goal", "do it")
    await expect(run(fake, "loop", "go")).rejects.toThrow("A goal is set")
    await run(fake, "goal", "drop")
    await run(fake, "loop", "go")
    await expect(run(fake, "goal", "another")).rejects.toThrow("Loop mode is on")
    await cleanup()
  })

  test("a loop is restored paused after a restart", async () => {
    const { fake, cleanup } = await start({}, { storage: { [`loop:${ROOT}`]: { paused: false, prompt: "x", iterations: 1 } } })
    expect(fake.storage.get(`loop:${ROOT}`)).toMatchObject({ paused: true })
    await turn(fake)
    expect(calls(fake, "session.prompt")).toHaveLength(0)
    await cleanup()
  })
})

describe("continuation registry", () => {
  test("is shared through a global symbol", () => {
    const holder = globalThis as { [CONTINUATION_REGISTRY]?: Map<string, string> }
    holder[CONTINUATION_REGISTRY]?.set("ses_other", "goal")
    expect(activeContinuation("ses_other")).toBe("goal")
    holder[CONTINUATION_REGISTRY]?.delete("ses_other")
  })
})
