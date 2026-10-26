/**
 * The `commit-msg` hook's checker and its per-repository installer. The shell gate only
 * sees commits the agent makes; this hook covers commits made anywhere else.
 *
 *   bun dist/commit-msg.js check FILE                     the hook's job: exit 1 on attribution
 *   bun dist/commit-msg.js install [--repo DIR] [--behind-hooks-path]
 *   bun dist/commit-msg.js uninstall [--repo DIR]
 */

import { spawnSync } from "node:child_process"
import { chmodSync, copyFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { hasAttribution } from "./attribution.ts"

export const MARKER = "srobroek.safety commit-msg hook"
export const CHECKER_NAME = "safety-commit-msg.js"
export const CHAINED_NAME = "commit-msg.chained"

/** Hook directories known to run the repository's own `.git/hooks` after their own. */
export const DELEGATING_HOOKS_PATHS: readonly string[] = ["/usr/local/amazon/var/git-defender/hooks"]

export const REJECTION =
  "safety commit-msg: this commit message carries AI-assistant attribution (a Co-authored-by trailer naming an assistant, a 'Generated with' line, or an assistant noreply address). Remove it so the commit names only the human author, or bypass the hook once with `git commit --no-verify`."

const SCISSORS = / -{24} >8 -{24}$/

/** The message git will record: comment lines and everything below the scissors line dropped. */
export function messageBody(text: string, commentChar = "#"): string {
  const kept: string[] = []
  for (const line of text.split("\n")) {
    if (line.startsWith(commentChar)) {
      if (SCISSORS.test(line)) break
      continue
    }
    kept.push(line)
  }
  return kept.join("\n")
}

export function checkMessage(text: string, commentChar = "#"): boolean {
  return !hasAttribution(messageBody(text, commentChar))
}

export type HookKind = "absent" | "ours" | "binary" | "framework" | "script"

const BINARY_MAGICS = [
  [0xfe, 0xed, 0xfa, 0xce],
  [0xce, 0xfa, 0xed, 0xfe],
  [0xfe, 0xed, 0xfa, 0xcf],
  [0xcf, 0xfa, 0xed, 0xfe],
  [0xca, 0xfe, 0xba, 0xbe],
  [0xbe, 0xba, 0xfe, 0xca],
  [0x7f, 0x45, 0x4c, 0x46],
] as const

const FRAMEWORK = /pre-commit|\bprek\b|husky|lefthook|\bbd hooks\b|beads/i

/** What an existing `commit-msg` is, from its bytes. */
export function classifyHook(bytes: Uint8Array | undefined): HookKind {
  if (bytes === undefined) return "absent"
  const sample = bytes.subarray(0, 4096)
  if (sample.includes(0) || BINARY_MAGICS.some((magic) => magic.every((byte, i) => sample[i] === byte))) return "binary"
  const text = new TextDecoder().decode(sample)
  if (text.includes(MARKER)) return "ours"
  if (FRAMEWORK.test(text)) return "framework"
  return "script"
}

export type InstallState = {
  /** `<git-common-dir>/hooks`. */
  localHooks: string
  /** The directory git actually runs hooks from. */
  effectiveHooks: string
  /** `core.hooksPath` as configured, with its scope, when set. */
  hooksPath?: { scope: string; value: string }
  existing: HookKind
  chainedExists: boolean
  behindHooksPath: boolean
  delegating?: readonly string[]
}

export type Plan =
  | { action: "write" | "refresh" | "chain"; notes: string[] }
  | { action: "refuse"; reason: string }

const PRE_COMMIT_SNIPPET = `  - repo: local
    hooks:
      - id: no-ai-attribution
        name: no AI attribution
        entry: bun <safety>/dist/commit-msg.js check
        language: system
        stages: [commit-msg]`

/** Decide what `install` does. It never overwrites a hook it did not write. */
export function planInstall(state: InstallState): Plan {
  const notes: string[] = []
  const hook = join(state.localHooks, "commit-msg")
  if (resolve(state.effectiveHooks) !== resolve(state.localHooks)) {
    const where = state.hooksPath ? `core.hooksPath (${state.hooksPath.scope}: ${state.hooksPath.value})` : "core.hooksPath"
    const delegating = (state.delegating ?? DELEGATING_HOOKS_PATHS).includes(resolve(state.effectiveHooks))
    if (!delegating && !state.behindHooksPath)
      return {
        action: "refuse",
        reason: `${where} points git at ${state.effectiveHooks}, so it ignores ${hook}. Call <safety>/hooks/commit-msg "$@" from ${join(state.effectiveHooks, "commit-msg")}, or, if that hook already runs the repository's .git/hooks, re-run with --behind-hooks-path.`,
      }
    notes.push(`${where} owns hook dispatch; installing into ${state.localHooks}, which it runs after its own hooks.`)
  }
  switch (state.existing) {
    case "absent":
      return { action: "write", notes }
    case "ours":
      return { action: "refresh", notes }
    case "binary":
      return {
        action: "refuse",
        reason: `${hook} is a binary hook; it is left alone. Run <safety>/hooks/commit-msg "$1" from whatever owns it, or chain it by hand.`,
      }
    case "framework":
      return {
        action: "refuse",
        reason: `${hook} is managed by a hook framework (pre-commit, prek, husky, lefthook or beads); it is left alone. Register the check there instead, for pre-commit or prek:\n${PRE_COMMIT_SNIPPET}`,
      }
    case "script":
      if (state.chainedExists)
        return {
          action: "refuse",
          reason: `${hook} is not the safety hook and ${join(state.localHooks, CHAINED_NAME)} already exists; resolve them by hand.`,
        }
      notes.push(`Kept the existing hook as ${CHAINED_NAME}; it runs after the attribution check.`)
      return { action: "chain", notes }
  }
}

export type Git = (cwd: string, args: string[]) => { status: number | null; stdout: string; stderr: string }

export const runGit: Git = (cwd, args) => {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 10_000 })
  return { status: result.status, stdout: (result.stdout ?? "").trim(), stderr: (result.stderr ?? "").trim() }
}

const HERE = (path: string) => fileURLToPath(new URL(path, import.meta.url))

export type InstallOptions = {
  repo: string
  behindHooksPath?: boolean
  git?: Git
  delegating?: readonly string[]
  /** The hook script and the bundled checker to copy in. */
  hookSource?: string
  checkerSource?: string
}

function readMaybe(path: string): Uint8Array | undefined {
  try {
    return readFileSync(path)
  } catch {
    return undefined
  }
}

/** The repository's hook directories and `core.hooksPath`, or an error message. */
export function probe(repo: string, git: Git = runGit): Omit<InstallState, "behindHooksPath" | "delegating"> | string {
  const common = git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
  if (common.status !== 0 || common.stdout === "") return `${repo} is not inside a git repository`
  const effective = git(repo, ["rev-parse", "--path-format=absolute", "--git-path", "hooks"])
  const localHooks = join(common.stdout, "hooks")
  const configured = git(repo, ["config", "--show-scope", "--get", "core.hooksPath"])
  const [scope, ...value] = configured.stdout.split("\t")
  return {
    localHooks,
    effectiveHooks: effective.status === 0 && effective.stdout !== "" ? effective.stdout : localHooks,
    ...(configured.status === 0 && scope ? { hooksPath: { scope, value: value.join("\t") } } : {}),
    existing: classifyHook(readMaybe(join(localHooks, "commit-msg"))),
    chainedExists: existsSync(join(localHooks, CHAINED_NAME)),
  }
}

export type Outcome = { ok: boolean; message: string }

export function install(options: InstallOptions): Outcome {
  const state = probe(options.repo, options.git)
  if (typeof state === "string") return { ok: false, message: state }
  const plan = planInstall({ ...state, behindHooksPath: options.behindHooksPath === true, delegating: options.delegating })
  if (plan.action === "refuse") return { ok: false, message: plan.reason }
  const hook = join(state.localHooks, "commit-msg")
  const hookSource = options.hookSource ?? HERE("../hooks/commit-msg")
  const checkerSource = options.checkerSource ?? HERE("../dist/commit-msg.js")
  if (plan.action === "chain") renameSync(hook, join(state.localHooks, CHAINED_NAME))
  copyFileSync(checkerSource, join(state.localHooks, CHECKER_NAME))
  writeFileSync(hook, readFileSync(hookSource))
  chmodSync(hook, 0o755)
  const verb = plan.action === "refresh" ? "Refreshed" : "Installed"
  return { ok: true, message: [`${verb} the attribution commit-msg hook at ${hook}.`, ...plan.notes].join("\n") }
}

export function uninstall(options: Pick<InstallOptions, "repo" | "git">): Outcome {
  const state = probe(options.repo, options.git)
  if (typeof state === "string") return { ok: false, message: state }
  const hook = join(state.localHooks, "commit-msg")
  if (state.existing !== "ours") return { ok: true, message: `${hook} is not the safety hook; nothing removed.` }
  rmSync(hook)
  rmSync(join(state.localHooks, CHECKER_NAME), { force: true })
  if (state.chainedExists) {
    renameSync(join(state.localHooks, CHAINED_NAME), hook)
    return { ok: true, message: `Removed the safety hook and restored the hook it chained to at ${hook}.` }
  }
  return { ok: true, message: `Removed the safety hook from ${hook}.` }
}

function commentChar(git: Git): string {
  const result = git(".", ["config", "--get", "core.commentChar"])
  return result.status === 0 && result.stdout.length === 1 ? result.stdout : "#"
}

const USAGE = "usage: commit-msg.js check FILE | install [--repo DIR] [--behind-hooks-path] | uninstall [--repo DIR]"

export function main(args: readonly string[], git: Git = runGit): number {
  const [command, ...rest] = args
  const out = (outcome: Outcome) => {
    ;(outcome.ok ? process.stdout : process.stderr).write(`${outcome.message}\n`)
    return outcome.ok ? 0 : 1
  }
  const repoAt = rest.indexOf("--repo")
  const repo = resolve(repoAt >= 0 ? (rest[repoAt + 1] ?? ".") : ".")
  switch (command) {
    case "check": {
      const file = rest[0]
      if (file === undefined) break
      let text: string
      try {
        text = readFileSync(file, "utf8")
      } catch (error) {
        process.stderr.write(`safety commit-msg: cannot read ${file}: ${(error as Error).message}\n`)
        return 1
      }
      if (checkMessage(text, commentChar(git))) return 0
      process.stderr.write(`${REJECTION}\n`)
      return 1
    }
    case "install":
      return out(install({ repo, behindHooksPath: rest.includes("--behind-hooks-path"), git }))
    case "uninstall":
      return out(uninstall({ repo, git }))
  }
  process.stderr.write(`${USAGE}\n`)
  return 2
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2))

export default main
