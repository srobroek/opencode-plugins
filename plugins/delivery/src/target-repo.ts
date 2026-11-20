/**
 * Which local clone a landing or cleanup acts in.
 *
 * Both tools read and write through one directory: the session's. A pull request of
 * another repository (an orchestrator in one repository landing another's) has no
 * clone there, so the caller names one: `repoPath`, or a `worktree` of the target
 * repository. This module resolves that to the clone's canonical checkout root and
 * proves the clone's own remotes name the requested `repo`; the tools then run
 * unchanged with that root as their directory. With no `repo`, or a `repo` the
 * session's repository already is, nothing is retargeted.
 *
 * The decisions are pure and exported; {@link retargetRepository} only feeds them
 * Git reads made through the caller's runner.
 */
import { resolve } from "node:path"
import { forgeTarget, normalizeRepoPath, REMOTE_NAME, repoPathFromRemote, singleRemoteRecord } from "./forge-adapter.ts"
import { REPOSITORY_OBSERVATION_ARGS, repositoryContext } from "./landing-receipt.ts"

/** One configured remote and the normalized repository path its URL names, or null when it names none. */
export type RemotePath = { name: string; path: string | null }

/** One local Git read in a given directory: stdout exactly, or null when Git did not complete it. */
export type GitReadAt = (cwd: string, argv: readonly string[]) => Promise<string | null>

export type TargetInput = { repo?: string; repoPath?: string; worktree?: string }

/**
 * The remote that names `repo`, or null. `origin` wins when it matches, then the first
 * match in the order given. The comparison is on normalized paths only; a remote that
 * names no repository never matches, so the caller cannot be steered to a repository
 * nobody named.
 */
export function selectRemoteForRepo(remotes: readonly RemotePath[], repo: string): string | null {
  const matching = remotes.filter((remote) => remote.path !== null && remote.path === repo)
  return matching.find((remote) => remote.name === "origin")?.name ?? matching[0]?.name ?? null
}

/** The remotes of the repository `read` reads in `cwd`, each with the normalized path its URL names. */
export async function remotePaths(read: GitReadAt, cwd: string): Promise<RemotePath[]> {
  const listed = await read(cwd, ["remote"])
  if (listed === null) return []
  const remotes: RemotePath[] = []
  for (const name of listed.split("\n").filter((line) => REMOTE_NAME.test(line))) {
    const printed = await read(cwd, ["remote", "get-url", name])
    const url = printed === null ? null : singleRemoteRecord(printed)
    const target = url === null ? null : forgeTarget(url)
    const raw = url === null ? null : repoPathFromRemote(url)
    remotes.push({ name, path: target === null || raw === null ? null : normalizeRepoPath(target.forge, raw) })
  }
  return remotes
}

/** The clone input the caller gave, as a path: `repoPath` first, then `worktree`; null for neither. */
export function cloneInput(input: TargetInput): { field: "repoPath" | "worktree"; value: string } | null {
  for (const field of ["repoPath", "worktree"] as const) {
    const value = input[field]?.trim()
    if (value !== undefined && value !== "") return { field, value }
  }
  return null
}

/** The refusal for a `repo` that is not the session's when no local clone of it was named. */
export function missingCloneReason(repo: string, sessionRepos: readonly string[]): string {
  const session = sessionRepos.length === 0 ? "none" : sessionRepos.map((path) => JSON.stringify(path)).join(", ")
  return `repo: observed ${JSON.stringify(repo)}, expected the session's repository (${session}) or a local clone of it: pass \`worktree\` (a worktree of ${repo}) or \`repoPath\` (a checkout of ${repo}); nothing was read from it, merged or written`
}

/** The refusal for a named clone whose remotes do not name `repo`. */
export function cloneMismatchReason(
  repo: string,
  field: "repoPath" | "worktree",
  path: string,
  remotes: readonly RemotePath[],
): string {
  const seen = remotes.map((remote) => `${remote.name}=${remote.path ?? "none"}`).join(", ")
  return `${field}: observed ${JSON.stringify(path)} whose remotes are ${seen === "" ? "absent" : seen}, expected one naming ${JSON.stringify(repo)}; nothing was merged or written`
}

/** The refusal for a named clone that is not a Git checkout. */
export function notACloneReason(field: "repoPath" | "worktree", path: string): string {
  return `${field}: observed ${JSON.stringify(path)}, expected the path of an existing Git checkout of the requested repo; nothing was merged or written`
}

export type Retargeted = { cwd: string; retargeted: boolean } | { reason: string }

/**
 * The directory the tool runs in: the session's when `repo` is absent, invalid (the
 * caller's own validation refuses that) or already the session repository's, else the
 * canonical checkout root of the clone named by `repoPath` or `worktree`, once that
 * clone's remotes are proved to name `repo`.
 */
export async function retargetRepository(
  input: TargetInput,
  sessionCwd: string,
  read: GitReadAt,
): Promise<Retargeted> {
  const raw = input.repo?.trim() ?? ""
  const repo = raw === "" ? null : normalizeRepoPath("gitlab", raw)
  if (repo === null) {
    return input.repoPath?.trim()
      ? { reason: `repoPath: observed ${JSON.stringify(input.repoPath)} without repo, expected repo as "<owner>/<name>" of that checkout` }
      : { cwd: sessionCwd, retargeted: false }
  }
  const session = await remotePaths(read, sessionCwd)
  if (session.some((remote) => remote.path === repo)) return { cwd: sessionCwd, retargeted: false }

  const clone = cloneInput(input)
  if (clone === null) {
    const names = session.flatMap((remote) => (remote.path === null ? [] : [remote.path]))
    return { reason: missingCloneReason(repo, names) }
  }
  const dir = resolve(sessionCwd, clone.value)
  const printed = await read(dir, REPOSITORY_OBSERVATION_ARGS)
  const context =
    printed === null
      ? null
      : repositoryContext(dir, (argv) =>
          argv.length === REPOSITORY_OBSERVATION_ARGS.length &&
          argv.every((part, index) => part === REPOSITORY_OBSERVATION_ARGS[index])
            ? printed
            : null,
        )
  if (context === null) return { reason: notACloneReason(clone.field, dir) }
  const remotes = await remotePaths(read, dir)
  if (!remotes.some((remote) => remote.path === repo)) {
    return { reason: cloneMismatchReason(repo, clone.field, dir, remotes) }
  }
  return { cwd: context.ledger.root, retargeted: true }
}
