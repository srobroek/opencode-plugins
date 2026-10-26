/**
 * The simple commands a shell call runs at top level, read with the lib's `scanShell`.
 *
 * Each invocation carries its argv after wrappers and assignments are dropped, which of
 * those words the shell would rewrite (`$X`, `$(…)`, globs), the `NAME=value`
 * assignments in front of it, and the directory it runs in: the call's directory moved
 * by literal `cd DIR`, `env -C DIR` and `git -C DIR`. A source that does not scan
 * completely yields nothing, so every caller fails open. Nothing is evaluated.
 */

import { resolve } from "node:path"
import { commandWords, type HereDocument, scanShell } from "@srobroek/opencode-lib"

export type Invocation = {
  /** The command and its arguments; `argv[0]` is a basename. */
  argv: string[]
  /** `expands[i]` is true when `argv[i]` is rewritten by the shell before it runs. */
  expands: boolean[]
  cwd: string
  /** `NAME=value` words in front of the command, `env` operands included. */
  environment: ReadonlyMap<string, string>
  hereDocuments: HereDocument[]
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
const RESERVED: ReadonlySet<string> = new Set(["!", "if", "then", "elif", "else", "while", "until", "do"])

function base(word: string): string {
  return word.slice(word.lastIndexOf("/") + 1)
}

export function invocations(command: string, cwd: string): Invocation[] {
  const scan = scanShell(command)
  if (!scan.complete) return []
  const out: Invocation[] = []
  const stack: string[] = []
  let dir = cwd
  for (const item of scan.items) {
    if (item.kind === "operator") {
      if (item.operator === "(") stack.push(dir)
      else if (item.operator === ")") dir = stack.pop() ?? dir
      continue
    }
    let start = 0
    while (start < item.words.length && !item.words[start]?.quoted && RESERVED.has(item.words[start]?.value ?? ""))
      start++
    const words = item.words.slice(start)
    const values = words.map((word) => word.value)
    const { argv, directories } = commandWords(values)
    if (argv.length === 0) continue
    const offset = values.length - argv.length
    const aligned = argv.every((value, i) => values[offset + i] === value)
    const expands = argv.map((_, i) => !aligned || words[offset + i]?.expands === true)
    if (expands[0]) continue
    const environment = new Map<string, string>()
    for (const value of values.slice(0, aligned ? offset : values.length)) {
      if (!ASSIGNMENT.test(value)) continue
      const eq = value.indexOf("=")
      environment.set(value.slice(0, eq), value.slice(eq + 1))
    }
    let here = dir
    for (const directory of directories) here = resolve(here, directory)
    argv[0] = base(argv[0] as string)
    if (argv[0] === "cd") {
      const target = argv[1]
      if (argv.length === 2 && target !== undefined && target !== "-" && !expands[1]) dir = resolve(dir, target)
      continue
    }
    out.push({ argv, expands, cwd: here, environment, hereDocuments: item.hereDocuments })
  }
  return out
}

const GIT_VALUED: ReadonlySet<string> = new Set(["-C", "-c", "--config-env", "--git-dir", "--work-tree"])
const GIT_FLAGS: ReadonlySet<string> = new Set([
  "--no-pager",
  "--paginate",
  "--no-optional-locks",
  "--no-replace-objects",
  "--literal-pathspecs",
  "--glob-pathspecs",
  "--noglob-pathspecs",
  "--icase-pathspecs",
  "--no-advice",
  "--bare",
])

export type GitInvocation = Invocation & {
  subcommand: string
  args: string[]
  /** `argExpands[i]` belongs to `args[i]`. */
  argExpands: boolean[]
}

/** A literal `git`/`dgit` subcommand and the directory `-C` moves it to, or `undefined` when uncertain. */
export function gitInvocation(invocation: Invocation): GitInvocation | undefined {
  const { argv, expands } = invocation
  if (argv[0] !== "git" && argv[0] !== "dgit") return undefined
  let cwd = invocation.cwd
  for (let i = 1; i < argv.length; i++) {
    const value = argv[i] as string
    if (expands[i]) return undefined
    if (GIT_VALUED.has(value)) {
      const operand = argv[i + 1]
      if (operand === undefined || expands[i + 1]) return undefined
      if (value === "-C") cwd = resolve(cwd, operand)
      i++
      continue
    }
    if (value.startsWith("-C") && value.length > 2) {
      cwd = resolve(cwd, value.slice(2))
      continue
    }
    if (GIT_FLAGS.has(value)) continue
    if (value.startsWith("-")) return undefined
    return {
      ...invocation,
      cwd,
      subcommand: value,
      args: argv.slice(i + 1),
      argExpands: expands.slice(i + 1),
    }
  }
  return undefined
}

/** Whether `name=1` is set for the command, by its own assignments or the process environment. */
export function overridden(
  invocation: Invocation,
  name: string,
  processEnv: Readonly<Record<string, string | undefined>>,
): boolean {
  return processEnv[name] === "1" || invocation.environment.get(name) === "1"
}
