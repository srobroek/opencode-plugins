/**
 * Directory flags OpenCode's shell parser does not check. OpenCode asks for
 * `external_directory` when a `cd`/`pushd` target lies outside the session, but a
 * tool's own directory flag (`git -C`, `make -C`, `npm --prefix`, …) moves the command
 * just as far without that check. This reads those flags so the plugin can ask the
 * same question.
 */

import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { under } from "@srobroek/opencode-lib"
import { base, type Command, walkShell } from "./shell.ts"

/** `$HOME`/`~` expand; any other expansion cannot be read statically and yields `undefined`. */
function literalDir(raw: string, cwd: string): string | undefined {
  const value = raw.replace(/^\$\{?HOME\}?(?=\/|$)/, homedir())
  if (value === "" || /[$`]/.test(value)) return undefined
  if (value === "~" || value.startsWith("~/")) return join(homedir(), value.slice(1))
  return isAbsolute(value) ? resolve(value) : resolve(cwd, value)
}

type Flag = { names: readonly string[]; /** `-Cdir` spelling allowed. */ attached?: boolean; file?: boolean }

/** Options per command that set the directory it acts in. Later `-C`s nest in earlier ones. */
const FLAGS: Record<string, readonly Flag[]> = {
  make: [{ names: ["-C", "--directory"], attached: true }],
  gmake: [{ names: ["-C", "--directory"], attached: true }],
  npm: [{ names: ["-C", "--prefix"] }],
  pnpm: [{ names: ["-C", "--dir"] }],
  yarn: [{ names: ["--cwd"] }],
  bun: [{ names: ["--cwd"] }],
  cargo: [{ names: ["-C"], attached: true }, { names: ["--manifest-path"], file: true }],
  go: [{ names: ["-C", "--C"] }],
  uv: [{ names: ["--directory", "--project"] }],
}

const GIT_VALUED: ReadonlySet<string> = new Set(["-c", "--namespace", "--config-env", "--super-prefix"])

/** `git`'s global `-C`, `--git-dir` and `--work-tree`, and `GIT_DIR`/`GIT_WORK_TREE` assignments. */
function gitDirectories(command: Command, cwd: string): string[] {
  const out: string[] = []
  for (const assignment of command.assignments) {
    const match = /^(GIT_DIR|GIT_WORK_TREE)=(.*)$/.exec(assignment)
    const dir = match?.[2] === undefined ? undefined : literalDir(match[2], cwd)
    if (dir !== undefined) out.push(dir)
  }
  let at = cwd
  const argv = command.argv
  for (let i = 1; i < argv.length; i++) {
    const word = argv[i] as string
    if (!word.startsWith("-")) break
    const [flag] = word.split("=", 1) as [string]
    const value = word.includes("=") ? word.slice(flag.length + 1) : undefined
    if (flag === "-C") {
      const next = literalDir(argv[++i] ?? "", at)
      if (next === undefined) return out
      at = next
      out.push(at)
    } else if (flag === "--git-dir" || flag === "--work-tree") {
      const dir = literalDir(value ?? argv[++i] ?? "", at)
      if (dir !== undefined) out.push(dir)
    } else if (GIT_VALUED.has(flag) && value === undefined) {
      i++
    }
  }
  return out
}

function toolDirectories(name: string, argv: readonly string[], cwd: string): string[] {
  if (!Object.hasOwn(FLAGS, name)) return []
  const flags = FLAGS[name] as readonly Flag[]
  const out: string[] = []
  let at = cwd
  for (let i = 1; i < argv.length; i++) {
    const word = argv[i] as string
    if (word === "--") break
    for (const flag of flags) {
      let value: string | undefined
      const named = flag.names.find((option) => word === option || word.startsWith(`${option}=`))
      if (named !== undefined) value = word === named ? argv[++i] : word.slice(named.length + 1)
      else if (flag.attached) {
        const short = flag.names.find((option) => /^-[A-Za-z]$/.test(option) && word.startsWith(option))
        if (short !== undefined) value = word.slice(short.length)
      }
      if (value === undefined) continue
      const path = literalDir(value, at)
      if (path === undefined) break
      if (flag.file) out.push(dirname(path))
      else {
        // `make -C a -C b` nests; the others take the last one.
        if (name === "make" || name === "gmake") at = path
        out.push(path)
      }
      break
    }
  }
  return out
}

/** Absolute directories `command`'s flags point it at, resolved against `cwd`. */
export function flagDirectories(command: Command, cwd: string): string[] {
  const name = base(command.argv[0])
  if (name === "git" || name === "dgit") return gitDirectories(command, cwd)
  return toolDirectories(name, command.argv, cwd)
}

/** Every flag directory a shell call names, each once, in order. */
export function shellFlagDirectories(source: string, cwd: string): string[] {
  const out = new Set<string>()
  for (const command of walkShell(source).commands) for (const dir of flagDirectories(command, cwd)) out.add(dir)
  return [...out]
}

/** The nearest ancestor of `dir` (or `dir` itself) holding `.git`, or `undefined`. */
export function repositoryRoot(dir: string): string | undefined {
  for (let at = dir; ; at = dirname(at)) {
    if (existsSync(join(at, ".git"))) return at
    if (dirname(at) === at) return undefined
  }
}

/** The directories inside which a flag directory needs no approval: the session's and its repository's. */
export function sessionRoots(sessionDirectory: string): string[] {
  const root = repositoryRoot(sessionDirectory)
  return root === undefined || root === dirname(root) ? [sessionDirectory] : [sessionDirectory, root]
}

export type ExternalDirectory = { resource: string; save: string }

/** The `external_directory` resources for the flag directories outside `roots`, the way OpenCode builds them for `cd`. */
export function externalDirectories(dirs: readonly string[], roots: readonly string[]): ExternalDirectory[] {
  const out = new Map<string, ExternalDirectory>()
  for (const dir of dirs) {
    if (roots.some((root) => under(dir, root))) continue
    const resource = join(dir, "*")
    out.set(resource, { resource, save: join(repositoryRoot(dir) ?? dir, "*") })
  }
  return [...out.values()]
}
