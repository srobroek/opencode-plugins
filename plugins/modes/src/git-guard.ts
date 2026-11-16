/**
 * Refuses git commands the permission rules cannot match. A rule such as `git push*` misses
 * `git -C <dir> push`, because git's global options come before the subcommand. This guard
 * skips those options, finds the subcommand, and checks it against a per-agent set.
 */

import { commandFromInput, parse, parsedInvocations } from "@srobroek/opencode-lib/shell-command"

/** Global options that take no value, so the next word is the subcommand. */
const BOOLEAN_FLAGS = [
  "--no-pager",
  "-P",
  "--paginate",
  "-p",
  "--bare",
  "--no-replace-objects",
  "--literal-pathspecs",
  "--glob-pathspecs",
  "--noglob-pathspecs",
  "--icase-pathspecs",
  "--no-optional-locks",
  "--no-lazy-fetch",
]

type Forbidden = { verbs: readonly string[]; hardReset: boolean }

const FORBIDDEN: Readonly<Record<string, Forbidden>> = {
  debug: { verbs: ["push", "clean"], hardReset: false },
  refactor: { verbs: ["push", "clean", "rebase"], hardReset: true },
}

/** The agents this guard covers. */
export const GUARDED_AGENTS: readonly string[] = Object.keys(FORBIDDEN)

/** Why `command` is refused for `agent`, or undefined when it may run. */
export function forbiddenGit(command: string, agent: string): string | undefined {
  const rules = FORBIDDEN[agent]
  if (rules === undefined) return undefined
  const parsed = parse(command)
  if (parsed.unknown) return /\bgit\b/.test(command) ? "the command could not be parsed, so its git use cannot be checked" : undefined
  for (const call of parsedInvocations(parsed, "git", BOOLEAN_FLAGS)) {
    const verb = call.verb
    if (verb === undefined) continue
    if (/[$`'"(]/.test(verb)) return `git subcommand "${verb}" is not a plain word, so it cannot be checked`
    if (rules.verbs.includes(verb)) return `git ${verb} is not allowed for the ${agent} agent`
    if (rules.hardReset && verb === "reset" && call.args.includes("--hard")) return `git reset --hard is not allowed for the ${agent} agent`
  }
  return undefined
}

/** `forbiddenGit` for a shell tool's input. */
export function forbiddenGitInput(input: unknown, agent: string): string | undefined {
  return forbiddenGit(commandFromInput(input), agent)
}
