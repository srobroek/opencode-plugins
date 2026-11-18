import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { createFakeContext } from "@srobroek/opencode-lib/testing"
import { setupPaceLock } from "./index.ts"
import { stubChecker } from "./testing.ts"

// Each gated call spawns a real shell script; the timeout test waits on a 3 s sleep killed at 300 ms.
setDefaultTimeout(30_000)

const stubs: Array<ReturnType<typeof stubChecker>> = []
const disposers: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose()
  for (const stub of stubs.splice(0)) stub.cleanup()
})

async function load(extra: { env?: Record<string, string>; sessions?: Array<{ id: string; parentID?: string }> } = {}) {
  const stub = stubChecker()
  stubs.push(stub)
  const fake = createFakeContext({ sessions: extra.sessions ?? [{ id: "root" }] })
  const dispose = await setupPaceLock(fake.context as never, {
    env: { PACE_LOCK_BIN: stub.bin, ...extra.env },
    timeoutMs: 300,
  })
  disposers.push(dispose)
  return { stub, fake }
}

const gate = (fake: ReturnType<typeof createFakeContext>, over: Record<string, unknown> = {}) =>
  fake.fire.tool("execute.before", { tool: "shell", sessionID: "root", input: { command: "aws s3 ls customer-a" }, ...over })

const run = (fake: ReturnType<typeof createFakeContext>, text: string, sessionID = "root") =>
  fake.commands.get("pace")?.execute({ sessionID, prompt: { text }, delivery: "queue" } as never)

const said = (fake: ReturnType<typeof createFakeContext>) =>
  fake.calls.filter((c) => c.method === "session.synthetic").map((c) => (c.input as { text: string }).text)

describe("gate", () => {
  test("exit 0 allows, and the checker gets the root, the tool and the args on stdin", async () => {
    const { fake, stub } = await load()
    await gate(fake)
    expect(stub.calls()).toContain("check --harness opencode --root root --tool shell")
    expect(JSON.parse(stub.stdin())).toEqual({ command: "aws s3 ls customer-a" })
  })

  test("exit 2 blocks with the checker's reason", async () => {
    const { fake, stub } = await load()
    stub.set("check_exit", "2")
    stub.set("check_out", "bound to acme, not customer-a\n")
    await expect(gate(fake)).rejects.toThrow("bound to acme, not customer-a")
  })

  test("any other exit code blocks", async () => {
    const { fake, stub } = await load()
    stub.set("check_exit", "1")
    await expect(gate(fake)).rejects.toThrow("exited 1")
  })

  test("a timeout blocks", async () => {
    const { fake, stub } = await load()
    stub.set("check_sleep", "3")
    await expect(gate(fake)).rejects.toThrow("timed out")
  })

  test("a missing binary blocks", async () => {
    const { fake } = await load({ env: { PACE_LOCK_BIN: "/nonexistent/pace-lock" } })
    await expect(gate(fake)).rejects.toThrow("could not run")
  })

  test("args that miss the prefilter skip the checker", async () => {
    const { fake, stub } = await load()
    await gate(fake, { input: { command: "ls" } })
    expect(stub.calls().filter((c) => c.startsWith("check"))).toEqual([])
  })

  test.each(["read", "grep", "glob", "list"])("%s is never checked", async (tool) => {
    const { fake, stub } = await load()
    await gate(fake, { tool })
    expect(stub.calls().filter((c) => c.startsWith("check"))).toEqual([])
  })

  test("an unreadable prefilter checks every call", async () => {
    const { fake, stub } = await load()
    stub.set("prefilter", "(")
    await gate(fake, { input: { command: "ls" } })
    expect(stub.calls().filter((c) => c.startsWith("check"))).toHaveLength(1)
  })
})

describe("child sessions", () => {
  const family = [{ id: "root" }, { id: "kid", parentID: "root" }, { id: "grandkid", parentID: "kid" }]

  test("a nested subagent's call is checked against the root, and the walk is cached", async () => {
    const { fake, stub } = await load({ sessions: family })
    await gate(fake, { sessionID: "grandkid" })
    await gate(fake, { sessionID: "grandkid" })
    await gate(fake, { sessionID: "kid" })
    expect(stub.calls().filter((c) => c.startsWith("check"))).toEqual(Array(3).fill("check --harness opencode --root root --tool shell"))
    expect(fake.calls.filter((c) => c.method === "session.get")).toHaveLength(3)
  })

  test("an unresolvable session fails closed on a prefilter match and passes otherwise", async () => {
    const { fake, stub } = await load({ sessions: [{ id: "root" }] })
    await expect(gate(fake, { sessionID: "ghost" })).rejects.toThrow("cannot resolve")
    await gate(fake, { sessionID: "ghost", input: { command: "ls" } })
    expect(stub.calls().filter((c) => c.startsWith("check"))).toEqual([])
  })

  test("a chain deeper than 10 levels fails closed", async () => {
    const sessions = Array.from({ length: 13 }, (_, i) => ({ id: `s${i}`, ...(i < 12 ? { parentID: `s${i + 1}` } : {}) }))
    const { fake } = await load({ sessions })
    await expect(gate(fake, { sessionID: "s0" })).rejects.toThrow("cannot resolve")
  })
})

describe("/pace", () => {
  test("binds the root of the current session and confirms", async () => {
    const { fake, stub } = await load({ sessions: [{ id: "root" }, { id: "kid", parentID: "root" }] })
    await run(fake, "acme", "kid")
    expect(stub.calls()).toContain("bind --harness opencode --root root acme")
    expect(said(fake)[0]).toContain("bound to acme (account 111122223333, eu-west-1)")
  })

  test("reports the checker's refusal", async () => {
    const { fake, stub } = await load()
    stub.set("bind_error", "already bound to other")
    await run(fake, "acme")
    expect(said(fake)[0]).toBe("PACE lock refused: already bound to other")
  })

  test("off closes the binding", async () => {
    const { fake, stub } = await load()
    await run(fake, "off")
    expect(stub.calls()).toContain("off --harness opencode --root root")
    expect(said(fake)[0]).toContain("closed")
  })

  test("no argument shows the status", async () => {
    const { fake } = await load()
    await run(fake, "")
    expect(said(fake)).toEqual(['{"state":"unbound"}'])
  })

  test("an invalid customer never reaches the checker", async () => {
    const { fake, stub } = await load()
    await run(fake, "--root x")
    expect(stub.calls()).toEqual([])
    expect(said(fake)[0]).toContain("Usage")
  })
})

describe("PACE_LOCK", () => {
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 200 && !check(); i += 1) await Bun.sleep(10)
  }

  test("binds a new root session at creation, and not a child", async () => {
    const { fake, stub } = await load({ env: { PACE_LOCK: "acme" } })
    fake.emit({ type: "session.created", data: { sessionID: "root" } })
    fake.emit({ type: "session.created", data: { sessionID: "kid", parentID: "root" } })
    await until(() => stub.calls().some((c) => c.startsWith("bind")))
    await Bun.sleep(50)
    expect(stub.calls().filter((c) => c.startsWith("bind"))).toEqual(["bind --harness opencode --root root acme"])
  })

  test("a tool call that beats the event binds first, once", async () => {
    const { fake, stub } = await load({ env: { PACE_LOCK: "acme" } })
    await gate(fake)
    fake.emit({ type: "session.created", data: { sessionID: "root" } })
    await Bun.sleep(50)
    const calls = stub.calls()
    expect(calls.filter((c) => c.startsWith("bind"))).toHaveLength(1)
    expect(calls.findIndex((c) => c.startsWith("bind"))).toBeLessThan(calls.findIndex((c) => c.startsWith("check")))
  })

  test("without it nothing binds", async () => {
    const { fake, stub } = await load()
    fake.emit({ type: "session.created", data: { sessionID: "root" } })
    await Bun.sleep(50)
    expect(stub.calls()).toEqual([])
  })
})
