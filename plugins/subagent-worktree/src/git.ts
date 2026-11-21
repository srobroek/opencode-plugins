/** The git and wt commands the plugin runs, behind a replaceable runner. */

import { existsSync } from "node:fs"
import { DRIVER_KEY_PATTERN, gitVersionProblem, hardenedGitEnv } from "@srobroek/opencode-lib/safe-git"
import { supervise } from "@srobroek/opencode-lib/subprocess"
import { type HeadFacts, isSafeBranchName, isUnbornHead } from "./lane.ts"

export type RunResult = { code: number; stdout: string; stderr: string }
export type Runner = (argv: string[], options?: { cwd?: string }) => Promise<RunResult>

/**
 * Bound on one git read or ref update. `wt merge` gets none: it runs the repository's
 * merge hooks, and killing it mid-way could leave a half-landed merge.
 */
export const GIT_TIMEOUT_MS = 60_000

/** Programs that run git themselves (`wt`, `gh`) get the same hardening as git. */
const GIT_RUNNING_PROGRAMS = new Set(["git", "wt", "gh"])

/** The directory a command runs in: `cwd`, else the `-C` argument, else the current directory. */
function directoryOf(argv: string[], cwd: string | undefined): string {
  const flag = argv.indexOf("-C")
  return cwd ?? (flag > 0 ? argv[flag + 1] : undefined) ?? process.cwd()
}

/**
 * The configured `filter|diff|merge` keys of `directory` and of every worktree of its repository: a command
 * run in the lane (`wt merge`) also runs git in the target checkout, whose own config (`config.worktree`,
 * `includeIf`) can define drivers. A read that fails refuses the command: it never carries on with nothing blanked.
 */
export async function collectDriverKeys(
  directory: string,
  exec: (argv: string[], cwd: string) => Promise<RunResult>,
  exists: (directory: string) => boolean = () => true,
): Promise<string[]> {
  const listed = await exec(["git", "worktree", "list", "--porcelain"], directory)
  if (listed.code !== 0 && !/not a git repository/i.test(listed.stderr)) {
    throw new Error(`subagent-worktree: cannot list the worktrees of ${directory} to check their config (exit ${listed.code}): ${listed.stderr.trim()}`)
  }
  const directories = new Set([directory])
  if (listed.code === 0) {
    // A deleted worktree (marked `prunable`, or locked with its directory gone) has no config to read and runs
    // no git, so it is skipped; reading it would refuse every command, including the prune that clears it.
    for (const record of listed.stdout.split(/\n\n+/)) {
      const lines = record.split("\n")
      const path = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length)
      if (path === undefined || lines.some((line) => line === "prunable" || line.startsWith("prunable "))) continue
      if (path !== directory && !exists(path)) continue
      directories.add(path)
    }
  }
  const reads = await Promise.all(
    [...directories].map(async (dir) => ({ dir, run: await exec(["git", "config", "--name-only", "--get-regexp", DRIVER_KEY_PATTERN], dir) })),
  )
  const keys = new Set<string>()
  for (const { dir, run } of reads) {
    // Exit 1 is "no key matches".
    if (run.code !== 0 && run.code !== 1) {
      throw new Error(`subagent-worktree: cannot read the git config of ${dir} (exit ${run.code}): ${run.stderr.trim()}`)
    }
    for (const key of run.stdout.split("\n")) if (key !== "") keys.add(key)
  }
  return [...keys]
}

/** Runs a read-only git command with the base hardening and no driver overrides. */
async function execBase(argv: string[], cwd: string): Promise<RunResult> {
  const child = Bun.spawn(argv, { cwd, env: hardenedGitEnv(Bun.env), stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const run = await supervise(child, { timeoutMs: GIT_TIMEOUT_MS })
  if (run.kind === "exited") return { code: run.exitCode, stdout: run.stdout, stderr: run.stderr }
  return { code: 124, stdout: run.stdout, stderr: `${run.stderr}\ngit ${run.kind}`.trim() }
}

const readDriverKeys = (directory: string) => collectDriverKeys(directory, execBase, existsSync)

let versionProblem: Promise<string | undefined> | undefined

/** Why the installed git cannot run hardened, or undefined; read once per process. */
function installedGitProblem(): Promise<string | undefined> {
  versionProblem ??= (async () => {
    try {
      const child = Bun.spawn(["git", "--version"], { stdin: "ignore", stdout: "pipe", stderr: "pipe" })
      const run = await supervise(child, { timeoutMs: GIT_TIMEOUT_MS })
      return gitVersionProblem(run.kind === "exited" ? run.stdout : "")
    } catch (error) {
      return `cannot run git: ${error instanceof Error ? error.message : String(error)}`
    }
  })()
  return versionProblem
}

/**
 * Runs a command. `git`, `wt` and `gh` run with the hardening from `hardenedGitEnv` (CWE-78): git then
 * ignores repository-selected filters, textconv and merge drivers, fsmonitor, hooks and signature programs,
 * including the git calls those two make. Too old a git fails closed with code 126.
 */
export const spawnRunner: Runner = async (argv, options) => {
  try {
    let env: Record<string, string> | undefined
    if (GIT_RUNNING_PROGRAMS.has(argv[0] ?? "")) {
      // `git --version` is how the gate reads the version, so it passes.
      const problem = argv.includes("--version") ? undefined : await installedGitProblem()
      if (problem) return { code: 126, stdout: "", stderr: `subagent-worktree: ${problem}` }
      env = hardenedGitEnv(Bun.env, await readDriverKeys(directoryOf(argv, options?.cwd)))
    }
    const child = Bun.spawn(argv, {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      ...(options?.cwd ? { cwd: options.cwd } : {}),
      ...(env ? { env } : {}),
    })
    const run = await supervise(child, argv[0] === "git" ? { timeoutMs: GIT_TIMEOUT_MS } : {})
    if (run.kind === "exited") return { code: run.exitCode, stdout: run.stdout, stderr: run.stderr }
    const why = run.kind === "timeout" ? `timed out after ${GIT_TIMEOUT_MS / 1_000}s` : "ended without an exit status"
    return { code: 124, stdout: run.stdout, stderr: `${run.stderr}\n${argv[0]} ${why}`.trim() }
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
    /** Why the installed git cannot run hardened (too old or unreadable), or undefined. */
    unsupported: async () => {
      const result = await run(["git", "--version"])
      return gitVersionProblem(result.code === 0 ? result.stdout : "")
    },
    /** Whether `name` is a branch name git accepts and no option can be mistaken for it. */
    isBranchName: async (directory: string, name: string) =>
      isSafeBranchName(name) && (await git(directory, "check-ref-format", "--branch", name)) !== undefined,
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
      isSafeBranchName(target) ? files(await git(directory, "diff", "--no-ext-diff", "--name-only", "-z", `${target}...HEAD`)) : undefined,
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
    /** The repository's git common directory (absolute), shared by every worktree; undefined when git fails. */
    commonDir: (directory: string) => git(directory, "rev-parse", "--path-format=absolute", "--git-common-dir"),
    /** HEAD's commit id, or undefined when it does not resolve. */
    head: (directory: string) => git(directory, "rev-parse", "--verify", "--quiet", "HEAD^{commit}"),
    /** The `git status --porcelain` text; undefined when git fails. */
    porcelain: (directory: string) => git(directory, "status", "--porcelain"),
    /** Whether `tip` is an ancestor of `ref` (exit 0). */
    isAncestor: async (directory: string, tip: string, ref: string) =>
      (await run(["git", "-C", directory, "merge-base", "--is-ancestor", tip, ref])).code === 0,
    /** Stash subjects (`%gs`), one per line; undefined when git fails. */
    stashSubjects: (directory: string) => git(directory, "stash", "list", "--format=%gs"),
    /** The worktree's own git directory, absolute. */
    gitDir: (directory: string) => git(directory, "rev-parse", "--absolute-git-dir"),
    /** Delete `refs/heads/<name>` only if it still points at `oid`; a ref that moved fails instead of being deleted. */
    deleteBranchAt: async (directory: string, name: string, oid: string) =>
      (await run(["git", "-C", directory, "update-ref", "-d", `refs/heads/${name}`, oid])).code === 0,
    /** Drop registry entries whose directory is gone. */
    pruneWorktrees: async (directory: string) => (await git(directory, "worktree", "prune")) !== undefined,
    /** `git worktree list --porcelain`. */
    worktrees: (directory: string) => git(directory, "worktree", "list", "--porcelain"),
  }
}

export type Git = ReturnType<typeof createGit>
