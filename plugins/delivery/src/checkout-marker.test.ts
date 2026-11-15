import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { commondirValue, gitFileValue, physical, verifyCheckout } from "./checkout-marker.ts"

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

/** `root/common` (the session repository), `root/foreign`, each with a `worktrees/wt` admin directory. */
function layout() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "checkout-marker-")))
  roots.push(root)
  const common = join(root, "common")
  const foreign = join(root, "foreign")
  for (const repo of [common, foreign]) {
    mkdirSync(join(repo, "worktrees", "wt"), { recursive: true })
    writeFileSync(join(repo, "worktrees", "wt", "commondir"), "../..\n")
  }
  const checkout = join(root, "checkout")
  mkdirSync(checkout)
  return { root, common, foreign, checkout }
}

describe("git file values are read the way Git reads them", () => {
  test.each([
    ["gitdir: /abs\n", "/abs"],
    ["gitdir: /abs\r\n", "/abs"],
    ["gitdir: /abs", "/abs"],
    ["gitdir:  /abs\n", " /abs"],
    ["gitdir: rel/path\n", "rel/path"],
  ])("gitdir %j is %j", (text, value) => {
    expect(gitFileValue(text)).toBe(value)
  })

  test.each([["gitdir:/abs\n"], ["gitdir: \n"], ["gitdir: /a\n/b\n"], ["  gitdir: /abs\n"], [""]])(
    "gitdir %j is refused",
    (text) => {
      expect(gitFileValue(text)).toBeNull()
    },
  )

  test.each([
    ["../..\n", "../.."],
    ["../..\r\n", "../.."],
    [" ../..\n", " ../.."],
  ])("commondir %j is %j", (text, value) => {
    expect(commondirValue(text)).toBe(value)
  })
})

describe("verifyCheckout", () => {
  test("accepts a worktree admin directory under the common directory and pins Git to it", () => {
    const { common, checkout } = layout()
    writeFileSync(join(checkout, ".git"), `gitdir: ${join(common, "worktrees", "wt")}\n`)
    expect(verifyCheckout(checkout, common)).toEqual({
      state: "same",
      pin: {
        GIT_DIR: join(common, "worktrees", "wt"),
        GIT_WORK_TREE: checkout,
        GIT_COMMON_DIR: common,
      },
    })
  })

  test("a .. that follows a symlink is resolved through the link, as Git does", () => {
    // Lexically `common/worktrees/lnk/../wt` is the legitimate admin directory; physically the
    // link leads into the other repository, and `..` then climbs out of *its* worktrees directory.
    const { common, foreign, checkout } = layout()
    symlinkSync(join(foreign, "worktrees", "wt"), join(common, "worktrees", "lnk"))
    writeFileSync(join(checkout, ".git"), `gitdir: ${common}/worktrees/lnk/../wt\n`)
    expect(verifyCheckout(checkout, common).state).toBe("foreign")
  })

  test("a relative gitdir is not normalized before the links are followed", () => {
    const { common, foreign, checkout } = layout()
    symlinkSync(join(foreign, "worktrees", "wt"), join(checkout, "lnk"))
    // Lexically `lnk/../../common/worktrees/wt` = `../common/worktrees/wt` = the legitimate one.
    writeFileSync(join(checkout, ".git"), "gitdir: lnk/../../common/worktrees/wt\n")
    expect(verifyCheckout(checkout, common).state).not.toBe("same")
  })

  test("a leading blank makes the gitdir relative, as in Git, and it is not the admin directory it spells", () => {
    const { common, foreign, checkout } = layout()
    const spelled = join(foreign, "worktrees", "wt")
    writeFileSync(join(checkout, ".git"), `gitdir:  ${spelled}\n`)
    // Git resolves ` /abs` under the checkout, where an attacker can make that directory exist.
    mkdirSync(join(checkout, ` ${spelled}`), { recursive: true })
    writeFileSync(join(checkout, ` ${spelled}`, "commondir"), `${common}\n`)
    const verdict = verifyCheckout(checkout, common)
    expect(verdict.state).toBe("unsafe")
  })

  test("a leading blank in commondir is a relative name, not a trimmed one", () => {
    const { common, checkout } = layout()
    const admin = join(common, "worktrees", "wt")
    writeFileSync(join(admin, "commondir"), " ../..\n")
    writeFileSync(join(checkout, ".git"), `gitdir: ${admin}\n`)
    expect(verifyCheckout(checkout, common).state).toBe("unsafe")
  })
})

describe("physical", () => {
  test("a .. after a symlink climbs out of the directory the link led into", () => {
    const { root } = layout()
    mkdirSync(join(root, "deep", "real", "x"), { recursive: true })
    mkdirSync(join(root, "deep", "real", "sub"))
    symlinkSync(join(root, "deep", "real", "sub"), join(root, "lnk"))
    // Lexically `root/lnk/../x` is `root/x`, which does not exist; through the link it is `deep/real/x`.
    expect(physical(`${root}/lnk/../x`)).toBe(join(root, "deep", "real", "x"))
  })

  test("relative and absolute link targets, and chains of links, resolve", () => {
    const { root } = layout()
    mkdirSync(join(root, "a", "b"), { recursive: true })
    symlinkSync("b", join(root, "a", "rel"))
    symlinkSync(join(root, "a", "rel"), join(root, "abs"))
    symlinkSync("abs", join(root, "chain"))
    expect(physical(join(root, "chain"))).toBe(join(root, "a", "b"))
    expect(physical(`${root}/a/./b/../b`)).toBe(join(root, "a", "b"))
  })

  test("a missing component, a link loop and a file used as a directory give null", () => {
    const { root } = layout()
    symlinkSync(join(root, "loop2"), join(root, "loop1"))
    symlinkSync(join(root, "loop1"), join(root, "loop2"))
    writeFileSync(join(root, "file"), "x")
    expect(physical(join(root, "missing"))).toBeNull()
    expect(physical(join(root, "loop1"))).toBeNull()
    expect(physical(join(root, "file", "child"))).toBeNull()
  })

  test.each([
    ["..", "file/../wt"],
    ["/.", "file/."],
    ["a trailing slash", "file/"],
    ["a doubled slash", "file//wt"],
  ])("a regular file followed by %s is not a directory", (_name, rest) => {
    const { root } = layout()
    mkdirSync(join(root, "wt"))
    writeFileSync(join(root, "file"), "x")
    expect(physical(`${root}/${rest}`)).toBeNull()
  })

  test("a symlink to a file followed by .. or a trailing slash is not a directory either", () => {
    const { root } = layout()
    mkdirSync(join(root, "wt"))
    writeFileSync(join(root, "file"), "x")
    symlinkSync(join(root, "file"), join(root, "abs-link"))
    symlinkSync("file", join(root, "rel-link"))
    for (const link of ["abs-link", "rel-link"]) {
      expect(physical(`${root}/${link}/../wt`)).toBeNull()
      expect(physical(`${root}/${link}/`)).toBeNull()
      expect(physical(`${root}/${link}`)).toBe(join(root, "file"))
    }
  })

  test("a link whose target is a file plus a slash is not followed into", () => {
    const { root } = layout()
    writeFileSync(join(root, "file"), "x")
    symlinkSync(`${root}/file/`, join(root, "slashed"))
    expect(physical(join(root, "slashed"))).toBeNull()
  })

  test("a file as the last component resolves", () => {
    const { root } = layout()
    writeFileSync(join(root, "file"), "x")
    expect(physical(join(root, "file"))).toBe(join(root, "file"))
  })

  test("the root is its own parent", () => {
    expect(physical("/..")).toBe("/")
    expect(physical("/")).toBe("/")
  })
})
