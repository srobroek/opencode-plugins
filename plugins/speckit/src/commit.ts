/**
 * The `speckit_commit` tool: commit SpecKit artifacts without a shell `git add` or
 * `git commit`, whose whole-command permission patterns cannot keep operands or options
 * in bounds. It stages only paths under the workspace's `specs/` and `.specify/`, refuses
 * when anything else is already staged or requested, commits exactly the verified paths,
 * and never amends.
 */

import { existsSync } from "node:fs"
import { join, posix } from "node:path"
import { run } from "./setup.ts"
import type { ToolOutput } from "./tools.ts"

export const COMMIT_TOOL = "speckit_commit"

export const COMMIT_DESCRIPTION =
  "Commit SpecKit artifacts: stages only specs/ and .specify/, refuses other staged files, never amends.\n" +
  "Paths are relative to the SpecKit workspace and default to specs/ and .specify/. Refuses before staging when a requested path lies outside them or the index already holds other files; commits exactly the staged artifact paths."

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

/** Each git command's bound; a commit hook or signing prompt cannot hold the tool open. */
export const GIT_TIMEOUT_MS = 60_000

const ROOTS = ["specs", ".specify"] as const

/** `path` normalised when it lies under `specs/` or `.specify/` (or is one of them), else undefined. */
export function artifactPath(path: string): string | undefined {
  if (path === "" || posix.isAbsolute(path)) return undefined
  const normal = posix.normalize(path).replace(/\/+$/, "")
  if (normal.split("/").includes("..")) return undefined
  return ROOTS.some((root) => normal === root || normal.startsWith(`${root}/`)) ? normal : undefined
}

/** The staged repository-relative paths that are not artifacts of the workspace at `prefix` (`git rev-parse --show-prefix`). */
export function outsideArtifacts(staged: readonly string[], prefix: string): string[] {
  return staged.filter((path) => !path.startsWith(prefix) || artifactPath(path.slice(prefix.length)) === undefined)
}

type Git = (args: string[]) => Promise<{ ok: true; stdout: string } | { ok: false; reason: string }>

const gitIn =
  (workspace: string): Git =>
  async (args) => {
    const result = await run(["git", "--literal-pathspecs", ...args], workspace, Date.now() + GIT_TIMEOUT_MS)
    return result.exitCode === 0
      ? { ok: true, stdout: result.stdout }
      : { ok: false, reason: `git ${args[0]} failed: ${result.stderr.trim() || `exit ${result.exitCode}`}` }
  }

const refuse = (reason: string): ToolOutput => ({ content: `${COMMIT_TOOL}: ${reason}`, metadata: { ok: false } })

/** Validate `speckit_commit` input into a message and artifact paths, or return why it is unusable. */
export function readCommitParams(input: unknown, workspace: string): { message: string; paths: string[] } | string {
  const value = input !== null && typeof input === "object" ? (input as Record<string, unknown>) : {}
  if (typeof value.message !== "string" || value.message.trim() === "") return "message is required"
  if (value.paths === undefined)
    return { message: value.message, paths: ROOTS.filter((root) => existsSync(join(workspace, root))) }
  if (!Array.isArray(value.paths) || value.paths.some((path) => typeof path !== "string"))
    return "paths must be an array of strings"
  const outside = value.paths.filter((path) => artifactPath(path) === undefined)
  if (outside.length) return `refused: only paths under specs/ or .specify/ may be committed; got ${outside.join(", ")}`
  return { message: value.message, paths: value.paths.map((path) => artifactPath(path) as string) }
}

export async function executeCommit(input: unknown, workspace: string, git: Git = gitIn(workspace)): Promise<ToolOutput> {
  const params = readCommitParams(input, workspace)
  if (typeof params === "string") return refuse(params)
  if (!params.paths.length) return refuse("nothing to commit: no specs/ or .specify/ in the workspace")
  const prefix = await git(["rev-parse", "--show-prefix"])
  if (!prefix.ok) return refuse(prefix.reason)
  const base = prefix.stdout.trim()
  const staged = async () => {
    const listed = await git(["diff", "--cached", "--name-only", "--no-renames", "-z"])
    return listed.ok ? { ok: true as const, paths: listed.stdout.split("\0").filter(Boolean) } : listed
  }
  const before = await staged()
  if (!before.ok) return refuse(before.reason)
  const foreign = outsideArtifacts(before.paths, base)
  if (foreign.length)
    return refuse(`refused: the index already holds files outside specs/ and .specify/: ${foreign.join(", ")}. Unstage them first.`)
  const added = await git(["add", "-A", "--", ...params.paths])
  if (!added.ok) return refuse(added.reason)
  const after = await staged()
  if (!after.ok) return refuse(after.reason)
  const late = outsideArtifacts(after.paths, base)
  if (late.length) return refuse(`refused: files outside specs/ and .specify/ were staged meanwhile: ${late.join(", ")}`)
  if (!after.paths.length) return refuse("nothing to commit: the artifacts are unchanged")
  // Naming the verified paths commits only them, whatever else reaches the index meanwhile.
  const paths = after.paths.map((path) => path.slice(base.length))
  const committed = await git(["commit", "-m", params.message, "--", ...paths])
  if (!committed.ok) return refuse(committed.reason)
  const head = await git(["rev-parse", "--short", "HEAD"])
  const sha = head.ok ? head.stdout.trim() : "HEAD"
  return {
    content: `Committed ${sha}: ${paths.length} file(s)\n${paths.join("\n")}`,
    metadata: { ok: true, sha, paths },
  }
}
