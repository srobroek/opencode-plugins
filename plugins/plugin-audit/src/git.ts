/** Git queries for the bumps check, run through the lib subprocess supervisor. */

import { supervise } from "../../lib/src/subprocess.ts"

export const GIT_TIMEOUT_MS = 30_000

/** Runs git in `root`; throws when git is lost or times out, and returns null for a clean non-zero exit. */
async function git(root: string, args: string[], signal?: AbortSignal): Promise<{ exit: number; stdout: string } | null> {
  const proc = Bun.spawn(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" })
  const run = await supervise(proc, { timeoutMs: GIT_TIMEOUT_MS, signal })
  if (run.kind === "timeout" || run.kind === "aborted" || run.kind === "lost") {
    throw new Error(`git ${args[0]} did not finish (${run.kind})`)
  }
  return { exit: run.exitCode, stdout: run.stdout }
}

/**
 * Commits that touched plugins/<name> since `tag`, or null when the tag does not exist.
 * Outside a git repository the tag cannot exist, so that counts as missing too.
 */
export async function unreleasedCommits(root: string, name: string, tag: string, signal?: AbortSignal): Promise<number | null> {
  const exists = await git(root, ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}`], signal)
  if (exists === null || exists.exit !== 0) return null
  const log = await git(root, ["log", "--oneline", `${tag}..HEAD`, "--", `plugins/${name}`], signal)
  if (log === null || log.exit !== 0) throw new Error(`git log failed for ${tag}`)
  return log.stdout.split("\n").filter((line) => line.trim() !== "").length
}
