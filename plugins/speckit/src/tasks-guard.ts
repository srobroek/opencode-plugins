/**
 * The tasks.md guard: in a repository with an active beads workspace, `specs/<spec>/tasks.md`
 * is read-only legacy, because task state lives in beads. Refuses `edit`, `write` and
 * `patch` calls that target it and `shell` commands that write it. Fails open when beads
 * cannot be probed.
 */

import { dirname, isAbsolute, resolve } from "node:path"
import { lexicalAbs } from "@srobroek/opencode-lib/shell-write-targets"
import { SHELL_TOOL, shellCall, WRITE_TOOLS, writeTargets, writtenPaths } from "@srobroek/opencode-lib/tool-targets"

export const DENY_REASON =
  'blocked by speckit (task state lives in beads, tasks.md is never authored): this repo has an active beads workspace, so specs/*/tasks.md is read-only legacy and must not be written or created. Create implementation tasks as beads under the feature molecule\'s implement step instead: bd create "T00N <title>" --parent <implement-step-id> --spec-id <NNN-slug> -t task; wire ordering with bd dep add <later-id> <earlier-id>; bulk-create with bd create -f <tmpfile>.md (write the temp file OUTSIDE specs/). Then work the tasks via bd ready -> bd update <id> --claim -> bd close <id> --reason. Find the implement step with bd mol current <molecule-root-id>. IF A SKILL DEMANDED tasks.md: skip check-prerequisites.sh --require-tasks and read bd list --spec <NNN-slug>. Do not create tasks.md to get past the check. Disable: set the srobroek.speckit plugin option tasksGuard=false'

const TASKS_PATH = /(?:^|\/)specs\/[^/\s'"]+\/tasks\.md(?:$|[/\s'"])/

const WRITE_REDIRECT = /[0-9]*&?>>?\s*['"]?[^|;&]*specs\/[^|;&]*\/tasks\.md/
const WRITE_UTILS = [
  /\btee\b[^|;&]*specs\/[^|;&]*\/tasks\.md/,
  /\bsed\b\s+[^|;&]*-i[^|;&]*specs\/[^|;&]*\/tasks\.md/,
  /\btruncate\b[^|;&]*specs\/[^|;&]*\/tasks\.md/,
  /\bdd\b[^|;&]*\bof=[^|;&]*specs\/[^|;&]*\/tasks\.md/,
  /\binstall\b[^|;&]*specs\/[^|;&]*\/tasks\.md/,
  // cp writes only its destination: the last operand, or the directory after -t.
  /\bcp\b[^|;&]*[\s'"](?:[^\s|;&'"]*\/)?specs\/[^/\s|;&'"]+\/tasks\.md['"]?\s*(?:$|[|;&)]|\d*>)/m,
  /\bcp\b[^|;&]*\s(?:-t\s*|--target-directory[=\s]+)['"]?(?:[^\s|;&'"]*\/)?specs\/[^/\s|;&'"]+\/?['"]?\s[^|;&]*\btasks\.md\b/,
  /\bmv\b[^|;&]*specs\/[^|;&]*\/tasks\.md/,
  /\bpython3?\b[^|;&]*-c[^|;&]*specs\/[^|;&]*\/tasks\.md/,
  /\bperl\b[^|;&]*-[a-z]*e[^|;&]*specs\/[^|;&]*\/tasks\.md/,
  /\bawk\b[^|;&]*>[^|;&]*specs\/[^|;&]*\/tasks\.md/,
  /\btouch\b[^|;&]*specs\/[^|;&]*\/tasks\.md/,
]

export function isTasksMd(path: string): boolean {
  const n = path.replaceAll("\\", "/")
  return TASKS_PATH.test(n) || /(?:^|\/)specs\/[^/]+\/tasks\.md$/.test(n)
}

/** Whether a shell command, read as text, writes a `specs/<spec>/tasks.md`. */
export function writesTasksMd(command: string): boolean {
  if (WRITE_REDIRECT.test(command)) return true
  return WRITE_UTILS.some((re) => re.test(command))
}

export function commandMentionsTasksMd(command: string): boolean {
  return /specs\/.*\/tasks\.md/s.test(command)
}

/** The repository a tasks.md path belongs to: the directory holding its `specs/`. */
export function repoOf(path: string): string {
  return dirname(dirname(dirname(path)))
}

/** `bd where` succeeds in `directory`: a beads workspace is active there. */
export type BeadsProbe = (directory: string) => Promise<boolean>

/**
 * The directories whose beads state decides a call, or `undefined` when the call cannot
 * write a tasks.md. Edit targets resolve against the session directory; a shell command
 * resolves against its `workdir`.
 */
export function tasksTargets(tool: string, input: unknown, directory: string): string[] | undefined {
  if (WRITE_TOOLS.has(tool)) {
    const hits = writeTargets(tool, input)
      .filter(isTasksMd)
      .map((path) => (isAbsolute(path) ? path : resolve(directory, path)))
    return hits.length > 0 ? [...new Set(hits.map(repoOf))] : undefined
  }
  if (tool !== SHELL_TOOL) return undefined
  const call = shellCall(tool, input)
  if (call === undefined || !commandMentionsTasksMd(call.command)) return undefined
  const cwd = call.workdir ? lexicalAbs(call.workdir, directory) : directory
  const structural = writtenPaths(tool, input, directory).filter(isTasksMd)
  if (structural.length > 0) return [...new Set(structural.map(repoOf))]
  return writesTasksMd(call.command) ? [cwd] : undefined
}

/** The refusal for one call, or `undefined` to let it run. */
export async function decideToolCall(
  tool: string,
  input: unknown,
  directory: string,
  probe: BeadsProbe,
): Promise<string | undefined> {
  const repos = tasksTargets(tool, input, directory)
  if (repos === undefined) return undefined
  for (const repo of repos) if (await probe(repo)) return DENY_REASON
  return undefined
}
