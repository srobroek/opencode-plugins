import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { delegatedVerifier, FileVerdictCache, VERDICT_TTL_MS } from "./gate-verdict-cache.ts"

let root = ""
let store = ""
let now = 1_000_000
const clock = () => now

beforeEach(() => {
  root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "beads-verdicts-"))
  store = join(root, "repo", ".beads")
  mkdirSync(store, { recursive: true })
  now = 1_000_000
  live.clear()
  live.add(process.pid)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

/** Pids the tests treat as running. */
const live = new Set<number>()
const cache = () => new FileVerdictCache(join(root, "cache"), clock, (pid) => live.has(pid))

describe("FileVerdictCache", () => {
  test("returns a verified verdict within the TTL and nothing after", () => {
    const c = cache()
    c.write(store, { verified: true, notice: "1 gate open" })
    expect(c.read(store)).toEqual({ verified: true, notice: "1 gate open" })
    now += VERDICT_TTL_MS - 1
    expect(c.read(store)).toEqual({ verified: true, notice: "1 gate open" })
    now += 1
    expect(c.read(store)).toBeUndefined()
  })

  test("returns a failure only as a failure written since a given time", () => {
    const c = cache()
    c.write(store, { verified: true })
    c.write(store, { verified: false, notice: "store unavailable" })
    expect(c.read(store)).toBeUndefined()
    expect(c.failureSince(store, now)).toEqual({ verified: false, notice: "store unavailable" })
    expect(c.failureSince(store, now + 1)).toBeUndefined()
  })

  test("keys verdicts by store", () => {
    const c = cache()
    c.write(store, { verified: true })
    expect(c.read(join(root, "other", ".beads"))).toBeUndefined()
  })

  test.each([
    ["not JSON", "nope"],
    ["a future timestamp", JSON.stringify({ at: 9_000_000, verdict: { verified: true } })],
    ["a missing timestamp", JSON.stringify({ verdict: { verified: true } })],
  ])("ignores a cache file holding %s", (_, contents) => {
    const c = cache()
    c.write(store, { verified: true })
    const dir = join(root, "cache")
    const file = join(dir, readdirSync(dir).find((name) => name.endsWith(".json")) ?? "")
    writeFileSync(file, contents)
    expect(c.read(store)).toBeUndefined()
  })

  test("ignores and does not write to a cache directory other users can reach", () => {
    mkdirSync(join(root, "cache"), { mode: 0o755 }) // check-test-executables: directory permission, not a script
    chmodSync(join(root, "cache"), 0o755) // check-test-executables: directory permission, not a script
    const c = cache()
    c.write(store, { verified: true })
    expect(c.read(store)).toBeUndefined()
    expect(c.claim(store, process.pid)).toBe("unavailable")
  })

  test("a claim is exclusive while its holder lives and passes to a successor", () => {
    const c = cache()
    live.add(41)
    expect(c.claim(store, process.pid)).toBe("claimed")
    expect(c.claim(store, 41)).toBe("busy")
    c.handOver(store, process.pid, 41)
    expect(c.workerAlive(store)).toBe(true)
    c.release(store, process.pid)
    expect(c.workerAlive(store)).toBe(true)
    c.release(store, 41)
    expect(c.workerAlive(store)).toBe(false)
  })

  test("a claim whose holder died can be taken", () => {
    const c = cache()
    expect(c.claim(store, 99)).toBe("claimed")
    expect(c.workerAlive(store)).toBe(false)
    expect(c.claim(store, process.pid)).toBe("claimed")
  })
})

describe("delegatedVerifier", () => {
  const cwd = () => join(root, "repo")

  test("returns a fresh verified verdict without starting a worker", async () => {
    const c = cache()
    c.write(store, { verified: true, notice: "cached" })
    const verify = delegatedVerifier(c, () => {
      throw new Error("no worker expected")
    })
    expect(await verify(cwd(), {}, store)).toEqual({ verified: true, notice: "cached" })
  })

  test("starts one worker and returns the verdict it stores; a second waiter starts none", async () => {
    const c = cache()
    const started: string[] = []
    const verify = delegatedVerifier(
      c,
      (_cwd, _env, dir) => {
        started.push(dir)
        live.add(7)
        return 7
      },
      5,
    )
    const first = verify(cwd(), {}, store)
    const second = verify(cwd(), {}, store)
    await Bun.sleep(20)
    c.write(store, { verified: true })
    c.release(store, 7)
    live.delete(7)
    expect(await first).toEqual({ verified: true })
    expect(await second).toEqual({ verified: true })
    expect(started).toEqual([store])
  })

  test("returns the worker's failure once it is gone", async () => {
    const c = cache()
    const verify = delegatedVerifier(c, () => 8, 5)
    live.add(8)
    const pending = verify(cwd(), {}, store)
    await Bun.sleep(20)
    c.write(store, { verified: false, notice: "bd exited with code 1" })
    live.delete(8)
    expect(await pending).toEqual({ verified: false, notice: "bd exited with code 1" })
  })

  test("refuses when the worker ends without a verdict or cannot start", async () => {
    const c = cache()
    expect(await delegatedVerifier(c, () => 9, 5)(cwd(), {}, store)).toMatchObject({ verified: false })
    expect(await delegatedVerifier(c, () => undefined, 5)(cwd(), {}, store)).toMatchObject({ verified: false })
    expect(c.workerAlive(store)).toBe(false)
  })
})
