/**
 * `bd`-aware views over the shared shell parser in `@srobroek/opencode-lib`.
 *
 * The lib parser is harness-neutral; this module adds the two things only Beads
 * knows: which `bd` global flags take no value, and that a command rewritten under
 * the embedded-write runner still runs the `bd` after the runner's `--`.
 */

import {
  parsedInvocations as libParsedInvocations,
  type ParsedCommand,
  type ParsedInvocation,
  type ParseFailure,
  parse,
} from "@srobroek/opencode-lib/shell-command"

export {
  type CommandPosition,
  commandFromInput,
  commandSegments,
  interpreterCommandString,
  invocation,
  leadingCdCwd,
  type ParsedCommand,
  type ParsedInvocation,
  type ParseFailure,
  parse,
  readsScriptFromStdin,
  type ShellScan,
  type ShellWord,
  type SimpleCommand,
  scanShell,
  stdinSource,
  type Token,
  tokenize,
} from "@srobroek/opencode-lib/shell-command"
export { type ShellToken, shellQuoteBalanced, tokenizeShell } from "@srobroek/opencode-lib/shell-tokenizer"

/** `bd` global flags that never take the next word as their value. */
export const BD_NO_VALUE_FLAGS: readonly string[] = ["--global", "--claim", "--force", "--json"]

const RUNNER_SCRIPT = /(?:^|\/)bd-embedded-write-runner\.(?:js|ts)$/

/**
 * Executable invocations, recursively. For `bd`, a command already rewritten as
 * `bun bd-embedded-write-runner.ts ... -- bd ...` counts as the `bd` after the
 * runner's delimiter, so every gate sees the mutation the runner will execute.
 */
export function parsedInvocations(parsed: ParsedCommand | ParseFailure, executable = "bd"): ParsedInvocation[] {
  if (executable !== "bd") return libParsedInvocations(parsed, executable)
  if (parsed.unknown) return []
  const found: ParsedInvocation[] = []
  for (const position of parsed.commands) {
    const direct = libParsedInvocations({ ...parsed, commands: [position], nested: [] }, "bd", BD_NO_VALUE_FLAGS)
    if (direct.length > 0) {
      found.push(...direct)
      continue
    }
    if ((position.executable?.split("/").pop() ?? "") === "bd") continue
    const runner = position.argv.findIndex((word) => RUNNER_SCRIPT.test(word))
    const delimiter = runner < 0 ? -1 : position.argv.indexOf("--", runner + 1)
    const child = delimiter < 0 ? -1 : delimiter + 1
    if (child < 0 || position.words[child]?.quoted === true) continue
    if ((position.argv[child]?.split("/").pop() ?? position.argv[child]) !== "bd") continue
    const childPosition = {
      ...position,
      words: position.words.slice(child),
      argv: position.argv.slice(child),
      executable: position.argv[child],
    }
    for (const invocation of libParsedInvocations(
      { ...parsed, commands: [childPosition], nested: [] },
      "bd",
      BD_NO_VALUE_FLAGS,
    ))
      found.push({ ...invocation, position })
  }
  for (const child of parsed.nested) found.push(...parsedInvocations(child, executable))
  return found
}

/** One `bd close`: its ids, the `-C`/`--db` words to replay, and a command-local `BEADS_DIR=`. */
export type CloseInvocation = { ids: string[]; dbArgs: string[]; beadsDir?: string }

/** A close and the shape that names it among the command's resolved write targets. */
export type CloseSite = CloseInvocation & { shape: { verb: string; args: string[]; globals: string[] } }
const BEAD_ID = /^[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+(?:\.\d+)*$/
const CLOSE_VERBS: Record<string, true> = { close: true, done: true }
const DB_VALUE_FLAGS: Record<string, true> = { "--db": true, "-C": true, "--directory": true }
const VALUE_FLAGS: Record<string, true> = {
  "--reason": true,
  "-r": true,
  "--message": true,
  "--session": true,
  "--assignee": true,
  "--status": true,
  "--type": true,
}

/** Extract close invocations from the shared parser, including recursively executed children. */
export function closeInvocations(command: string): CloseInvocation[] {
  return closeSites(command).map(({ shape: _shape, ...close }) => close)
}

/** {@link closeInvocations}, each with the shape that finds its write target. */
export function closeSites(command: string): CloseSite[] {
  const parsed = parse(command)
  if (parsed.unknown) return []
  const out: CloseSite[] = []
  for (const invocation of parsedInvocations(parsed)) {
    if (!invocation.verb || CLOSE_VERBS[invocation.verb.toLowerCase()] !== true) continue
    const ids: string[] = []
    const dbArgs: string[] = []
    const args = invocation.args
    let verbSeen = false
    for (let i = 0; i < args.length; i++) {
      const token = args[i]
      if (token === undefined) continue
      if (token.startsWith("-")) {
        const flag = token.split("=", 1)[0] ?? ""
        if (DB_VALUE_FLAGS[flag] === true) {
          dbArgs.push(token)
          const next = args[i + 1]
          if (!token.includes("=") && next !== undefined) {
            dbArgs.push(next)
            i++
          }
        } else if (token === "--global") dbArgs.push(token)
        else if (verbSeen && VALUE_FLAGS[flag] === true && !token.includes("=") && args[i + 1] !== undefined) i++
        continue
      }
      if (!verbSeen) {
        if (token.toLowerCase() === invocation.verb.toLowerCase()) verbSeen = true
        continue
      }
      if (BEAD_ID.test(token)) ids.push(token)
    }
    const beadsDir = leadingAssignments(invocation.position.argv)
      .findLast((word) => word.startsWith("BEADS_DIR="))
      ?.slice("BEADS_DIR=".length)
    const shape = {
      verb: invocation.verb,
      args: args.slice(invocation.globals.length + 1),
      globals: invocation.globals,
    }
    out.push(beadsDir === undefined ? { ids, dbArgs, shape } : { ids, dbArgs, beadsDir, shape })
  }
  return out
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

/** The `NAME=value` words a command position starts with, which the shell exports to that command alone. */
function leadingAssignments(argv: readonly string[]): string[] {
  const end = argv.findIndex((word) => !ASSIGNMENT.test(word))
  return argv.slice(0, end < 0 ? argv.length : end)
}
