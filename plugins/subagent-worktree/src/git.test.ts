import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createGit, spawnRunner } from "./git.ts"

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
})
