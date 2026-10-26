import { describe, expect, test } from "bun:test"

import { processAlive, type SupervisedChild, signalName, supervise } from "./subprocess.ts"

const never = new Promise<number>(() => {})

function stream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    },
  })
}

function fake(overrides: Partial<SupervisedChild> = {}): SupervisedChild & { kills: unknown[] } {
  const kills: unknown[] = []
  return { pid: 999_999, exited: never, kill: (signal) => kills.push(signal), kills, ...overrides }
}

describe("supervise", () => {
  test("reports the exit status and both pipes", async () => {
    const child = Bun.spawn(["/bin/sh", "-c", "echo out; echo err >&2; exit 3"], { stdout: "pipe", stderr: "pipe" })
    expect(await supervise(child, { timeoutMs: 10_000 })).toEqual({
      kind: "exited",
      exitCode: 3,
      signalCode: null,
      stdout: "out\n",
      stderr: "err\n",
    })
  })

  test("a child that vanished without an exit event is lost, not awaited forever", async () => {
    const child = fake({ stdout: stream("partial") })
    const started = Date.now()
    const run = await supervise(child, { alive: () => false, pollMs: 5, graceMs: 20 })
    expect(run).toEqual({ kind: "lost", stdout: "partial", stderr: "" })
    expect(Date.now() - started).toBeLessThan(1_000)
    // The pid may already belong to another process.
    expect(child.kills).toEqual([])
  })

  test("a real child whose exit event never arrives resolves once Bun has reaped it", async () => {
    const real = Bun.spawn(["/bin/sh", "-c", "echo hi"], { stdout: "pipe", stderr: "pipe" })
    await real.exited
    const child: SupervisedChild = { pid: real.pid, exited: never, stdout: real.stdout, kill: (s) => real.kill(s) }
    expect(processAlive(real.pid)).toBe(false)
    expect(await supervise(child, { pollMs: 5, graceMs: 20 })).toEqual({ kind: "lost", stdout: "hi\n", stderr: "" })
  })

  test("the deadline resolves even when the killed child's exit is never reported", async () => {
    const child = fake()
    const run = await supervise(child, { timeoutMs: 10, graceMs: 10, alive: () => true })
    expect(run.kind).toBe("timeout")
    expect(child.kills).toEqual(["SIGKILL"])
  })

  test("an abort kills the process group and reports the abort", async () => {
    const child = Bun.spawn(["/bin/sh", "-c", "sleep 30 & wait"], { stdout: "pipe", stderr: "pipe", detached: true })
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 20)
    const started = Date.now()
    expect((await supervise(child, { signal: controller.signal, group: true })).kind).toBe("aborted")
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  test("a descendant holding the pipes past the deadline cannot hold the call open", async () => {
    const child = Bun.spawn(["/bin/sh", "-c", "sleep 30 &"], { stdout: "pipe", stderr: "pipe", detached: true })
    const run = await supervise(child, { timeoutMs: 100, graceMs: 50, group: true })
    expect(run.kind).toBe("timeout")
  })

  test("an already-aborted signal ends the child at once", async () => {
    const controller = new AbortController()
    controller.abort()
    const child = fake()
    expect((await supervise(child, { signal: controller.signal, graceMs: 0, alive: () => true })).kind).toBe(
      "aborted",
    )
    expect(child.kills).toEqual(["SIGKILL"])
  })
})

describe("signalName", () => {
  test("keeps names, maps numbers to names and passes null through", () => {
    expect(signalName("SIGTERM")).toBe("SIGTERM")
    expect(signalName(9)).toBe("SIGKILL")
    expect(signalName(null)).toBeNull()
    expect(signalName(undefined)).toBeNull()
  })
})
