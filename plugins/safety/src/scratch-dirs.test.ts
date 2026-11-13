import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { allowScratch, scratchRoots } from "./scratch-dirs.ts"

const base = join(realpathSync(tmpdir()), "opencode")
let dir: string
let roots: string[]
let temp: string
let own: string
let other: string

beforeAll(() => {
  mkdirSync(base, { recursive: true })
  dir = mkdtempSync(join(base, "scratch-"))
  temp = join(dir, "tmp/opencode")
  own = join(dir, "data/opencode/worktree/41bad1")
  other = join(dir, "data/opencode/worktree/ffffff")
  for (const path of [temp, own, other, join(dir, "tmp/other-user")]) mkdirSync(path, { recursive: true })
  roots = [temp, own]
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const evaluation = (resources: string[], effect = "ask", action = "external_directory") => ({ action, resources, effect })

describe("scratchRoots", () => {
  test("names the temp folder and the project's worktree folder from the first six characters of the project id", () => {
    expect(
      scratchRoots("41bad135688c6b4d51e3ed10b0d2ed0ee58e94e2", { home: "/h", temp: "/t", env: {} }),
    ).toEqual(["/t/opencode", "/h/.local/share/opencode/worktree/41bad1"])
  })

  test("follows XDG_DATA_HOME", () => {
    expect(scratchRoots("41bad135688c", { home: "/h", temp: "/t", env: { XDG_DATA_HOME: "/x" } })[1]).toBe(
      "/x/opencode/worktree/41bad1",
    )
  })
})

describe("allowScratch", () => {
  test("allows a path in the temp folder", () => {
    const e = evaluation([`${temp}/pack.xml`])
    allowScratch(e, roots)
    expect(e.effect).toBe("allow")
  })

  test("allows a directory pattern in the project's own worktree folder", () => {
    const e = evaluation([`${own}/lane-1/*`])
    allowScratch(e, roots)
    expect(e.effect).toBe("allow")
  })

  test("leaves another project's worktree folder asking", () => {
    const e = evaluation([`${other}/lane-1/src`])
    allowScratch(e, roots)
    expect(e.effect).toBe("ask")
  })

  test("leaves another user's temp folder asking", () => {
    const e = evaluation([join(dir, "tmp/other-user/opencode/x")])
    allowScratch(e, roots)
    expect(e.effect).toBe("ask")
  })

  test("leaves a sibling whose name starts with the folder name asking", () => {
    const e = evaluation([`${temp}-evil/x`])
    allowScratch(e, roots)
    expect(e.effect).toBe("ask")
  })

  test("leaves a path that climbs out with .. asking", () => {
    const e = evaluation([`${temp}/../other-user/x`])
    allowScratch(e, roots)
    expect(e.effect).toBe("ask")
  })

  test("leaves a symlink out of the folder asking", () => {
    symlinkSync(join(dir, "tmp/other-user"), join(temp, "link"))
    const e = evaluation([`${temp}/link/secret`])
    allowScratch(e, roots)
    expect(e.effect).toBe("ask")
  })

  test("leaves the call asking when one resource is outside", () => {
    const e = evaluation([`${temp}/a`, "/etc/passwd"])
    allowScratch(e, roots)
    expect(e.effect).toBe("ask")
  })

  test("leaves a relative path and a wildcard in the middle asking", () => {
    for (const resource of ["opencode/x", `${temp}/*/x`, "*"]) {
      const e = evaluation([resource])
      allowScratch(e, roots)
      expect(e.effect).toBe("ask")
    }
  })

  test("never changes a deny", () => {
    const e = evaluation([`${temp}/a`], "deny")
    allowScratch(e, roots)
    expect(e.effect).toBe("deny")
  })

  test("never touches another action", () => {
    const e = evaluation([`${temp}/a`], "ask", "edit")
    allowScratch(e, roots)
    expect(e.effect).toBe("ask")
  })

  test("leaves a call with no resources asking", () => {
    const e = evaluation([])
    allowScratch(e, roots)
    expect(e.effect).toBe("ask")
  })
})
