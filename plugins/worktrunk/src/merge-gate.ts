import { commandWords, leadingCdCwd, scanShell } from "@srobroek/opencode-lib"

/** A refusal; the hook turns it into a tool error the model reads. */
export type Decision = { block: true; reason: string } | undefined

const MERGE_RETRY = "wt merge <target> --no-squash --no-ff"
const SOURCE_WORKTREE_RETRY = `${MERGE_RETRY} from the source worktree`
export const MERGE_POLICY_REFUSAL = `worker-to-epic merges must preserve history; retry with ${MERGE_RETRY}`
const OPAQUE_DYNAMIC_MERGE_REFUSAL =
  "opaque dynamic shell body names a merge or land command; retry with a literal command"
const UNPARSEABLE_MERGE_REFUSAL =
  "the command has an unterminated quote, substitution or here-document and names wt merge, so the merge cannot be checked; retry with a complete literal command"

const SHELLS: ReadonlySet<string> = new Set(["bash", "sh", "zsh", "dash", "ksh"])
const GLOBAL_VALUE_OPTIONS: ReadonlySet<string> = new Set(["-C", "--config", "--config-set"])
const MERGE_VALUE_OPTIONS: ReadonlySet<string> = new Set(["--stage", "--format", "--config", "--config-set", "-C"])
const ASSIGNMENT = /^([A-Za-z_]\w*)=([\s\S]*)$/
const MAX_DEPTH = 8

function base(word: string | undefined): string {
  return word?.split("/").pop() ?? ""
}

/** A `wt merge` call: its target, its history flags, and the `-C` directory it runs in. */
export type MergeInvocation = { target: string | null; noSquash: boolean; noFf: boolean; workdir: string | null }

/** Read a `wt [globals] merge [args]` argv; `null` for anything else, help included. */
export function parseMergeInvocation(argv: readonly string[]): MergeInvocation | null {
  const wtIndex = argv.findIndex((word) => base(word) === "wt")
  if (wtIndex < 0) return null
  // Global options may precede the subcommand: `wt -C DIR merge TARGET`.
  let subIndex = wtIndex + 1
  let workdir: string | null = null
  while (subIndex < argv.length && argv[subIndex]?.startsWith("-")) {
    const option = argv[subIndex] ?? ""
    if (option === "-C") workdir = argv[subIndex + 1] ?? null
    subIndex += GLOBAL_VALUE_OPTIONS.has(option) ? 2 : 1
  }
  if (argv[subIndex] !== "merge") return null
  if (argv.includes("--help") || argv.includes("-h")) return null
  let target: string | null = null
  let noSquash = false
  let noFf = false
  for (let i = subIndex + 1; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--no-squash") {
      noSquash = true
      continue
    }
    if (arg === "--no-ff") {
      noFf = true
      continue
    }
    if (arg === "--") {
      target = argv[i + 1] ?? null
      break
    }
    if (!arg) continue
    if (arg.startsWith("-") || MERGE_VALUE_OPTIONS.has(argv[i - 1] ?? "")) continue
    if (target === null) target = arg
  }
  return { target, noSquash, noFf, workdir }
}

/** Whether a command source runs `wt merge`, `git merge` or `gh pr merge` as its first command. */
export function namesMergeCommand(source: string): boolean {
  for (const item of scanShell(source).items) {
    if (item.kind !== "command") continue
    const argv = commandWords(item.words.map((word) => word.value)).argv
    const executable = base(argv[0])
    if (executable === "wt" && parseMergeInvocation(argv) !== null) return true
    if (executable === "git" && argv[1] === "merge") return true
    if (executable === "gh" && argv[1] === "pr" && argv[2] === "merge") return true
  }
  return false
}

function references(text: string, names: ReadonlySet<string>): boolean {
  for (const match of text.matchAll(/\$(?:\{([A-Za-z_]\w*)[^}]*\}|([A-Za-z_]\w*))/g)) {
    if (names.has(match[1] ?? match[2] ?? "")) return true
  }
  return false
}

type Collected = {
  /** argv of every simple command, wrappers dropped, in every nested body. */
  commands: string[][]
  /** Words that run as code: command words, and every word of an `eval` or `sh -c` body. */
  executed: string[]
  /** Variables assigned a merge or land command. */
  mergeVariables: Set<string>
  complete: boolean
}

/** Every simple command in `source` and its substitutions, `eval` bodies and `sh -c` scripts. */
export function collectCommands(source: string): Collected {
  const collected: Collected = { commands: [], executed: [], mergeVariables: new Set(), complete: true }
  const visit = (text: string, evaluated: boolean, depth: number): void => {
    if (depth > MAX_DEPTH) {
      collected.complete = false
      return
    }
    const scan = scanShell(text)
    if (!scan.complete) collected.complete = false
    for (const item of scan.items) {
      if (item.kind !== "command") continue
      const values = item.words.map((word) => word.value)
      for (const value of values) {
        const assignment = ASSIGNMENT.exec(value)
        if (!assignment) break
        if (namesMergeCommand(assignment[2] ?? "")) collected.mergeVariables.add(assignment[1] ?? "")
      }
      const argv = commandWords(values).argv
      if (argv.length === 0) continue
      collected.commands.push(argv)
      if (evaluated) collected.executed.push(...argv)
      else if (argv[0] !== undefined) collected.executed.push(argv[0])
      const executable = base(argv[0])
      if (SHELLS.has(executable) && argv[1] === "-c" && argv[2]) visit(argv[2], true, depth + 1)
      if (executable === "eval" && argv.length > 1) visit(argv.slice(1).join(" "), true, depth + 1)
    }
    for (const substitution of scan.substitutions) visit(substitution, evaluated, depth + 1)
  }
  visit(source, false, 0)
  return collected
}

/** Runs one probe; resolves to trimmed stdout, or `null` when the command fails. */
export type Probe = (args: string[], cwd: string, signal: AbortSignal) => Promise<string | null>

export class ProbeTimeout extends Error {}

/** Every probe in one decision shares the budget; each one also has its own timeout. */
export const PROBE_BOUNDS = { timeoutMs: 8_000, budgetMs: 25_000 }

/** Run `binary` in `cwd`; throws `ProbeTimeout` when `signal` aborts first. */
export async function spawnProbe(
  binary: string,
  args: string[],
  cwd: string,
  signal: AbortSignal,
): Promise<string | null> {
  let child: ReturnType<typeof Bun.spawn<"ignore", "pipe", "ignore">>
  try {
    child = Bun.spawn([binary, ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "ignore", signal })
  } catch {
    return null
  }
  const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()])
  if (signal.aborted) throw new ProbeTimeout(`${binary} ${args.join(" ")}`)
  return code === 0 ? stdout.trim() : null
}

export type Probes = { git: Probe; wt: Probe }

export const defaultProbes: Probes = {
  git: (args, cwd, signal) => spawnProbe("git", args, cwd, signal),
  wt: (args, cwd, signal) => spawnProbe("wt", args, cwd, signal),
}

/**
 * Refuse a `wt merge` to a non-default target that lacks `--no-squash --no-ff`, or that
 * does not run from the source worktree. `wt merge <target>` merges the current branch,
 * so a call whose current branch is the target, or unreadable, is refused. Merges to the
 * default branch, and `wt merge` without a target, pass.
 */
export async function decideMergePolicy(
  command: string,
  cwd: string,
  probes: Probes = defaultProbes,
  bounds: { timeoutMs: number; budgetMs: number } = PROBE_BOUNDS,
): Promise<Decision> {
  const budget = AbortSignal.timeout(bounds.budgetMs)
  const probe = async (binary: keyof Probes, args: string[], dir: string): Promise<string | null> => {
    const label = `${binary} ${args.join(" ")}`
    if (budget.aborted) throw new ProbeTimeout(label)
    const signal = AbortSignal.any([budget, AbortSignal.timeout(bounds.timeoutMs)])
    const aborted = new Promise<never>((_, reject) => {
      signal.addEventListener("abort", () => reject(new ProbeTimeout(label)), { once: true })
    })
    return Promise.race([probes[binary](args, dir, signal), aborted])
  }
  try {
    return await decideCommands(
      command,
      cwd,
      (args, dir) => probe("git", args, dir),
      (args, dir) => probe("wt", args, dir),
    )
  } catch (error) {
    if (!(error instanceof ProbeTimeout)) throw error
    return {
      block: true,
      reason: `merge policy probe \`${error.message}\` timed out, so the merge cannot be checked; retry once git and wt answer promptly`,
    }
  }
}

async function decideCommands(
  command: string,
  cwd: string,
  git: (args: string[], cwd: string) => Promise<string | null>,
  wt: (args: string[], cwd: string) => Promise<string | null>,
): Promise<Decision> {
  const collected = collectCommands(command)
  if (!collected.complete && /\bwt\b[\s\S]*\bmerge\b/.test(command))
    return { block: true, reason: UNPARSEABLE_MERGE_REFUSAL }
  if (
    collected.mergeVariables.size > 0 &&
    collected.executed.some((word) => references(word, collected.mergeVariables))
  )
    return { block: true, reason: OPAQUE_DYNAMIC_MERGE_REFUSAL }
  const shellCwd = leadingCdCwd(command, cwd)
  for (const argv of collected.commands) {
    const invocation = parseMergeInvocation(argv)
    if (!invocation || invocation.target === null) continue
    const target = invocation.target
    const repoCwd = invocation.workdir
      ? invocation.workdir.startsWith("/")
        ? invocation.workdir
        : `${shellCwd}/${invocation.workdir}`
      : shellCwd
    const configured = await wt(["config", "state", "default-branch"], repoCwd)
    const symbolic = configured || (await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], repoCwd))
    const defaultBranch = symbolic?.replace(/^origin\//, "")
    if (!defaultBranch) return { block: true, reason: `cannot determine the repository default branch; ${MERGE_RETRY}` }
    if (target === defaultBranch) continue
    if (!invocation.noSquash || !invocation.noFf)
      return { block: true, reason: MERGE_POLICY_REFUSAL.replace("<target>", target) }
    const currentBranch = await git(["branch", "--show-current"], repoCwd)
    if (currentBranch === null) {
      return {
        block: true,
        reason: `\`git branch --show-current\` failed in ${repoCwd}, so the source branch cannot be checked; ${SOURCE_WORKTREE_RETRY.replace("<target>", target)}`,
      }
    }
    if (!currentBranch || currentBranch === target) {
      return {
        block: true,
        reason: `worker-to-epic merges must run from the source worktree; retry with ${SOURCE_WORKTREE_RETRY.replace("<target>", target)}`,
      }
    }
  }
  return undefined
}
