/**
 * Dynamic branch check for the `debug` agent.
 *
 * Linked worktrees share branches. If the scratch worktree is on a branch the user owns (for example
 * `main`, put there with `git checkout --ignore-other-worktrees main`), a commit made in scratch moves
 * that branch for the user's checkout too. Before a mutating git command runs, ask git which ref
 * HEAD names and allow the command only for a detached HEAD or a `debug-*` / `debug/*` branch.
 */

import { execFile } from "node:child_process"

export type HeadRun = (cwd: string) => Promise<{ code: number; stdout: string }>

/** Plain read-only git with a minimal environment: no user or system config, no hooks, no fsmonitor. */
const runSymbolicRef: HeadRun = (cwd) =>
  new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "symbolic-ref", "-q", "HEAD"],
      {
        cwd,
        timeout: 10_000,
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          LC_ALL: "C",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_OPTIONAL_LOCKS: "0",
        },
      },
      (error, stdout) => {
        const code = (error as (Error & { code?: unknown }) | null)?.code
        if (error === null) resolve({ code: 0, stdout: String(stdout) })
        else if (code === 1) resolve({ code: 1, stdout: String(stdout) })
        else reject(error)
      },
    )
  })

/** Why a mutating git command must not run in `workdir`, or undefined when HEAD is detached or on a debug branch. */
export async function headRefusal(workdir: string | undefined, run: HeadRun = runSymbolicRef): Promise<string | undefined> {
  if (workdir === undefined) return "the shell workdir is unknown, so the checked-out branch cannot be read"
  try {
    const { code, stdout } = await run(workdir)
    if (code === 1) return undefined
    const ref = stdout.trim()
    if (/^refs\/heads\/debug[-/]./.test(ref)) return undefined
    return `the worktree is on ${ref || "an unreadable HEAD"}, a branch the user may own; run git switch --detach or git switch -c debug/<slug> first, in its own call`
  } catch (error) {
    return `the checked-out branch could not be read (${(error as Error).message}), so the command is refused`
  }
}
