/**
 * The commit gate: a Conventional Commit subject for inline `git commit` messages, and
 * no direct push to `main`/`master`, both only in repositories that release from
 * commits. Every uncertain reading allows the command; forge-side branch protection and
 * title checks are the enforcement, this is the early local guardrail.
 */

import { resolve } from "node:path"
import { type GitRunner, isReleaseRepository, readText, runGit } from "./release-repo.ts"
import { type GitInvocation, gitInvocation, invocations, overridden } from "./shell.ts"

export const COMMIT_OVERRIDE = "TRUNK_DEV_ALLOW_NONCONVENTIONAL_COMMIT"
export const PUSH_OVERRIDE = "TRUNK_DEV_ALLOW_MAIN_PUSH"

export const MESSAGES = {
  commit: `Use a Conventional Commit subject such as \`feat(scope): summary\`, or set ${COMMIT_OVERRIDE}=1 to override.`,
  push: `Do not push directly to main/master; push to a branch and open an MR (or set ${PUSH_OVERRIDE}=1 to override).`,
} as const

const COMMIT_HEADER = /^(?:feat|fix|perf|revert|refactor|chore|docs|test|ci|build|style)(?:\([^)\r\n]+\))?!?: \S.*$/
/** `git push` options that consume the next argv word when not written as `--opt=value`. */
const PUSH_VALUE_OPTIONS: ReadonlySet<string> = new Set(["--repo", "--receive-pack", "--exec", "--push-option", "-o"])
/** `git push` options that take no separate value; `--opt=value` forms are accepted by name. */
const PUSH_FLAG_OPTIONS: ReadonlySet<string> = new Set([
  "-u",
  "--set-upstream",
  "--no-set-upstream",
  "--force",
  "-f",
  "--force-with-lease",
  "--no-force-with-lease",
  "--force-if-includes",
  "--no-force-if-includes",
  "--porcelain",
  "--quiet",
  "-q",
  "--verbose",
  "-v",
  "--atomic",
  "--no-atomic",
  "--thin",
  "--no-thin",
  "--follow-tags",
  "--no-follow-tags",
  "--prune",
  "--no-verify",
  "--verify",
  "--recurse-submodules",
  "--no-recurse-submodules",
  "--signed",
  "--no-signed",
  "--progress",
  "--no-progress",
  "-4",
  "-6",
  "--ipv4",
  "--ipv6",
])

export type Refusal = { reason: string }
type ReadMessage = (path: string) => string | null

export function conventional(subject: string): boolean {
  return COMMIT_HEADER.test(subject.trim())
}

/** The commit message the command supplies: inline, from a file, or from its here-document for `-F -`. */
function commitText(parsed: GitInvocation, read: ReadMessage): { text?: string; uncertain: boolean } {
  const { args, argExpands } = parsed
  let inline: string | undefined
  let file: string | undefined
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (argExpands[i] && (arg.startsWith("-m") || arg.startsWith("--message") || arg.startsWith("--file")))
      return { uncertain: true }
    if (arg === "-m" || arg === "--message") {
      const value = args[++i]
      if (value === undefined || argExpands[i]) return { uncertain: true }
      inline ??= value
      continue
    }
    if (arg.startsWith("-m") && arg.length > 2 && !arg.startsWith("--")) {
      inline ??= arg.slice(2)
      continue
    }
    if (arg.startsWith("--message=")) {
      inline ??= arg.slice("--message=".length)
      continue
    }
    if (arg === "-F" || arg === "--file") {
      const value = args[++i]
      if (value === undefined || argExpands[i]) return { uncertain: true }
      file = value
      continue
    }
    if (arg.startsWith("--file=")) file = arg.slice("--file=".length)
  }
  if (inline !== undefined) return { text: inline, uncertain: false }
  if (file === "-") {
    const document = parsed.hereDocuments[0]
    if (document === undefined || (!document.quoted && /[$`]/.test(document.body))) return { uncertain: true }
    return { text: document.body, uncertain: false }
  }
  if (file !== undefined) {
    const contents = read(resolve(parsed.cwd, file))
    return contents === null ? { uncertain: true } : { text: contents, uncertain: false }
  }
  // An editor-supplied message has no observable subject here.
  return { uncertain: false }
}

function subjectOf(text: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue
    if (line.trim()) return line.trim()
  }
  return undefined
}

function decideCommit(parsed: GitInvocation, read: ReadMessage): Refusal | undefined {
  const message = commitText(parsed, read)
  if (message.uncertain || message.text === undefined) return undefined
  const subject = subjectOf(message.text)
  if (!subject || /^(?:fixup|squash)!\s/.test(subject) || /^(?:Merge|Revert)\s/.test(subject)) return undefined
  return conventional(subject) ? undefined : { reason: MESSAGES.commit }
}

type ParsedPush = {
  dryRun: boolean
  deleting: boolean
  tagOnly: boolean
  allBranches: boolean
  refspecs: string[]
  certain: boolean
}

export function parsePush(args: readonly string[], argExpands: readonly boolean[] = []): ParsedPush {
  const result: ParsedPush = {
    dryRun: false,
    deleting: false,
    tagOnly: false,
    allBranches: false,
    refspecs: [],
    certain: true,
  }
  let remoteSeen = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (argExpands[i]) return { ...result, certain: false }
    if (arg === "--") continue
    if (arg === "--dry-run" || arg === "-n") {
      result.dryRun = true
      continue
    }
    if (arg === "--delete" || arg === "-d") {
      result.deleting = true
      continue
    }
    if (arg === "--tags") {
      result.tagOnly = true
      continue
    }
    // --all and --mirror push every local branch, main/master included.
    if (arg === "--all" || arg === "--branches" || arg === "--mirror") {
      result.allBranches = true
      continue
    }
    if (arg.startsWith("-")) {
      const name = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg
      if (PUSH_VALUE_OPTIONS.has(name)) {
        if (!arg.includes("=")) {
          if (args[i + 1] === undefined) return { ...result, certain: false }
          i++
        }
        continue
      }
      if (PUSH_FLAG_OPTIONS.has(name)) continue
      return { ...result, certain: false }
    }
    const looksLikeRefspec = arg.includes(":") || arg.startsWith("refs/heads/") || arg.startsWith("refs/tags/")
    if (!remoteSeen && result.refspecs.length === 0 && !looksLikeRefspec) {
      remoteSeen = true
      continue
    }
    result.refspecs.push(arg)
  }
  if (!(result.tagOnly && result.refspecs.length === 0)) result.tagOnly = false
  return result
}

function destination(refspec: string): { branch?: string; deleting: boolean; tag: boolean } | undefined {
  const spec = refspec.startsWith("+") ? refspec.slice(1) : refspec
  if (!spec || spec.startsWith("-") || /[*?[]/.test(spec)) return undefined
  const colon = spec.indexOf(":")
  if (colon === 0) return { deleting: true, tag: false }
  const dst = colon < 0 ? spec : spec.slice(colon + 1)
  if (!dst) return { deleting: true, tag: false }
  if (dst.startsWith("refs/tags/")) return { deleting: false, tag: true }
  return { branch: dst.startsWith("refs/heads/") ? dst.slice("refs/heads/".length) : dst, deleting: false, tag: false }
}

function decidePush(parsed: GitInvocation, git: GitRunner): Refusal | undefined {
  const push = parsePush(parsed.args, parsed.argExpands)
  if (!push.certain || push.dryRun || push.deleting || push.tagOnly) return undefined
  const isMain = (branch: string) => branch === "main" || branch === "master"
  const currentBranch = () => git(["branch", "--show-current"], parsed.cwd)?.trim() || undefined
  let targetsMain = false
  if (push.allBranches) targetsMain = true
  else if (push.refspecs.length === 0) {
    const branch = currentBranch()
    if (!branch) return undefined
    targetsMain = isMain(branch)
  } else {
    for (const refspec of push.refspecs) {
      const dest = destination(refspec)
      if (!dest) return undefined
      if (dest.deleting || dest.tag) continue
      // A bare `HEAD` or `@` pushes the current branch to its same-named remote branch.
      const branch = dest.branch === "HEAD" || dest.branch === "@" ? currentBranch() : dest.branch
      if (!branch) return undefined
      if (isMain(branch)) targetsMain = true
    }
  }
  return targetsMain ? { reason: MESSAGES.push } : undefined
}

export type CommitGateOptions = {
  git?: GitRunner
  readFile?: ReadMessage
  exists?: (path: string) => boolean
  list?: (path: string) => string[]
  processEnv?: Readonly<Record<string, string | undefined>>
}

/** The refusal for the first commit or push in `command` that breaks the policy, or `undefined`. */
export function decideCommitGate(command: string, cwd: string, options: CommitGateOptions = {}): Refusal | undefined {
  try {
    const git = options.git ?? runGit
    const read = options.readFile ?? readText
    const env = options.processEnv ?? process.env
    for (const invocation of invocations(command, cwd)) {
      const parsed = gitInvocation(invocation)
      if (parsed === undefined || (parsed.subcommand !== "commit" && parsed.subcommand !== "push")) continue
      const override = overridden(invocation, parsed.subcommand === "commit" ? COMMIT_OVERRIDE : PUSH_OVERRIDE, env)
      if (override) continue
      if (!isReleaseRepository(parsed.cwd, { git, exists: options.exists, readFile: read, list: options.list }))
        continue
      const refusal = parsed.subcommand === "commit" ? decideCommit(parsed, read) : decidePush(parsed, git)
      if (refusal !== undefined) return refusal
    }
    return undefined
  } catch {
    return undefined
  }
}
