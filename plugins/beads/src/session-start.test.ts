import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { consumeLastPush, lastPushNotice, sessionStartAdvisories, storeConflictAdvisory } from "./session-start.ts"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function store(): string {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "beads-start-"))
  roots.push(root)
  mkdirSync(join(root, ".beads"))
  return root
}

describe("lastPushNotice", () => {
  test("a failed verdict is reported with its line", () => {
    const notice = lastPushNotice("started: dbd\nfailed: pre-push rejected; set custom.bd-push-command\n") ?? ""
    expect(notice).toContain("FAILED")
    expect(notice).toContain("custom.bd-push-command")
  })
  test("a surviving start line means the push was cut off", () => {
    expect(lastPushNotice("started: dbd\n")).toContain("did not finish")
  })
  test("a successful verdict says nothing", () => {
    expect(lastPushNotice("started: dbd\nok: pushed 3 commits\n")).toBeUndefined()
    expect(lastPushNotice("")).toBeUndefined()
  })
  test("the verdict is consumed, so it is reported once", () => {
    const beads = join(store(), ".beads")
    writeFileSync(join(beads, "last-push.log"), "started: x\nfailed: rejected\n")
    expect(consumeLastPush(beads)).toContain("FAILED")
    expect(existsSync(join(beads, "last-push.log"))).toBe(false)
    expect(consumeLastPush(beads)).toBeUndefined()
  })
})

describe("storeConflictAdvisory", () => {
  const identity = (cwd: string) => (cwd.startsWith("/a") ? "repo-a" : cwd.startsWith("/b") ? "repo-b" : undefined)
  const pinFor = (cwd: string) => `${cwd}/.beads`

  test("an inherited BEADS_DIR from another repository is named with its fix", () => {
    const text = storeConflictAdvisory("/a/main", { BEADS_DIR: "/b/main/.beads" }, pinFor, identity) ?? ""
    expect(text).toContain("BEADS_DIR=/b/main/.beads")
    expect(text).toContain("Prefix each bd call with BEADS_DIR=/a/main/.beads")
  })
  test("no pin, this checkout's own store, or the same repository is not a conflict", () => {
    expect(storeConflictAdvisory("/a/main", {}, pinFor, identity)).toBeUndefined()
    expect(storeConflictAdvisory("/a/main", { BEADS_DIR: "/a/main/.beads" }, pinFor, identity)).toBeUndefined()
    expect(storeConflictAdvisory("/a/wt", { BEADS_DIR: "/a/main/.beads" }, pinFor, identity)).toBeUndefined()
    expect(storeConflictAdvisory("/c", { BEADS_DIR: "/b/main/.beads" }, () => undefined, identity)).toBeUndefined()
  })
})

describe("sessionStartAdvisories", () => {
  test("hooks, conflict and push verdict, in that order", () => {
    const root = store()
    writeFileSync(join(root, ".beads", "last-push.log"), "started: x\n")
    const advisories = sessionStartAdvisories(root, {
      env: { BEADS_DIR: "/elsewhere/.beads" },
      binaryHooks: true,
      pinFor: (cwd) => join(cwd, ".beads"),
      identity: (cwd) => cwd,
      hooksAdvisory: () => "hooks advisory",
    })
    expect(advisories[0]).toBe("hooks advisory")
    expect(advisories[1]).toContain("BEADS_DIR=/elsewhere/.beads")
    expect(advisories[2]).toContain("did not finish")
  })
  test("the hooks check is skipped when its gate is off, and a clean checkout says nothing", () => {
    const root = store()
    let called = false
    const advisories = sessionStartAdvisories(root, {
      env: {},
      binaryHooks: false,
      hooksAdvisory: () => {
        called = true
        return "x"
      },
    })
    expect(called).toBe(false)
    expect(advisories).toEqual([])
  })
})
