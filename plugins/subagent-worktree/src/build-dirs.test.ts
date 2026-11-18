import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { adminTrashDir, BUILD_DIRS, deleteDetached, detachBuildDirs, freeBuildDirs, isLowDisk, removeBuildDir, TRASH_DIR } from "./build-dirs.ts"
import { spawnRunner } from "./git.ts"

// Real git init and check-ignore: ~0.1 s each alone, several seconds on a loaded machine.
setDefaultTimeout(30_000)

const scratch: string[] = []
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
})

const sh = async (cwd: string, ...argv: string[]): Promise<string> => {
  const result = await spawnRunner(argv, { cwd })
  if (result.code !== 0) throw new Error(`${argv.join(" ")}: ${result.stderr}`)
  return result.stdout.trim()
}

/**
 * A repository with `.gitignore` listing `ignore` and the files `tracked`, and a linked worktree of it
 * (`root`), the shape of a lane. `main` is the main checkout, whose git directory is the common one.
 */
async function repo(ignore: string[], tracked: string[] = ["README.md"]): Promise<{ root: string; main: string; outside: string; gitDir: string }> {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "build-dirs-")))
  scratch.push(base)
  const main = join(base, "main")
  const root = join(base, "lane")
  const outside = join(base, "outside")
  mkdirSync(main)
  mkdirSync(outside)
  writeFileSync(join(outside, "keep.txt"), "x")
  await sh(main, "git", "init", "-q")
  writeFileSync(join(main, ".gitignore"), `${ignore.join("\n")}\n`)
  for (const file of tracked) {
    mkdirSync(join(main, file, ".."), { recursive: true })
    writeFileSync(join(main, file), "x")
  }
  await sh(main, "git", "add", "-A")
  await sh(main, "git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init")
  await sh(main, "git", "worktree", "add", "-q", "-b", "lane", root)
  return { root, main, outside, gitDir: await sh(root, "git", "rev-parse", "--absolute-git-dir") }
}
const fill = (dir: string) => {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "f"), "x")
}

describe("freeBuildDirs", () => {
  test("frees an ignored build directory, including a nested allow-listed one", async () => {
    const { root } = await repo(["target/", "node_modules/"])
    fill(join(root, "target"))
    fill(join(root, "node_modules/.cache"))
    expect((await freeBuildDirs(spawnRunner, root)).sort()).toEqual(["node_modules/.cache", "target"])
    expect(existsSync(join(root, "target"))).toBe(false)
    expect(existsSync(join(root, "node_modules/.cache"))).toBe(false)
    expect(existsSync(join(root, "node_modules"))).toBe(true)
  })

  test("keeps an allow-listed directory that git does not ignore", async () => {
    const { root } = await repo(["other/"])
    fill(join(root, "dist"))
    expect(await freeBuildDirs(spawnRunner, root)).toEqual([])
    expect(existsSync(join(root, "dist/f"))).toBe(true)
  })

  test("keeps an ignored directory that holds a tracked file", async () => {
    const { root } = await repo(["build/"], ["README.md"])
    fill(join(root, "build"))
    await sh(root, "git", "add", "-f", "build/f")
    expect(await freeBuildDirs(spawnRunner, root)).toEqual([])
    expect(existsSync(join(root, "build/f"))).toBe(true)
  })

  test("keeps a directory outside the allow list even when ignored", async () => {
    const { root } = await repo(["data/"])
    fill(join(root, "data"))
    expect(await freeBuildDirs(spawnRunner, root)).toEqual([])
    expect(existsSync(join(root, "data/f"))).toBe(true)
  })

  test("does not follow a symlink that leads out of the worktree", async () => {
    const { root, outside } = await repo(["target"])
    symlinkSync(outside, join(root, "target"))
    expect(await freeBuildDirs(spawnRunner, root)).toEqual([])
    expect(existsSync(join(outside, "keep.txt"))).toBe(true)
    expect(existsSync(join(root, "target"))).toBe(true)
  })

  test("does not follow a parent component swapped for a link before the rename", async () => {
    const { root, outside } = await repo(["node_modules/"])
    mkdirSync(join(outside, ".cache"))
    writeFileSync(join(outside, ".cache", "keep.txt"), "x")
    fill(join(root, "node_modules/.cache"))
    const trashDir = await adminTrashDir(spawnRunner, root)
    if (trashDir === undefined) throw new Error("no trash directory")
    const removed = await removeBuildDir(root, "node_modules/.cache", trashDir, () => {
      rmSync(join(root, "node_modules"), { recursive: true })
      symlinkSync(outside, join(root, "node_modules"))
    })
    expect(removed).toBe(false)
    expect(existsSync(join(outside, ".cache", "keep.txt"))).toBe(true)
  })

  test("a link inside a freed directory is removed, never followed", async () => {
    const { root, outside } = await repo(["target/"])
    fill(join(root, "target"))
    symlinkSync(outside, join(root, "target", "link"))
    expect(await freeBuildDirs(spawnRunner, root)).toEqual(["target"])
    expect(existsSync(join(outside, "keep.txt"))).toBe(true)
  })

  test("detaching moves the directory into the worktree's own git directory and deletes nothing yet", async () => {
    const { root, gitDir } = await repo(["target/"])
    fill(join(root, "target"))
    const detached = await detachBuildDirs(spawnRunner, root)
    expect(detached.map((entry) => entry.rel)).toEqual(["target"])
    const trash = detached[0]?.trash ?? ""
    expect(trash.startsWith(`${join(gitDir, TRASH_DIR)}/target-`)).toBe(true)
    expect(existsSync(join(trash, "f"))).toBe(true)
    expect(existsSync(join(root, "target"))).toBe(false)
    expect(await deleteDetached(detached[0] as never)).toBe(true)
    expect(existsSync(trash)).toBe(false)
  })

  test("a detached directory swapped for a link before the delete is left alone", async () => {
    const { root, outside } = await repo(["target/"])
    fill(join(root, "target"))
    const [detached] = await detachBuildDirs(spawnRunner, root)
    if (detached === undefined) throw new Error("nothing detached")
    rmSync(detached.trash, { recursive: true })
    symlinkSync(outside, detached.trash)
    expect(await deleteDetached(detached)).toBe(false)
    expect(existsSync(join(outside, "keep.txt"))).toBe(true)
  })

  test("while the detached directory is deleted, git sees nothing to add and a rebuilt directory survives", async () => {
    const { root } = await repo(["target/"])
    fill(join(root, "target"))
    const [detached] = await detachBuildDirs(spawnRunner, root)
    if (detached === undefined) throw new Error("nothing detached")
    expect(await sh(root, "git", "status", "--porcelain", "--untracked-files=all")).toBe("")
    fill(join(root, "target", "rebuilt"))
    await sh(root, "git", "add", "-A")
    expect(await sh(root, "git", "diff", "--cached", "--name-only")).toBe("")
    expect(await deleteDetached(detached)).toBe(true)
    expect(existsSync(join(root, "target", "rebuilt", "f"))).toBe(true)
    expect(await sh(root, "git", "status", "--porcelain", "--untracked-files=all")).toBe("")
  })

  test("the main checkout is skipped: its git directory is the one every worktree shares", async () => {
    const { main } = await repo(["target/"])
    fill(join(main, "target"))
    expect(await adminTrashDir(spawnRunner, main)).toBeUndefined()
    expect(await freeBuildDirs(spawnRunner, main)).toEqual([])
    expect(existsSync(join(main, "target", "f"))).toBe(true)
  })

  test("a git directory that does not point back at this worktree is skipped", async () => {
    const { root, gitDir, outside } = await repo(["target/"])
    fill(join(root, "target"))
    writeFileSync(join(gitDir, "gitdir"), `${join(outside, ".git")}\n`)
    expect(await freeBuildDirs(spawnRunner, root)).toEqual([])
    expect(existsSync(join(root, "target", "f"))).toBe(true)
  })

  test("a trash directory that is a link is not used", async () => {
    const { root, gitDir, outside } = await repo(["target/"])
    fill(join(root, "target"))
    symlinkSync(outside, join(gitDir, TRASH_DIR))
    expect(await freeBuildDirs(spawnRunner, root)).toEqual([])
    expect(existsSync(join(root, "target", "f"))).toBe(true)
    expect(readdirSync(outside)).toEqual(["keep.txt"])
  })

  test("a leftover from an interrupted delete is picked up by the next pass", async () => {
    const { root, gitDir } = await repo(["target/"])
    fill(join(gitDir, TRASH_DIR, "target-left0ver"))
    const detached = await detachBuildDirs(spawnRunner, root)
    expect(detached.map((entry) => entry.trash)).toEqual([join(gitDir, TRASH_DIR, "target-left0ver")])
    for (const entry of detached) expect(await deleteDetached(entry)).toBe(true)
    expect(readdirSync(join(gitDir, TRASH_DIR))).toEqual([])
  })

  test("a leftover never blocks removing the worktree, and goes with it", async () => {
    const { root, main, gitDir } = await repo(["target/"])
    fill(join(gitDir, TRASH_DIR, "target-left0ver"))
    await sh(main, "git", "worktree", "remove", root)
    expect(existsSync(gitDir)).toBe(false)
  })

  test("the allow list names no source or top-level dependency directory", () => {
    expect(BUILD_DIRS).not.toContain("src")
    expect(BUILD_DIRS).not.toContain(".git")
    expect(BUILD_DIRS).not.toContain("node_modules")
  })
})

describe("isLowDisk", () => {
  test.each([
    [500, 1000, true],
    [1000, 1000, false],
    [2000, 1000, false],
    [undefined, 1000, false],
    [0, 0, false],
  ] as const)("free %p against %p is %p", (free, threshold, low) => {
    expect(isLowDisk(free, threshold)).toBe(low)
  })
})
