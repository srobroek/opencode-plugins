/**
 * MR/PR advisories, appended to a completed shell call's result and never blocking:
 * Conventional Commit titles, the `Flag:` decision line, squash merges in release
 * repositories, and pushes of long-lived topic branches. Probe failures are silent.
 */

import { type GitRunner, isReleaseRepository, readText, runGit } from "./release-repo.ts"
import { gitInvocation, type Invocation, invocations } from "./shell.ts"

const CONVENTIONAL_TITLE = /^[a-z]+(?:\([^)\r\n]+\))?!?: .+$/
const FLAG_LINE = /^Flag:\s*\S/m
const NO_FLAG_LINE = /^Flag:\s*none\b/im
const DAY_MS = 24 * 60 * 60 * 1000

export const ADVICE = {
  title: "trunk-dev: MR/PR titles should use Conventional Commits, e.g. `feat(scope): summary`.",
  featFlagUnseen:
    "trunk-dev: every `feat` MR/PR ships behind a feature flag; add a `Flag: <name> (default off; owner <alias>; remove by YYYY-MM-DD)` line, and review file/editor-provided text manually.",
  breakingFlagUnseen:
    "trunk-dev: add a `Flag:` decision line to the MR/PR description (or `Flag: none — reason`); review file/editor-provided text manually.",
  featFlagMissing:
    "trunk-dev: every `feat` MR/PR ships behind a feature flag; add a `Flag: <name> (default off; owner <alias>; remove by YYYY-MM-DD)` line.",
  breakingFlagMissing:
    "trunk-dev: this breaking MR/PR needs a `Flag:` decision line in its description (for example `Flag: none — reason`).",
  featFlagNone:
    "trunk-dev: `Flag: none` is only for non-feature changes; gate this `feat` behind a default-off flag, or retype the change truthfully (`fix`, `refactor`, `chore`).",
  squash: "trunk-dev: squash-merge this MR/PR so its Conventional Commit title is the release unit (`--squash`).",
} as const

function titleParts(title: string): { type: string; breaking: boolean } | undefined {
  const match = /^([a-z]+)(?:\([^)\r\n]+\))?(!)?: /.exec(title)
  return match ? { type: match[1] as string, breaking: Boolean(match[2]) } : undefined
}

type OptionValue = { value?: string; uncertain: boolean; missing: boolean }

/** The last value of one of `names`; `uncertain` when it comes from a file, stdin or an expansion. */
function optionValue(args: readonly string[], expands: readonly boolean[], names: ReadonlySet<string>): OptionValue {
  let value: string | undefined
  let uncertain = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (names.has(arg)) {
      const next = args[++i]
      if (next === undefined) return { value, uncertain, missing: true }
      value = next
      uncertain = next.startsWith("@") || next === "-" || expands[i] === true
      continue
    }
    for (const name of names) {
      if (!arg.startsWith(`${name}=`)) continue
      value = arg.slice(name.length + 1)
      uncertain = value.startsWith("@") || value === "-" || expands[i] === true
      break
    }
  }
  return { value, uncertain, missing: false }
}

type Forge = { kind: "create" | "merge"; args: string[]; expands: boolean[]; cwd: string }

function forgeCommand(invocation: Invocation): Forge | undefined {
  const { argv, expands } = invocation
  const ok =
    (argv[0] === "glab" && argv[1] === "mr") || (argv[0] === "gh" && argv[1] === "pr")
      ? argv[2] === "create" || argv[2] === "merge"
      : false
  if (!ok) return undefined
  return { kind: argv[2] as "create" | "merge", args: argv.slice(3), expands: expands.slice(3), cwd: invocation.cwd }
}

function defaultBranch(cwd: string, git: GitRunner): string | undefined {
  const originHead = git(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], cwd)?.trim()
  if (originHead?.startsWith("origin/")) return originHead
  for (const candidate of ["origin/main", "origin/master", "main", "master"]) {
    if (git(["rev-parse", "--verify", candidate], cwd) !== null) return candidate
  }
  return undefined
}

function branchPushAge(cwd: string, git: GitRunner, now: number): string | undefined {
  const head = git(["rev-parse", "--verify", "HEAD"], cwd)?.trim()
  const base = defaultBranch(cwd, git)
  if (!head || !base) return undefined
  const mergeBase = git(["merge-base", head, base], cwd)?.trim()
  if (!mergeBase) return undefined
  const commitTime = git(["show", "-s", "--format=%ct", mergeBase], cwd)?.trim()
  if (!commitTime || !/^\d+$/.test(commitTime)) return undefined
  const age = now - Number(commitTime) * 1000
  if (age <= 2 * DAY_MS) return undefined
  return `trunk-dev: This topic branch is based on a commit ${Math.floor(age / DAY_MS)} days old; keep branches short-lived (about 2 days) and open an MR with required CI.`
}

function pushHasBranchRef(args: readonly string[]): boolean | undefined {
  const refs: string[] = []
  let remoteSeen = false
  for (const arg of args) {
    if (arg.startsWith("-")) continue
    if (!remoteSeen && !arg.includes(":") && !arg.startsWith("refs/heads/") && !arg.startsWith("refs/tags/")) {
      remoteSeen = true
      continue
    }
    refs.push(arg)
  }
  if (refs.length === 0) return true
  for (const refspec of refs) {
    const spec = refspec.startsWith("+") ? refspec.slice(1) : refspec
    if (!spec || /[*?[]/.test(spec)) return undefined
    if (spec.startsWith("refs/tags/")) continue
    const colon = spec.indexOf(":")
    const src = colon < 0 ? spec : spec.slice(0, colon)
    const dst = colon < 0 ? src : spec.slice(colon + 1)
    if (src.startsWith("refs/tags/") || dst.startsWith("refs/tags/")) continue
    if (dst) return true
  }
  return false
}

const NO_AGE_PUSH: ReadonlySet<string> = new Set(["--dry-run", "-n", "--delete", "-d", "--tags", "--all", "--mirror"])

function createAdvice(forge: Forge): string[] {
  const out: string[] = []
  const title = optionValue(forge.args, forge.expands, new Set(["--title", "-t"]))
  if (title.value === undefined || title.uncertain) return out
  if (!CONVENTIONAL_TITLE.test(title.value)) out.push(ADVICE.title)
  const parts = titleParts(title.value)
  if (parts === undefined || (parts.type !== "feat" && !parts.breaking)) return out
  const feature = parts.type === "feat"
  const body = optionValue(forge.args, forge.expands, new Set(["--description", "--body", "-d", "-b"]))
  if (body.uncertain || body.value === undefined || body.missing)
    out.push(feature ? ADVICE.featFlagUnseen : ADVICE.breakingFlagUnseen)
  else if (!FLAG_LINE.test(body.value)) out.push(feature ? ADVICE.featFlagMissing : ADVICE.breakingFlagMissing)
  else if (feature && NO_FLAG_LINE.test(body.value)) out.push(ADVICE.featFlagNone)
  return out
}

export type AdvisoryOptions = {
  git?: GitRunner
  readFile?: (path: string) => string | null
  exists?: (path: string) => boolean
  list?: (path: string) => string[]
  now?: number
}

/** Concise advisories for the command, deduplicated; parsing and probe failures yield none. */
export function decideMrAdvisory(command: string, cwd: string, options: AdvisoryOptions = {}): string[] {
  try {
    const git = options.git ?? runGit
    const read = options.readFile ?? readText
    const now = options.now ?? Date.now()
    const advisories: string[] = []
    for (const invocation of invocations(command, cwd)) {
      const forge = forgeCommand(invocation)
      if (forge?.kind === "create") advisories.push(...createAdvice(forge))
      if (forge?.kind === "merge" && !forge.args.some((arg) => arg === "--squash" || arg === "-s")) {
        if (isReleaseRepository(forge.cwd, { git, exists: options.exists, readFile: read, list: options.list }))
          advisories.push(ADVICE.squash)
      }
      const push = gitInvocation(invocation)
      if (push?.subcommand !== "push" || push.args.some((arg) => NO_AGE_PUSH.has(arg))) continue
      if (pushHasBranchRef(push.args)) {
        const age = branchPushAge(push.cwd, git, now)
        if (age) advisories.push(age)
      }
    }
    return [...new Set(advisories)]
  } catch {
    return []
  }
}
