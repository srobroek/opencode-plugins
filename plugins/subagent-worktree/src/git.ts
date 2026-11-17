/** The git and wt commands the plugin runs, behind a replaceable runner. */

import { supervise } from "@srobroek/opencode-lib/subprocess"
import { type HeadFacts, isUnbornHead } from "./lane.ts"

export type RunResult = { code: number; stdout: string; stderr: string }
export type Runner = (argv: string[]) => Promise<RunResult>

/**
 * Bound on one git read or ref update. `wt merge` gets none: it runs the repository's
 * merge hooks, and killing it mid-way could leave a half-landed merge.
 */
export const GIT_TIMEOUT_MS = 60_000

export const spawnRunner: Runner = async (argv) => {
  try {
    const child = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" })
    const run = await supervise(child, argv[0] === "git" ? { timeoutMs: GIT_TIMEOUT_MS } : {})
    if (run.kind === "exited") return { code: run.exitCode, stdout: run.stdout, stderr: run.stderr }
    const why = run.kind === "timeout" ? `timed out after ${GIT_TIMEOUT_MS / 1_000}s` : "ended without an exit status"
    return { code: 124, stdout: run.stdout, stderr: `${run.stderr}\n${argv[0]} ${why}`.trim() }
  } catch (error) {
    return { code: 127, stdout: "", stderr: error instanceof Error ? error.message : String(error) }
  }
}

/** Bound on a `gh` query: it may wait on the network, and cleanup must not hang on it. */
export const GH_TIMEOUT_MS = 15_000

/** Run `gh` in `cwd` without a shell. Missing, unauthenticated, offline or slow all come back as a non-zero code. */
export async function spawnGh(args: string[], cwd: string): Promise<RunResult> {
  const env: Record<string, string | undefined> = { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1", GH_NO_UPDATE_NOTIFIER: "1" }
  const bin = Bun.which("gh", { PATH: env.PATH ?? "" })
  if (bin === null) return { code: 127, stdout: "", stderr: "gh is not installed" }
  try {
    const child = Bun.spawn([bin, ...args], { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
    const run = await supervise(child, { timeoutMs: GH_TIMEOUT_MS })
    if (run.kind === "exited") return { code: run.exitCode, stdout: run.stdout, stderr: run.stderr }
    return { code: 124, stdout: run.stdout, stderr: `${run.stderr}\ngh ${run.kind === "timeout" ? "timed out" : "ended without an exit status"}`.trim() }
  } catch (error) {
    return { code: 127, stdout: "", stderr: error instanceof Error ? error.message : String(error) }
  }
}

/** Run a command with `input` on its standard input (for `git patch-id`). */
export async function spawnWithInput(argv: string[], input: string): Promise<RunResult> {
  try {
    const child = Bun.spawn(argv, { stdin: new Blob([input]), stdout: "pipe", stderr: "pipe" })
    const run = await supervise(child, { timeoutMs: GIT_TIMEOUT_MS })
    if (run.kind === "exited") return { code: run.exitCode, stdout: run.stdout, stderr: run.stderr }
    return { code: 124, stdout: run.stdout, stderr: `${argv[0]} ${run.kind}`.trim() }
  } catch (error) {
    return { code: 127, stdout: "", stderr: error instanceof Error ? error.message : String(error) }
  }
}

/** The raw git facts `isUnbornHead` decides on, from one directory. */
async function readHeadFacts(run: Runner, directory: string): Promise<HeadFacts> {
  const out = async (...args: string[]) => {
    const result = await run(["git", "-C", directory, ...args])
    return result.code === 0 ? result.stdout.trim() : undefined
  }
  const head = await out("rev-parse", "--verify", "--quiet", "HEAD^{commit}")
  if (head !== undefined) return { head, symbolic: undefined, refs: undefined }
  return { head, symbolic: await out("symbolic-ref", "--quiet", "HEAD"), refs: await out("for-each-ref", "--count=1") }
}

/** The whole work tree except the Beads ledger directory, whatever subdirectory git runs in. */
export const TRACKED_DIRTY_PATHSPEC = [":(top)", ":(top,exclude).beads"] as const

export function createGit(run: Runner) {
  const git = async (directory: string, ...args: string[]) => {
    const result = await run(["git", "-C", directory, ...args])
    return result.code === 0 ? result.stdout.trim() : undefined
  }
  const files = (output: string | undefined) => output?.split("\0").filter((file) => file !== "")
  return {
    run,
    isWorkTree: async (directory: string) => (await git(directory, "rev-parse", "--is-inside-work-tree")) === "true",
    commit: (directory: string, ref: string) => git(directory, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`),
    /** True in a repository that has no commit yet; false for any other reason HEAD may not resolve. */
    isUnborn: async (directory: string) => isUnbornHead(await readHeadFacts(run, directory)),
    /** The checked-out branch, or undefined on a detached HEAD. */
    branch: (directory: string) => git(directory, "symbolic-ref", "--quiet", "--short", "HEAD"),
    isLocalBranch: async (directory: string, name: string) =>
      (await git(directory, "show-ref", "--verify", "--quiet", `refs/heads/${name}`)) !== undefined,
    createBranch: async (directory: string, name: string) =>
      (await git(directory, "switch", "--quiet", "-c", name)) !== undefined,
    deleteBranch: async (directory: string, name: string) =>
      (await git(directory, "branch", "--quiet", "-d", name)) !== undefined,
    /** Commits on HEAD since `base`, and whether the tree has changes; undefined when git fails. */
    status: async (directory: string, base: string) => {
      const ahead = await git(directory, "rev-list", "--count", `${base}..HEAD`)
      const porcelain = await git(directory, "status", "--porcelain")
      if (ahead === undefined || porcelain === undefined) return undefined
      return { ahead: Number.parseInt(ahead, 10) || 0, dirty: porcelain !== "" }
    },
    /** Files HEAD changes since its merge base with `target`. */
    changedFiles: async (directory: string, target: string) =>
      files(await git(directory, "diff", "--name-only", "-z", `${target}...HEAD`)),
    /**
     * Staged or unstaged tracked changes; untracked files do not affect automatic isolation.
     * The Beads ledger directory is ignored: bd rewrites its tracked export (`.beads/issues.jsonl`)
     * on every write, and a lane does not need the caller's ledger state.
     */
    trackedDirty: async (directory: string) => {
      const changed = await git(directory, "status", "--porcelain", "--untracked-files=no", "--", ...TRACKED_DIRTY_PATHSPEC)
      if (changed === undefined) throw new Error(`subagent-worktree: cannot read tracked changes in ${directory}`)
      return changed !== ""
    },
    /** Uncommitted (staged or not) and untracked files, relative to the work tree root. */
    localFiles: async (directory: string) => {
      const changed = files(await git(directory, "diff", "--name-only", "-z", "HEAD"))
      const untracked = files(await git(directory, "ls-files", "--others", "--exclude-standard", "--full-name", "-z"))
      return changed && untracked ? [...changed, ...untracked] : undefined
    },
    /** `git worktree list --porcelain`. */
    worktrees: (directory: string) => git(directory, "worktree", "list", "--porcelain"),
  }
}

export type Git = ReturnType<typeof createGit>
