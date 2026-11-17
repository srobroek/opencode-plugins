import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { processAlive, type SupervisedChild, signalName, supervise } from "./subprocess.ts"

// Real child processes and process groups; 30 s leaves headroom for a loaded machine (AGENTS.md, Testing).
setDefaultTimeout(30_000)

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

  test("an event loop stalled past the grace does not call a child lost whose exit is queued", async () => {
    // A loaded machine can deschedule this process for longer than the grace. The child's
    // exit is then already queued when the next poll runs; one late poll must not end it.
    let exit: (code: number) => void = () => {}
    const exited = new Promise<number>((resolve) => {
      exit = resolve
    })
    let polls = 0
    const alive = () => {
      polls++
      if (polls === 2) {
        const until = Date.now() + 60
        while (Date.now() < until) {
          // The stall: no timer or I/O callback runs here.
        }
        exit(0)
      }
      return false
    }
    const run = await supervise(fake({ exited }), { alive, pollMs: 5, graceMs: 20 })
    expect(run.kind).toBe("exited")
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

  test("an abort kills the whole process group, descendants included", async () => {
    const dir = mkdtempSync(join(tmpdir(), "supervise-"))
    const pidFile = join(dir, "pid")
    try {
      const child = Bun.spawn(["/bin/sh", "-c", `sleep 30 & echo $! > "${pidFile}"; wait`], {
        stdout: "pipe",
        stderr: "pipe",
        detached: true,
      })
      const controller = new AbortController()
      const running = supervise(child, { signal: controller.signal, group: true })
      // Abort only once the descendant exists, however slow the machine is.
      while (!existsSync(pidFile) || readFileSync(pidFile, "utf8").trim() === "") await Bun.sleep(10)
      const descendant = Number(readFileSync(pidFile, "utf8").trim())
      expect(processAlive(descendant)).toBe(true)
      controller.abort()
      expect((await running).kind).toBe("aborted")
      // The killed descendant may linger as a zombie for a moment before init reaps it.
      for (let i = 0; i < 100 && processAlive(descendant); i++) await Bun.sleep(20)
      expect(processAlive(descendant)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
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
