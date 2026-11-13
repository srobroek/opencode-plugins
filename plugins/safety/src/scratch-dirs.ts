/**
 * Subagents read the OpenCode temp folder (repomix packs, scratch files) and the worktree folder of their
 * own project (subagent lanes). Both are OpenCode's, so an `external_directory` ask for them is noise; this
 * turns it into an allow. A deny and every other action are left alone.
 */

import { existsSync, lstatSync, realpathSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path"

type Evaluation = { readonly action: string; readonly resources: ReadonlyArray<string>; effect: string }

/**
 * The folders OpenCode fills for this user: its temp folder, and `<data>/opencode/worktree/<key>` for the
 * project, where the key is the first six characters of the project id (project `41bad135…` keeps its
 * worktrees in `…/worktree/41bad1`).
 */
export function scratchRoots(
  projectID: string,
  where: { home?: string; temp?: string; env?: Readonly<Record<string, string | undefined>> } = {},
): string[] {
  const home = where.home ?? homedir()
  const env = where.env ?? process.env
  const data = env.XDG_DATA_HOME?.startsWith("/") ? env.XDG_DATA_HOME : join(home, ".local", "share")
  return [join(where.temp ?? realpathSync(tmpdir()), "opencode"), join(data, "opencode", "worktree", projectID.slice(0, 6))]
}

/** `path` with symlinks resolved as far as it exists; the rest is appended unchanged. */
function resolved(path: string): string {
  const missing: string[] = []
  let at = path
  while (!existsSync(at) && dirname(at) !== at) {
    missing.unshift(basename(at))
    at = dirname(at)
  }
  return join(realpathSync(at), ...missing)
}

/** Whether a resource (`~/…`, an absolute path or a `dir/*` pattern) lies inside one of the `roots`. */
function inside(resource: string, roots: readonly string[]): boolean {
  const expanded = resource === "~" || resource.startsWith("~/") ? join(homedir(), resource.slice(1)) : resource
  if (!isAbsolute(expanded)) return false
  const path = expanded.replace(/\/\*{1,2}$/, "")
  if (/[*?[\]{}]/.test(path) || path.split("/").includes("..")) return false
  const real = resolved(path)
  return roots.some((root) => {
    const rel = relative(resolved(root), real)
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
  })
}

/**
 * Whether `root` is still the folder it was computed to be: it exists, no component of its path is a
 * symlink, its real path equals the path, and the current user owns it. A folder swapped for a symlink
 * (or made by someone else) after the path was computed is not trusted.
 */
export function pinned(root: string, uid: () => number | undefined = () => process.getuid?.()): boolean {
  try {
    if (!isAbsolute(root) || realpathSync(root) !== root) return false
    let at: string = sep
    for (const part of root.split(sep).filter(Boolean)) {
      at = join(at, part)
      if (lstatSync(at).isSymbolicLink()) return false
    }
    const owner = uid()
    return owner === undefined || lstatSync(root).uid === owner
  } catch {
    return false
  }
}

/** Turn an `external_directory` ask into an allow when every resource is inside a pinned root. */
export function allowScratch(evaluation: Evaluation, roots: readonly string[], uid?: () => number | undefined): void {
  if (evaluation.action !== "external_directory" || evaluation.effect !== "ask") return
  if (evaluation.resources.length === 0) return
  const trusted = roots.filter((root) => pinned(root, uid))
  if (evaluation.resources.every((resource) => inside(resource, trusted))) evaluation.effect = "allow"
}
