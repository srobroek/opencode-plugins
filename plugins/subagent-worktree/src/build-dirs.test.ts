import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BUILD_DIRS, deleteDetached, detachBuildDirs, freeBuildDirs, isLowDisk, removeBuildDir } from "./build-dirs.ts"
import { spawnRunner } from "./git.ts"

// Real git init and check-ignore: ~0.1 s each alone, several seconds on a loaded machine.
setDefaultTimeout(30_000)

const scratch: string[] = []
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
})

const sh = async (cwd: string, ...argv: string[]) => {
  const result = await spawnRunner(argv, { cwd })
  if (result.code !== 0) throw new Error(`${argv.join(" ")}: ${result.stderr}`)
}

/** A repository with `.gitignore` listing `ignored` and one tracked file under `tracked`. */
async function repo(ignore: string[], tracked: string[] = ["README.md"]): Promise<{ root: string; outside: string }> {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "build-dirs-")))
  scratch.push(base)
  const root = join(base, "lane")
  const outside = join(base, "outside")
  mkdirSync(root)
  mkdirSync(outside)
  writeFileSync(join(outside, "keep.txt"), "x")
  await sh(root, "git", "init", "-q")
  writeFileSync(join(root, ".gitignore"), `${ignore.join("\n")}\n`)
  for (const file of tracked) {
    mkdirSync(join(root, file, ".."), { recursive: true })
    writeFileSync(join(root, file), "x")
  }
  await sh(root, "git", "add", "-A")
  await sh(root, "git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init")
  return { root, outside }
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
    const removed = await removeBuildDir(root, "node_modules/.cache", () => {
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

  test("detaching renames the directory aside inside its parent and deletes nothing yet", async () => {
    const { root } = await repo(["target/"])
    fill(join(root, "target"))
    const detached = await detachBuildDirs(spawnRunner, root)
    expect(detached.map((entry) => entry.rel)).toEqual(["target"])
    const trash = detached[0]?.trash ?? ""
    expect(trash.startsWith(`${root}/.target.cleanup-`)).toBe(true)
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
