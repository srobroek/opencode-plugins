import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createGit, spawnRunner } from "./git.ts"
import { mergeArgs } from "./lane.ts"

// Real git repositories: 1.6 s at load average 49; 30 s leaves headroom for a loaded machine (AGENTS.md, Testing).
setDefaultTimeout(30_000)

describe("createGit().isUnborn on real repositories", () => {
  let root: string
  const git = createGit(spawnRunner)
  const sh = async (cwd: string, ...args: string[]) => {
    const child = Bun.spawn(["git", "-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
      stdout: "ignore",
      stderr: "ignore",
    })
    expect(await child.exited).toBe(0)
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "subagent-worktree-unborn-"))
  })
  afterAll(() => rm(root, { recursive: true, force: true }))

  test("is true after git init and false after the first commit", async () => {
    const repo = join(root, "repo")
    await sh(root, "init", "--quiet", repo)
    expect(await git.isUnborn(repo)).toBe(true)
    expect(await git.commit(repo, "HEAD")).toBeUndefined()
    await sh(repo, "commit", "--quiet", "--allow-empty", "-m", "init")
    expect(await git.isUnborn(repo)).toBe(false)
    expect(await git.commit(repo, "HEAD")).toBeTruthy()
  })

  test("is false outside a repository", async () => {
    const plain = await mkdtemp(join(root, "plain-"))
    expect(await git.isUnborn(plain)).toBe(false)
  })

  test("trackedDirty includes staged and unstaged changes but excludes untracked files", async () => {
    const repo = await mkdtemp(join(root, "dirty-"))
    await sh(repo, "init", "--quiet")
    await writeFile(join(repo, "tracked.txt"), "first")
    await sh(repo, "add", "tracked.txt")
    await sh(repo, "commit", "--quiet", "-m", "init")
    expect(await git.trackedDirty(repo)).toBe(false)
    await writeFile(join(repo, "untracked.txt"), "new")
    expect(await git.trackedDirty(repo)).toBe(false)
    await writeFile(join(repo, "tracked.txt"), "second")
    expect(await git.trackedDirty(repo)).toBe(true)
    await sh(repo, "add", "tracked.txt")
    expect(await git.trackedDirty(repo)).toBe(true)
    await sh(repo, "commit", "--quiet", "-m", "update")
    expect(await git.trackedDirty(repo)).toBe(false)
  })

  test("trackedDirty ignores the tracked Beads export, from any subdirectory", async () => {
    const repo = await mkdtemp(join(root, "beads-"))
    await sh(repo, "init", "--quiet")
    await mkdir(join(repo, ".beads"))
    await mkdir(join(repo, "sub"))
    await writeFile(join(repo, ".beads", "issues.jsonl"), "{}\n")
    await writeFile(join(repo, "sub", "tracked.txt"), "first")
    await writeFile(join(repo, "top.txt"), "first")
    await sh(repo, "add", ".")
    await sh(repo, "commit", "--quiet", "-m", "init")
    await writeFile(join(repo, ".beads", "issues.jsonl"), "{}\n{}\n")
    expect(await git.trackedDirty(repo)).toBe(false)
    expect(await git.trackedDirty(join(repo, "sub"))).toBe(false)
    await writeFile(join(repo, "top.txt"), "second")
    expect(await git.trackedDirty(join(repo, "sub"))).toBe(true)
  })
})

describe("automatic git calls", () => {
  let root: string
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "subagent-worktree-auto-"))
    const init = Bun.spawn(["git", "init", "--quiet", root], { stdout: "ignore", stderr: "ignore" })
    expect(await init.exited).toBe(0)
  })
  afterAll(() => rm(root, { recursive: true, force: true }))

  test("git runs with GIT_NO_LAZY_FETCH=1", async () => {
    // An alias that prints the variable shows what the child sees.
    const result = await spawnRunner(["git", "-C", root, "-c", 'alias.lazy=!printf %s "$GIT_NO_LAZY_FETCH"', "lazy"])
    expect(result.stdout).toBe("1")
  })

  test("changedFiles refuses a target that git would read as an option, and writes no file", async () => {
    const output = join(root, "diff-output")
    expect(await createGit(spawnRunner).changedFiles(root, `--output=${output}`)).toBeUndefined()
    expect(await Bun.file(output).exists()).toBe(false)
  })

  test("unsupported reports git older than 2.45 with the exact message", async () => {
    const old = createGit(async () => ({ code: 0, stdout: "git version 2.44.0\n", stderr: "" }))
    expect(await old.unsupported()).toBe("subagent-worktree needs git 2.45+ for safe automatic merges")
    const current = createGit(async () => ({ code: 0, stdout: "git version 2.45.0\n", stderr: "" }))
    expect(await current.unsupported()).toBeUndefined()
  })
})

// Needs a real worktrunk: it is what reads .config/wt.toml.
describe.skipIf(!Bun.which("wt"))("automatic merge against a repository with a committed wt project hook (CWE-78)", () => {
  let root: string
  const saved: Record<string, string | undefined> = {}
  const sandbox = (name: string) => join(root, name)
  const git = async (cwd: string, ...args: string[]) => {
    const child = Bun.spawn(["git", "-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
      stdout: "ignore",
      stderr: "ignore",
    })
    expect(await child.exited).toBe(0)
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "subagent-worktree-wthook-"))
    // Keep wt's user config and approvals out of the real home.
    for (const [name, value] of Object.entries({
      HOME: sandbox("home"),
      XDG_CONFIG_HOME: sandbox("xdg-config"),
      XDG_DATA_HOME: sandbox("xdg-data"),
      XDG_STATE_HOME: sandbox("xdg-state"),
      WORKTRUNK_CONFIG_PATH: sandbox("wt-config.toml"),
    })) {
      saved[name] = process.env[name]
      process.env[name] = value
    }
  })
  afterAll(async () => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    await rm(root, { recursive: true, force: true })
  })

  test("merges the lane and runs none of the project's hooks", async () => {
    const main = sandbox("main")
    const lane = sandbox("lane")
    const marker = sandbox("hook-ran")
    await mkdir(main, { recursive: true })
    await git(main, "init", "--quiet", "-b", "main")
    await mkdir(join(main, ".config"))
    await writeFile(join(main, ".config", "wt.toml"), `pre-merge = "touch ${marker}"\npre-commit = "touch ${marker}"\npost-merge = "touch ${marker}"\n`)
    await git(main, "add", "-A")
    await git(main, "commit", "--quiet", "-m", "init")
    await git(main, "worktree", "add", "--quiet", "-b", "lane", lane)
    await writeFile(join(lane, "work.txt"), "work")
    await git(lane, "add", "-A")
    await git(lane, "commit", "--quiet", "-m", "work")

    const result = await spawnRunner(mergeArgs(lane, "main"))

    expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: expect.any(String) })
    expect(await Bun.file(join(main, "work.txt")).exists()).toBe(true)
    expect(await Bun.file(marker).exists()).toBe(false)
  })
})
