import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { checkDebugWrite, guardDebugWrite, isScratchPath } from "./path-guard.ts"

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
  // dangling: the target does not exist yet
  symlinkSync(join(home, "repo/src/not-yet.ts"), join(worktrees, "debug-foo/dangling.ts"))
  symlinkSync("../../../../../../../repo/src/rel-not-yet.ts", join(worktrees, "debug-foo/src/rel.ts"))
  symlinkSync(join(worktrees, "debug-foo/chain-b"), join(worktrees, "debug-foo/chain-a"))
  symlinkSync(join(home, "repo/src/chained.ts"), join(worktrees, "debug-foo/chain-b"))
  symlinkSync("loop", join(worktrees, "debug-foo/loop"))
  // a scratch symlink into a checkout subdirectory: `up/..` is the checkout, not the scratch worktree
  symlinkSync(join(home, "repo/src"), join(worktrees, "debug-foo/up"))
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
  test("a dangling symlink that points at a checkout file which does not exist yet is refused", () => {
    expect(check(join(worktrees, "debug-foo/dangling.ts"))).toBeString()
  })
  test("a dangling relative symlink is resolved from its own directory", () => {
    expect(check(join(worktrees, "debug-foo/src/rel.ts"))).toBeString()
  })
  test("a chain of symlinks ending in a dangling target is followed", () => {
    expect(check(join(worktrees, "debug-foo/chain-a"))).toBeString()
  })
  test("a symlink loop fails closed", () => {
    expect(check(join(worktrees, "debug-foo/loop"))).toBeString()
  })
  test("dot-dot after a symlink is applied to the link's target, not collapsed lexically", () => {
    expect(check(`${worktrees}/debug-foo/up/../x.ts`)).toBeString()
    expect(check(`${worktrees}/debug-foo/up/../../repo/x.ts`)).toBeString()
  })
  test("dot-dot that stays inside a plain scratch directory is allowed", () => {
    expect(check(`${worktrees}/debug-foo/src/../a.ts`)).toBeUndefined()
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

describe("isScratchPath", () => {
  const scratch = (path: string, startDir = checkout) => isScratchPath(path, { home, startDir })
  test("a debug-* worktree and the files in it are scratch", () => {
    expect(scratch(join(worktrees, "debug-foo"))).toBe(true)
    expect(scratch(join(worktrees, "debug-foo/src/a.ts"))).toBe(true)
  })
  test("dot-dot after a scratch symlink into the checkout is not scratch", () => {
    expect(scratch(`${worktrees}/debug-foo/up/..`)).toBe(false)
    expect(scratch(`${worktrees}/debug-foo/src/..`)).toBe(true)
  })
  test("another lane, a nested debug-* directory, the checkout and a symlink out of the worktree are not", () => {
    expect(scratch(join(worktrees, "subagent-x"))).toBe(false)
    expect(scratch(join(checkout, "src/debug-y"))).toBe(false)
    expect(scratch(join(home, "repo"))).toBe(false)
    expect(scratch(join(worktrees, "debug-foo/link"))).toBe(false)
    expect(scratch(join(worktrees, "debug-foo"), join(worktrees, "debug-foo"))).toBe(false)
  })
})

describe("guardDebugWrite", () => {
  const options = () => ({ home, startDir: join(home, "repo") })
  test("edit, write and patch targets are all checked", () => {
    const ok = join(worktrees, "debug-foo/src/a.ts")
    const bad = join(home, "repo/src/a.ts")
    expect(guardDebugWrite("edit", { path: ok }, "debug", options())).toBeUndefined()
    expect(guardDebugWrite("write", { path: bad }, "debug", options())).toBeString()
    const patch = `*** Begin Patch\n*** Add File: ${ok}\n+x\n*** Update File: ${bad}\n*** End Patch`
    expect(guardDebugWrite("patch", { patchText: patch }, "debug", options())).toBeString()
  })
  test("a write call with no readable target is refused", () => {
    expect(guardDebugWrite("edit", {}, "debug", options())).toBeString()
    expect(guardDebugWrite("patch", { patchText: "nothing" }, "debug", options())).toBeString()
  })
  test("other agents and other tools are not guarded", () => {
    expect(guardDebugWrite("edit", { path: join(home, "repo/a.ts") }, "build", options())).toBeUndefined()
    expect(guardDebugWrite("read", { path: join(home, "repo/a.ts") }, "debug", options())).toBeUndefined()
  })
})
