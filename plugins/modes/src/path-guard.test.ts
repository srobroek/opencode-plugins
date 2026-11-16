import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { checkDebugWrite, guardDebugWrite } from "./path-guard.ts"

let home: string
let checkout: string
let worktrees: string

beforeAll(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "modes-path-")))
  worktrees = join(home, ".local/share/opencode/worktree/41bad1")
  checkout = join(worktrees, "subagent-x")
  mkdirSync(join(checkout, "src/debug-y"), { recursive: true })
  mkdirSync(join(worktrees, "debug-foo/src"), { recursive: true })
  mkdirSync(join(home, ".opencode/debug"), { recursive: true })
  mkdirSync(join(home, "repo/src"), { recursive: true })
  symlinkSync(join(home, "repo"), join(worktrees, "debug-foo/link"))
  symlinkSync(join(home, "repo/src"), join(home, ".opencode/debug/escape"))
})
afterAll(() => rmSync(home, { recursive: true, force: true }))

const check = (target: string, startDir = checkout) => checkDebugWrite(target, { home, startDir })

describe("checkDebugWrite", () => {
  test("a file inside a debug-* worktree is allowed", () => {
    expect(check(join(worktrees, "debug-foo/src/a.ts"))).toBeUndefined()
  })
  test("a new file in a debug-* worktree directory that does not exist yet is allowed", () => {
    expect(check(join(worktrees, "debug-foo/new/deep/a.ts"))).toBeUndefined()
  })
  test("the debug ledger directory is allowed", () => {
    expect(check(join(home, ".opencode/debug/20260101-x.md"))).toBeUndefined()
  })
  test("a debug-* directory nested below another lane is refused", () => {
    expect(check(join(checkout, "src/debug-y/f.ts"))).toBeString()
  })
  test("a sibling lane without the debug- prefix is refused", () => {
    expect(check(join(worktrees, "subagent-x/src/a.ts"))).toBeString()
  })
  test("the worktree itself and the hash directory are refused", () => {
    expect(check(join(worktrees, "debug-foo"))).toBeString()
    expect(check(join(worktrees, "a.ts"))).toBeString()
  })
  test("a symlink inside a debug-* worktree that points at the user checkout is refused", () => {
    expect(check(join(worktrees, "debug-foo/link/src/a.ts"))).toBeString()
  })
  test("a symlink in the ledger directory that points elsewhere is refused", () => {
    expect(check(join(home, ".opencode/debug/escape/a.ts"))).toBeString()
  })
  test("a dot-dot path that climbs out of a debug-* worktree is refused", () => {
    expect(check(join(worktrees, "debug-foo/../subagent-x/src/a.ts"))).toBeString()
  })
  test("the starting checkout is refused even when it sits in the allowed area", () => {
    const start = join(worktrees, "debug-foo")
    expect(check(join(start, "src/a.ts"), start)).toBeString()
    expect(check(join(home, "repo/src/a.ts"), join(home, "repo"))).toBeString()
  })
  test("a relative path resolves against the starting directory", () => {
    expect(check("src/a.ts")).toBeString()
  })
})

describe("guardDebugWrite", () => {
  const opts = { home, startDir: join(home, "repo") }
  test("edit, write and patch targets are all checked", () => {
    const ok = join(worktrees, "debug-foo/src/a.ts")
    const bad = join(home, "repo/src/a.ts")
    expect(guardDebugWrite("edit", { path: ok }, "debug", opts)).toBeUndefined()
    expect(guardDebugWrite("write", { path: bad }, "debug", opts)).toBeString()
    const patch = `*** Begin Patch\n*** Add File: ${ok}\n+x\n*** Update File: ${bad}\n*** End Patch`
    expect(guardDebugWrite("patch", { patchText: patch }, "debug", opts)).toBeString()
  })
  test("a write call with no readable target is refused", () => {
    expect(guardDebugWrite("edit", {}, "debug", opts)).toBeString()
    expect(guardDebugWrite("patch", { patchText: "nothing" }, "debug", opts)).toBeString()
  })
  test("other agents and other tools are not guarded", () => {
    expect(guardDebugWrite("edit", { path: join(home, "repo/a.ts") }, "build", opts)).toBeUndefined()
    expect(guardDebugWrite("read", { path: join(home, "repo/a.ts") }, "debug", opts)).toBeUndefined()
  })
})
