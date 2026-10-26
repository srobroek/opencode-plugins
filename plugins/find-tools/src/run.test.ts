import { describe, expect, test } from "bun:test"
import { defaultRun, OUTPUT_LIMIT_BYTES } from "./run.ts"

// Real subprocess deadlines and inherited pipes cannot be exercised with fake timers.
describe("bounded discovery subprocesses", () => {
  test("returns stdout of a successful command", async () => {
    const result = await defaultRun([process.execPath, "-e", 'process.stdout.write("hi")'], 5000)
    expect(result).toEqual({ ok: true, stdout: "hi", stderr: "" })
  })

  test("kills a SIGTERM-resistant command at the deadline", async () => {
    const started = Date.now()
    const result = await defaultRun(
      [
        process.execPath,
        "-e",
        'process.on("SIGTERM", () => {}); setInterval(() => {}, 10); setTimeout(() => process.exit(), 3000);',
      ],
      150,
    )
    expect(result.ok).toBe(false)
    expect(result.stderr).toMatch(/deadline/i)
    expect(Date.now() - started).toBeLessThan(1800)
  })

  test("bounds shared stdout and stderr collection", async () => {
    const half = OUTPUT_LIMIT_BYTES / 2 + 4096
    const result = await defaultRun(
      [process.execPath, "-e", `process.stdout.write("x".repeat(${half})); process.stderr.write("y".repeat(${half}));`],
      5000,
    )
    expect(result.ok).toBe(false)
    expect(result.stderr).toMatch(/output limit/i)
    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeLessThan(OUTPUT_LIMIT_BYTES + 200)
  })

  test("closes pipes held by a detached descendant after its parent exits", async () => {
    const started = Date.now()
    const result = await defaultRun(
      [
        process.execPath,
        "-e",
        `const {spawn} = require("node:child_process"); const p = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(), 3000)"], {detached:true, stdio:["ignore",1,2]}); p.unref();`,
      ],
      150,
    )
    expect(result.ok).toBe(false)
    expect(result.stderr).toMatch(/deadline/i)
    expect(Date.now() - started).toBeLessThan(1800)
  })

  test("cancellation interrupts a running command and prevents later spawns", async () => {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 100)
    const started = Date.now()
    try {
      const result = await defaultRun([process.execPath, "-e", "setTimeout(() => {}, 3000)"], 5000, ac.signal)
      expect(result.ok).toBe(false)
      expect(result.stderr).toMatch(/cancelled/i)
      expect(Date.now() - started).toBeLessThan(1800)
      expect(await defaultRun([process.execPath, "-e", ""], 5000, ac.signal)).toEqual({
        ok: false,
        stdout: "",
        stderr: "Cancelled before spawn",
      })
    } finally {
      clearTimeout(timer)
    }
  })

  test("a missing binary fails without throwing", async () => {
    const result = await defaultRun(["definitely-not-a-binary-find-tools"], 1000)
    expect(result.ok).toBe(false)
    expect(result.stderr).toMatch(/failed to start/)
  })
})
