/**
 * Permission decisions for shell calls: what the owner must confirm (`ask`) and what is
 * refused with advice (`deny`). The plugin applies them in `permission.hook("evaluate")`.
 *
 * - worktree-destruction-guard: worktree removal, branch force-delete, stash drop/clear,
 *   `reset --hard`, `reflog expire|delete` and `clean -f` ask, unless git proves nothing
 *   is lost (a landed branch, a clean fast-forward reset, a clean forced removal).
 * - branch-delete-gate and worktree-detached-guard supply that proof, and deny what can
 *   only lose work (an orphaned detached tip) or cannot be read.
 * - sudo-destructive: a destructive verb under `sudo` asks.
 * - force-push: a force push without `--force-with-lease` is denied with lease advice.
 */

import { isAbsolute, resolve } from "node:path"
import { leadingCdCwd } from "@srobroek/opencode-lib"
import { type GateOptions, reviewBranchDeletes } from "./branch-delete.ts"
import { type Bounds, budget, gitOut, ProbeTimeout } from "./probes.ts"
import { base, type Command, gitInvocation, hasFlag, positionals, walkShell } from "./shell.ts"
import { defaultProbe, type GitProbe, reviewRemovals } from "./worktree-detached.ts"

export type DecisionID = "force-push" | "sudo-destructive" | "worktree-destruction"

export type Decision = { effect: "ask" | "deny"; message: string }

export const FORCE_PUSH_MESSAGE =
  "Denied by safety (force-push): this push uses `--force`, `-f` or a `+refspec` rather than `--force-with-lease`. A plain force push overwrites the remote ref unconditionally; if anyone pushed since your last fetch, their commits are discarded and only the reflog can recover them. Re-run it with `--force-with-lease` (optionally `--force-if-includes`), which fails when the remote moved."

export const SUDO_MESSAGE =
  "safety (sudo-destructive): a destructive command runs under sudo. Elevated commands ignore workspace boundaries; confirm the target is literal and inside the intended tree."

const DESTRUCTION_HEADER =
  "safety (worktree-destruction-guard): this call destroys work that may exist nowhere else. Approve only if you asked for this exact target in this session."

/** A force push that is not `--force-with-lease`/`--force-if-includes`. */
export function forcePush(command: Command): boolean {
  const git = gitInvocation(command.argv)
  if (git?.subcommand !== "push") return false
  for (const arg of git.args) {
    if (arg === "--force" || arg.startsWith("--force=")) return true
    if (/^-[A-Za-z0-9]+$/.test(arg) && arg.includes("f")) return true
  }
  return positionals(git.args, new Set(["--repo", "-o", "--push-option", "--receive-pack", "--exec"])).some(
    (arg, i) => i > 0 && arg.startsWith("+"),
  )
}

const SUDO_DESTRUCTIVE: ReadonlySet<string> = new Set(["rm", "rmdir", "dd", "shred", "truncate", "wipefs", "unlink"])

/** A destructive verb run under `sudo` or `doas`. */
export function sudoDestructive(command: Command): boolean {
  if (!command.wrappers.some((wrapper) => wrapper === "sudo" || wrapper === "doas")) return false
  const name = base(command.argv[0])
  if (SUDO_DESTRUCTIVE.has(name) || /^mkfs(?:\.[A-Za-z0-9]+)?$/.test(name)) return true
  if (name === "chmod" || name === "chown" || name === "chgrp")
    return hasFlag(command.argv.slice(1), "R", ["--recursive"])
  return false
}

/** A git operation that discards state, as the guard reads it. */
export type Destruction =
  | { kind: "stash-drop" | "stash-clear" | "reflog" | "clean"; command: Command; dir: string | undefined }
  | { kind: "reset-hard"; command: Command; dir: string | undefined; target: string | undefined }

const RESET_VALUED: ReadonlySet<string> = new Set(["--pathspec-from-file"])

/** The git destructions in a call, other than branch deletes and worktree removals. */
export function destructions(commands: readonly Command[], cwd: string | undefined): Destruction[] {
  const found: Destruction[] = []
  for (const command of commands) {
    const git = gitInvocation(command.argv)
    if (!git) continue
    const literal = command.context === "top" && command.words !== undefined && !git.overridden
    const dir =
      literal && cwd !== undefined && !command.assignments.some((value) => value.startsWith("GIT_"))
        ? git.chdirs.reduce((at, chdir) => (isAbsolute(chdir) ? chdir : resolve(at, chdir)), cwd)
        : undefined
    const [verb] = git.args
    if (git.subcommand === "stash" && (verb === "drop" || verb === "clear")) {
      found.push({ kind: verb === "drop" ? "stash-drop" : "stash-clear", command, dir })
    } else if (git.subcommand === "reset" && git.args.includes("--hard")) {
      const target = positionals(git.args, RESET_VALUED)[0]
      const expands = command.words?.some((word) => word.expands && word.value === target) ?? true
      found.push({ kind: "reset-hard", command, dir: expands ? undefined : dir, target })
    } else if (git.subcommand === "reflog" && (verb === "expire" || verb === "delete")) {
      found.push({ kind: "reflog", command, dir })
    } else if (
      git.subcommand === "clean" &&
      hasFlag(git.args, "f", ["--force"]) &&
      !hasFlag(git.args, "n", ["--dry-run"])
    ) {
      found.push({ kind: "clean", command, dir })
    }
  }
  return found
}

/** Why a `reset --hard` is safe (`null`), or what it would discard. */
async function resetRisk(
  run: ReturnType<typeof budget>["run"],
  dir: string,
  target: string | undefined,
): Promise<string | null> {
  const head = (await gitOut(run, ["rev-parse", "--verify", "HEAD"], dir))?.trim()
  if (!head) return "HEAD could not be read."
  const dirty = await gitOut(run, ["status", "--porcelain", "--untracked-files=no"], dir)
  if (dirty === null) return "the working tree status could not be read."
  const changed = dirty.split("\n").filter((line) => line.trim() !== "")
  const to = (await gitOut(run, ["rev-parse", "--verify", `${target ?? "HEAD"}^{commit}`], dir))?.trim()
  if (!to) return `${target ?? "HEAD"} does not name a commit.`
  const notes: string[] = []
  if (changed.length > 0)
    notes.push(
      `${changed.length} modified tracked path${changed.length === 1 ? "" : "s"} would be discarded:\n${changed
        .slice(0, 10)
        .map((line) => `    ${line}`)
        .join("\n")}`,
    )
  if (to !== head) {
    const ancestor = await run(["git", "merge-base", "--is-ancestor", head, to], dir)
    if (ancestor?.exitCode !== 0) {
      const lost = (await gitOut(run, ["rev-list", "--count", `${to}..${head}`], dir))?.trim() ?? "?"
      notes.push(`${lost} commit(s) on HEAD are not in ${target}.`)
    }
  }
  if (notes.length === 0) return null
  notes.push(`Restore: git reset --hard ${head}`)
  return notes.join("\n  ")
}

async function stashNote(run: ReturnType<typeof budget>["run"], destruction: Destruction): Promise<string> {
  if (destruction.dir === undefined) return ""
  if (destruction.kind === "stash-drop") {
    const git = gitInvocation(destruction.command.argv)
    const ref = git ? (positionals(git.args.slice(1))[0] ?? "stash@{0}") : "stash@{0}"
    const sha = (await gitOut(run, ["rev-parse", "--verify", "--quiet", ref], destruction.dir))?.trim()
    return sha ? `\n  ${ref} is ${sha}. Restore: git stash store -m restored ${sha}` : ""
  }
  if (destruction.kind === "stash-clear") {
    const list = await gitOut(run, ["stash", "list", "--format=%H %gd %s"], destruction.dir)
    if (!list) return ""
    const entries = list.split("\n").filter(Boolean)
    return `\n  ${entries.length} entr${entries.length === 1 ? "y" : "ies"}; restore each with git stash store -m restored <sha>:\n${entries
      .slice(0, 10)
      .map((line) => `    ${line}`)
      .join("\n")}`
  }
  return ""
}

export type ReviewOptions = GateOptions & {
  disabled?: ReadonlySet<DecisionID>
  /** Probe override for worktree removals. */
  worktreeProbe?: GitProbe
}

/** Directory the call's top-level commands run in, or `undefined` when a later `cd` makes it unknowable. */
function callDirectory(source: string, commands: readonly Command[], cwd: string): string | undefined {
  const leading = leadingCdCwd(source, cwd)
  const changes = commands.filter(
    (command) => command.context === "top" && ["cd", "pushd", "popd"].includes(base(command.argv[0])),
  )
  if (changes.length === 0) return cwd
  if (changes.length === 1 && changes[0]?.index === 0 && leading !== cwd) return leading
  return undefined
}

const LABELS: Record<Destruction["kind"], string> = {
  "stash-drop": "drops a stash entry",
  "stash-clear": "clears every stash entry",
  "reset-hard": "hard-resets the index and working tree",
  reflog: "expires or deletes reflog entries, the last recovery path for lost commits",
  clean: "deletes untracked files with git clean -f",
}

/** The permission decision for a shell call, or `undefined` when it needs none. */
export async function reviewPermission(
  source: string,
  cwd: string,
  options: ReviewOptions = {},
): Promise<Decision | undefined> {
  const on = (id: DecisionID) => options.disabled?.has(id) !== true
  const walk = walkShell(source)
  const { commands } = walk
  if (on("force-push") && commands.some(forcePush)) return { effect: "deny", message: FORCE_PUSH_MESSAGE }
  const asks: string[] = []
  if (on("sudo-destructive") && commands.some(sudoDestructive)) asks.push(SUDO_MESSAGE)
  if (on("worktree-destruction")) {
    const dir = callDirectory(source, commands, cwd)
    const destructive: string[] = []
    const branches = await reviewBranchDeletes(source, cwd, options)
    if (branches.action === "refuse") {
      if (branches.definitive) return { effect: "deny", message: branches.reason }
      destructive.push(branches.reason)
    } else if (branches.action === "confirm") destructive.push(`${branches.title}\n${branches.message}`)
    const removals = await reviewRemovals(source, dir ?? cwd, options.worktreeProbe ?? defaultProbe(options))
    if (removals.refuse) return { effect: "deny", message: removals.refuse }
    destructive.push(...removals.ask)
    const found = destructions(commands, dir)
    if (found.length > 0) {
      const run = budget(options as Bounds).run
      for (const destruction of found) {
        const text = destruction.command.argv.join(" ")
        try {
          if (destruction.kind === "reset-hard") {
            const risk = destruction.dir === undefined ? "its directory or target cannot be read with certainty." : await resetRisk(run, destruction.dir, destruction.target)
            if (risk !== null) destructive.push(`\`${text}\` ${LABELS[destruction.kind]}: ${risk}`)
            continue
          }
          destructive.push(`\`${text}\` ${LABELS[destruction.kind]}.${await stashNote(run, destruction)}`)
        } catch (error) {
          if (!(error instanceof ProbeTimeout)) throw error
          destructive.push(`\`${text}\` ${LABELS[destruction.kind]}; \`${error.message}\` timed out, so nothing could be proved safe.`)
        }
      }
    }
    if (destructive.length > 0) asks.push([DESTRUCTION_HEADER, ...destructive].join("\n\n"))
  }
  if (asks.length === 0) return undefined
  return { effect: "ask", message: asks.join("\n\n") }
}
