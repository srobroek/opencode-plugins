/**
 * The `speckit_commit` tool: commit SpecKit artifacts without a shell `git add` or
 * `git commit`, whose whole-command permission patterns cannot keep operands or options
 * in bounds. It builds the commit in a private index (HEAD plus the requested artifact
 * paths), checks the resulting tree holds changes only under the workspace's `specs/` and
 * `.specify/`, and commits exactly that tree with plumbing and hooks off: no hook runs, so nothing can
 * join the commit after the check, and HEAD moves only from the commit it was built on.
 * It never amends.
 */

import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, posix, resolve } from "node:path"
import type { ToolOutput } from "./tools.ts"

export const COMMIT_TOOL = "speckit_commit"

export const COMMIT_DESCRIPTION =
  "Commit SpecKit artifacts: stages only specs/ and .specify/, refuses other staged files, never amends.\n" +
  "Paths are relative to the SpecKit workspace and default to specs/ and .specify/. Refuses when a requested path lies outside them or the index already holds other files. Commits the checked working-tree snapshot of those paths on top of HEAD. No git hook of any kind runs (pre-commit, commit-msg, reference-transaction, post-index-change), so run the project's checks separately."

export const COMMIT_INPUT = {
  type: "object",
  properties: {
    message: { type: "string", minLength: 1, description: "Commit message" },
    paths: {
      type: "array",
      items: { type: "string" },
      description: "Paths under specs/ or .specify/; default both",
    },
  },
  required: ["message"],
  additionalProperties: false,
} as const

/** Each git command's bound; a signing prompt cannot hold the tool open. */
export const GIT_TIMEOUT_MS = 60_000

const ROOTS = ["specs", ".specify"] as const

/** `path` normalised when it lies under `specs/` or `.specify/` (or is one of them), else undefined. */
export function artifactPath(path: string): string | undefined {
  if (path === "" || posix.isAbsolute(path)) return undefined
  const normal = posix.normalize(path).replace(/\/+$/, "")
  if (normal.split("/").includes("..")) return undefined
  return ROOTS.some((root) => normal === root || normal.startsWith(`${root}/`)) ? normal : undefined
}

/**
 * The repository-relative paths that are not artifacts of the workspace at `prefix`
 * (`git rev-parse --show-prefix`), or, given `requested`, not under one of those paths.
 */
export function outsideArtifacts(paths: readonly string[], prefix: string, requested?: readonly string[]): string[] {
  return paths.filter((path) => {
    if (!path.startsWith(prefix)) return true
    const local = path.slice(prefix.length)
    if (artifactPath(local) === undefined) return true
    return requested !== undefined && !requested.some((root) => local === root || local.startsWith(`${root}/`))
  })
}

/** `index`: the tool's private index, the only git selector a call may set. */
export type GitOptions = { index?: string; stdin?: string }
export type Git = (
  args: string[],
  options?: GitOptions,
) => Promise<{ ok: true; stdout: string } | { ok: false; reason: string }>

/** Inherited variables that would select another repository, work tree, index, object store or git binary. */
const GIT_SELECTORS: ReadonlySet<string> = new Set([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  "GIT_EXEC_PATH",
])

/**
 * The environment of every git call: `source` without the repository selectors and the
 * environment-backed config (`GIT_CONFIG*`), plus no prompts and the tool's own private
 * index when given. Author and committer identity variables pass through.
 */
export function gitEnvironment(source: NodeJS.ProcessEnv, index?: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(source))
    if (value !== undefined && !GIT_SELECTORS.has(key) && !key.startsWith("GIT_CONFIG")) env[key] = value
  env.GIT_TERMINAL_PROMPT = "0"
  if (index !== undefined) env.GIT_INDEX_FILE = index
  return env
}

/**
 * git pinned to `workspace` (`-C`), with a clean environment, literal pathspecs and a bound
 * per command. `hooks` is an empty directory used as `core.hooksPath`, so no hook runs
 * (reference-transaction, post-index-change and the commit hooks included); command-line
 * `-c` outranks repository config. `core.fsmonitor=false` keeps a configured fsmonitor
 * program from running either.
 */
export const gitIn =
  (workspace: string, hooks: string): Git =>
  async (args, options = {}) => {
    try {
      const pins = ["-c", `core.hooksPath=${hooks}`, "-c", "core.fsmonitor=false", "--literal-pathspecs"]
      const proc = Bun.spawn(["git", "-C", workspace, ...pins, ...args], {
        cwd: workspace,
        env: gitEnvironment(process.env, options.index),
        stdin: options.stdin === undefined ? "ignore" : new TextEncoder().encode(options.stdin),
        stdout: "pipe",
        stderr: "pipe",
        timeout: GIT_TIMEOUT_MS,
      })
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      return exitCode === 0
        ? { ok: true, stdout }
        : { ok: false, reason: `git ${args[0]} failed: ${stderr.trim() || `exit ${exitCode}`}` }
    } catch (error) {
      return { ok: false, reason: `git ${args[0]} failed: ${error instanceof Error ? error.message : String(error)}` }
    }
  }

const refuse = (reason: string): ToolOutput => ({ content: `${COMMIT_TOOL}: ${reason}`, metadata: { ok: false } })

const names = (stdout: string) => stdout.split("\0").filter(Boolean)

/**
 * Validate `speckit_commit` input into a message and artifact paths, or return why it is
 * unusable. Omitted paths come back undefined: the default roots depend on the repository.
 */
export function readCommitParams(input: unknown): { message: string; paths?: string[] } | string {
  const value = input !== null && typeof input === "object" ? (input as Record<string, unknown>) : {}
  if (typeof value.message !== "string" || value.message.trim() === "") return "message is required"
  if (value.paths === undefined) return { message: value.message }
  if (!Array.isArray(value.paths) || value.paths.some((path) => typeof path !== "string"))
    return "paths must be an array of strings"
  const outside = value.paths.filter((path) => artifactPath(path) === undefined)
  if (outside.length) return `refused: only paths under specs/ or .specify/ may be committed; got ${outside.join(", ")}`
  return { message: value.message, paths: value.paths.map((path) => artifactPath(path) as string) }
}

const realpathOrSelf = (path: string) => {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

/** Build the git runner from the empty hooks directory every call must use. */
export type GitFactory = (hooks: string) => Git

export async function executeCommit(
  input: unknown,
  workspace: string,
  makeGit: GitFactory = (hooks) => gitIn(workspace, hooks),
): Promise<ToolOutput> {
  const request = readCommitParams(input)
  if (typeof request === "string") return refuse(request)
  // The private scratch holds the empty hooks directory and, later, the private index.
  const scratch = mkdtempSync(join(tmpdir(), "speckit-commit-"))
  try {
    const hooks = join(scratch, "hooks")
    mkdirSync(hooks)
    return await commitIn(request, workspace, makeGit(hooks), join(scratch, "index"))
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

async function commitIn(
  request: { message: string; paths?: string[] },
  workspace: string,
  git: Git,
  index: string,
): Promise<ToolOutput> {
  const located = await git(["rev-parse", "--show-toplevel", "--show-prefix"])
  if (!located.ok) return refuse(located.reason)
  const [toplevel = "", base = ""] = located.stdout.split("\n").map((line) => line.trim())
  // The repository git found must be the one holding this workspace (core.worktree and the like can point elsewhere).
  if (resolve(toplevel, base) !== realpathOrSelf(workspace))
    return refuse(`refused: git resolved the workspace to ${resolve(toplevel, base)}, not ${workspace}`)
  // An unborn HEAD (a repository without commits) builds the first commit on the empty tree.
  const parent = await git(["rev-parse", "-q", "--verify", "HEAD^{commit}"])
  const head = parent.ok ? parent.stdout.trim() : undefined
  // By default each root present in the working tree, or tracked in HEAD so its deletion commits.
  const paths = request.paths ?? []
  if (request.paths === undefined)
    for (const root of ROOTS) {
      if (existsSync(join(workspace, root))) paths.push(root)
      else if (head !== undefined) {
        const tracked = await git(["ls-tree", "--name-only", head, "--", root])
        if (!tracked.ok) return refuse(tracked.reason)
        if (tracked.stdout.trim() !== "") paths.push(root)
      }
    }
  if (!paths.length) return refuse("nothing to commit: no specs/ or .specify/ in the workspace")
  const params = { message: request.message, paths }
  const empty = head === undefined ? await git(["hash-object", "-t", "tree", "--stdin"], { stdin: "" }) : undefined
  if (empty !== undefined && !empty.ok) return refuse(empty.reason)
  const baseTree = head ?? (empty?.ok ? empty.stdout.trim() : "")
  // --no-relative: under diff.relative=true git lists names relative to a nested workspace
  // and hides everything outside it, so the boundary check would miss foreign files.
  const staged = await git(["diff", "--cached", "--name-only", "--no-renames", "--no-relative", "-z"])
  if (!staged.ok) return refuse(staged.reason)
  const foreign = outsideArtifacts(names(staged.stdout), base)
  if (foreign.length)
    return refuse(`refused: the index already holds files outside specs/ and .specify/: ${foreign.join(", ")}. Unstage them first.`)

  // The commit is built in a private index from HEAD, so the real index and later edits
  // cannot change what was checked.
  for (const args of [
    head === undefined ? ["read-tree", "--empty"] : ["read-tree", head],
    ["add", "-A", "--", ...params.paths],
  ]) {
    const step = await git(args, { index })
    if (!step.ok) return refuse(step.reason)
  }
  const written = await git(["write-tree"], { index })
  if (!written.ok) return refuse(written.reason)
  const tree = written.stdout.trim()
  const diff = await git(["diff-tree", "-r", "--name-only", "--no-renames", "--no-relative", "-z", baseTree, tree])
  if (!diff.ok) return refuse(diff.reason)
  const changed = names(diff.stdout)
  if (!changed.length) return refuse("nothing to commit: the artifacts are unchanged")
  const stray = outsideArtifacts(changed, base, params.paths)
  if (stray.length) return refuse(`refused: the commit would change paths outside the request: ${stray.join(", ")}`)
  const message = params.message.endsWith("\n") ? params.message : `${params.message}\n`
  const created = await git(["commit-tree", tree, ...(head === undefined ? [] : ["-p", head]), "-F", "-"], {
    stdin: message,
  })
  if (!created.ok) return refuse(created.reason)
  const commit = created.stdout.trim()
  // The old value (empty: HEAD must still be unborn) makes a concurrent HEAD move fail instead of being overwritten.
  const moved = await git(["update-ref", "-m", `speckit_commit: ${message.split("\n", 1)[0]}`, "HEAD", commit, head ?? ""])
  if (!moved.ok) return refuse(`HEAD moved while committing; nothing was committed. ${moved.reason}`)
  const files = changed.map((path) => path.slice(base.length))
  const synced = await git(["reset", "-q", "--", ...files])
  const sha = commit.slice(0, 12)
  return {
    content: `Committed ${sha}: ${files.length} file(s)\n${files.join("\n")}${synced.ok ? "" : `\nThe index was not synced for these paths: ${synced.reason}`}`,
    metadata: { ok: true, sha, paths: files },
  }
}
