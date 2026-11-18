import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { GateAdmitter } from "./gate-admission.ts"
import { FileVerdictCache, PENDING_MS, VERDICT_TTL_MS } from "./gate-verdict-cache.ts"

let root = ""
let store = ""
let now = 1_000_000
const clock = () => now

beforeEach(() => {
  root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "beads-verdicts-"))
  store = join(root, "repo", ".beads")
  mkdirSync(store, { recursive: true })
  now = 1_000_000
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const cache = () => new FileVerdictCache(join(root, "cache"), clock)

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

  test("never stores an unverified verdict", () => {
    const c = cache()
    c.write(store, { verified: false, notice: "store unavailable" })
    expect(c.read(store)).toBeUndefined()
  })

  test("keys verdicts by store", () => {
    const c = cache()
    c.write(store, { verified: true })
    expect(c.read(join(root, "other", ".beads"))).toBeUndefined()
  })

  test.each([
    ["not JSON", "nope"],
    ["a verdict that is not verified", JSON.stringify({ at: 1_000_000, verdict: { verified: false } })],
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
    mkdirSync(join(root, "cache"), { mode: 0o755 })
    chmodSync(join(root, "cache"), 0o755)
    const c = cache()
    c.write(store, { verified: true })
    expect(c.read(store)).toBeUndefined()
    expect(c.claimPending(store)).toBe(false)
  })

  test("a pending claim is exclusive until it expires", () => {
    const c = cache()
    expect(c.claimPending(store)).toBe(true)
    expect(c.claimPending(store)).toBe(false)
    now += PENDING_MS
    expect(c.claimPending(store)).toBe(true)
  })
})

describe("GateAdmitter across processes", () => {
  test("a retry reuses the verdict a slow verification stored, instead of starting over", async () => {
    const shared = cache()
    const first = new GateAdmitter(() => new Promise((done) => setTimeout(() => done({ output: "null" }), 150)), {
      cache: shared,
    })
    const early = await first.admit(join(root, "repo"), {}, false, Date.now() + 30)
    expect(early).toMatchObject({ block: true })
    await Bun.sleep(300)

    const retry = new GateAdmitter(() => new Promise(() => {}), { cache: shared })
    expect(await retry.admit(join(root, "repo"), {}, false, Date.now() + 30)).toEqual({ block: false, notice: undefined })
  })

  test("reports a verification that outlasted the wait so the caller can finish it elsewhere", async () => {
    const calls: string[] = []
    const admitter = new GateAdmitter(() => new Promise(() => {}), { onUnsettled: (_cwd, _env, dir) => calls.push(dir) })
    await admitter.admit(join(root, "repo"), {}, false, Date.now() + 30)
    expect(calls).toEqual([join(root, "repo", ".beads")])
  })

  test("a failed verification is not cached, so the retry verifies again", async () => {
    const shared = cache()
    const failing = new GateAdmitter(async () => ({ failure: "store unavailable" }), { cache: shared })
    expect(await failing.admit(join(root, "repo"), {}, false, Date.now() + 1_000)).toMatchObject({ block: true })
    const retry = new GateAdmitter(async () => ({ output: "null" }), { cache: shared })
    expect(await retry.admit(join(root, "repo"), {}, false, Date.now() + 1_000)).toEqual({ block: false, notice: undefined })
  })
})
