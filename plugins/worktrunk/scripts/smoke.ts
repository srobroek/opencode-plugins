/**
 * Live smoke test of the `wt` worktree strategy against a scratch repository.
 * Needs `git` and `wt` on PATH; runs the user's Worktrunk config and hooks.
 *
 *   bun plugins/worktrunk/scripts/smoke.ts
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { operationError } from "../src/index.ts"
import { createStrategy } from "../src/worktree.ts"

const root = realpathSync(mkdtempSync(join(tmpdir(), "worktrunk-smoke-")))
const repo = join(root, "repo")
const git = (...args: string[]) => {
  const result = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`)
  return result.stdout.toString().trim()
}
const log = (step: string, value: unknown) => console.log(`${step}: ${JSON.stringify(value)}`)

git("init", "-q", "-b", "main", repo)
git("-C", repo, "-c", "user.name=smoke", "-c", "user.email=smoke@example.invalid", "commit", "-q", "--allow-empty", "-m", "init")
const head = git("-C", repo, "rev-parse", "HEAD")
log("head", head)

const strategy = createStrategy({ error: operationError })
const { signal } = new AbortController()
const branch = `smoke-${process.pid}`
let created: string | undefined
try {
  const result = await strategy.create({ sourceDirectory: repo, directory: join(root, "suggested", branch) }, { signal })
  created = result.directory
  log("create", result)
  log("create.branch", git("-C", created, "branch", "--show-current"))
  log("create.base", git("-C", created, "rev-parse", "HEAD") === head)
  log("list", await strategy.list(repo, { signal }))

  writeFileSync(join(created, "dirty.txt"), "x\n")
  try {
    await strategy.remove({ directory: created, force: false }, { signal })
    log("remove.dirty", "unexpectedly succeeded")
    process.exitCode = 1
  } catch (error) {
    log("remove.dirty", {
      tag: (error as { _tag?: string })._tag,
      forceRequired: (error as { forceRequired?: boolean }).forceRequired,
      message: (error as Error).message,
    })
  }
  await strategy.remove({ directory: created, force: true }, { signal })
  log("remove.force", "ok")
  log("list.after", await strategy.list(repo, { signal }))
  log("branches.after", git("-C", repo, "branch", "--list"))
  await strategy.remove({ directory: created, force: false }, { signal })
  log("remove.missing", "no-op")
} finally {
  if (created) Bun.spawnSync(["git", "-C", repo, "worktree", "remove", "--force", created], { stderr: "ignore" })
  rmSync(root, { recursive: true, force: true })
}
