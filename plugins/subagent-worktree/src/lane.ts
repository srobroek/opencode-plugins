/** Pure decision logic for subagent worktree lanes. */

export const SUBAGENT_TOOL = "subagent"
export const MERGE_TOOL = "subagent_worktree_merge"
export const LANE_PREFIX = "lane/"
export const SUBAGENT_PREAMBLE = "You are a subagent spawned by another session."
export const WORKTREE_PARAM = "worktree"
export const WORKTREE_PARAM_DESCRIPTION =
  "Path or branch of an existing worktree of this project; false disables automatic isolation."

export const DEFAULT_AGENTS: readonly string[] = ["implementer", "implementer-high", "general"]

export type Options = {
  /** Agents (id or name) whose subagent calls get a worktree. */
  agents: readonly string[]
  /** The ref, resolved in the caller's checkout, that each worktree starts from. */
  base: string
}

export function readOptions(options: Readonly<Record<string, unknown>> | undefined): Options {
  const agents = Array.isArray(options?.agents)
    ? options.agents.filter((agent): agent is string => typeof agent === "string" && agent !== "")
    : DEFAULT_AGENTS
  const base = typeof options?.base === "string" && options.base.trim() !== "" ? options.base.trim() : "HEAD"
  return { agents, base }
}

/** A worktree that a child session runs in. Stored as JSON under `lane/<child>`. */
export type Lane = {
  child: string
  parent: string
  projectID: string
  directory: string
  branch: string
  /** Commit the branch started from. */
  base: string
  /** Branch `subagent_worktree_merge` merges into, when the caller was on one. */
  target?: string
  parentDir: string
  /** The task description, reused to name a revived worktree. */
  title?: string
  /** `removed`: the worktree is gone (empty lane, or merged); the child runs in `parentDir`. */
  state: "active" | "removed" | "merged"
}

export function laneKey(child: string): string {
  return `${LANE_PREFIX}${child}`
}

export function parseLane(value: unknown): Lane | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined
  const lane = value as Record<string, unknown>
  for (const key of ["child", "parent", "projectID", "directory", "branch", "base", "parentDir"]) {
    if (typeof lane[key] !== "string" || lane[key] === "") return undefined
  }
  if (lane.state !== "active" && lane.state !== "removed" && lane.state !== "merged") return undefined
  if (lane.target !== undefined && typeof lane.target !== "string") return undefined
  if (lane.title !== undefined && typeof lane.title !== "string") return undefined
  return value as Lane
}

/** The subagent call's input, when it is one this plugin can read. */
export type SubagentInput = {
  agent: string
  description: string
  prompt: string
  sessionID?: string
  background?: boolean
  /** An existing worktree (path or branch), or false to disable automatic isolation. */
  worktree?: string | false
}

export function readSubagentInput(input: unknown): SubagentInput | undefined {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined
  const value = input as Record<string, unknown>
  if (typeof value.agent !== "string" || typeof value.prompt !== "string") return undefined
  const read: SubagentInput = {
    agent: value.agent,
    description: typeof value.description === "string" ? value.description : "",
    prompt: value.prompt,
  }
  if (typeof value.sessionID === "string" && value.sessionID !== "") read.sessionID = value.sessionID
  if (value.background === true) read.background = true
  if (value[WORKTREE_PARAM] === false) read.worktree = false
  if (typeof value[WORKTREE_PARAM] === "string" && value[WORKTREE_PARAM].trim() !== "")
    read.worktree = value[WORKTREE_PARAM].trim()
  return read
}

/** The `subagent` input without `worktree`, which the built-in tool does not know. */
export function withoutWorktree(input: unknown): unknown {
  if (input === null || typeof input !== "object" || Array.isArray(input) || !Object.hasOwn(input, WORKTREE_PARAM))
    return input
  const { [WORKTREE_PARAM]: _, ...rest } = input as Record<string, unknown>
  return rest
}

/** One checkout from `git worktree list --porcelain`. */
export type WorktreeEntry = { directory: string; branch?: string }

/** The checkouts in `git worktree list --porcelain` output, skipping bare repositories. */
export function parseWorktrees(porcelain: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = []
  for (const block of porcelain.split(/\n\s*\n/)) {
    const lines = block.split("\n").map((line) => line.trim())
    const directory = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length)
    if (!directory || lines.includes("bare")) continue
    const ref = lines.find((line) => line.startsWith("branch "))?.slice("branch ".length)
    entries.push(ref ? { directory, branch: ref.replace(/^refs\/heads\//, "") } : { directory })
  }
  return entries
}

function within(path: string, directory: string): boolean {
  const root = directory.replace(/\/+$/, "")
  return path === root || path.startsWith(`${root}/`)
}

export type WorktreeLookup = { ok: true; worktree: WorktreeEntry } | { ok: false; reason: string }

/** The deepest worktree that contains `path`. */
export function containingWorktree(path: string, entries: readonly WorktreeEntry[]): WorktreeEntry | undefined {
  return entries.filter((entry) => within(path, entry.directory)).sort((a, b) => b.directory.length - a.directory.length)[0]
}

/**
 * The worktree a `worktree` argument names: a branch checked out in one, a path inside one
 * (`path`, already resolved and normalized by the caller; the deepest worktree wins), or a
 * worktree's directory name when only one has it. `entries` is undefined outside git.
 */
export function findWorktree(requested: string, path: string | undefined, entries: readonly WorktreeEntry[] | undefined): WorktreeLookup {
  if (entries === undefined) return { ok: false, reason: `cannot use worktree "${requested}": the caller is not in a git checkout` }
  const name = requested.replace(/^refs\/heads\//, "")
  const byBranch = entries.find((entry) => entry.branch === name)
  if (byBranch) return { ok: true, worktree: byBranch }
  const byPath = path === undefined ? undefined : containingWorktree(path, entries)
  if (byPath) return { ok: true, worktree: byPath }
  const byName = entries.filter((entry) => entry.directory.replace(/\/+$/, "").split("/").pop() === name)
  if (byName.length === 1 && byName[0]) return { ok: true, worktree: byName[0] }
  const known = entries.map((entry) => `${entry.directory}${entry.branch ? ` (${entry.branch})` : ""}`).join(", ")
  return {
    ok: false,
    reason: `worktree "${requested}" is not a worktree of this project; pass the path or branch of one of: ${known || "(none)"}`,
  }
}

/** Where a new subagent starts. */
export type StartPlan =
  | { kind: "default" }
  | { kind: "isolate"; from: string }
  | { kind: "move"; worktree: WorktreeEntry }
  | { kind: "refuse"; reason: string }

/**
 * Where a subagent call starts. Without `worktree` it is today's behaviour: a fresh
 * worktree from the caller's checkout when the agent is isolated, else the caller's
 * directory (child sessions inherit the parent's location). With `worktree`, an isolated
 * agent gets a fresh worktree branched from that worktree, and any other agent runs in it.
 */
export function planStart(facts: {
  input: SubagentInput
  isolation: Isolation
  parentDir: string
  /** The worktree the caller's directory is in. */
  current?: string | undefined
  /** The worktree `input.worktree` names, when it was given. */
  lookup?: WorktreeLookup
  /** Whether the host can run the agent as a subagent (known, not primary). */
  runnable: boolean
}): StartPlan {
  const { input, isolation, lookup } = facts
  if (input.worktree === false) return { kind: "default" }
  if (input.worktree === undefined || lookup === undefined)
    return isolation.isolate ? { kind: "isolate", from: facts.parentDir } : { kind: "default" }
  if (!lookup.ok) return { kind: "refuse", reason: lookup.reason }
  if (!facts.runnable) return { kind: "default" }
  if (isolation.isolate) return { kind: "isolate", from: lookup.worktree.directory }
  if (lookup.worktree.directory === facts.current) return { kind: "default" }
  return { kind: "move", worktree: lookup.worktree }
}

export const CONTINUE_WITH_WORKTREE = "worktree applies only to new subagents; omit it when passing sessionID"

export type IsolationFacts = {
  projectDir?: string
  homeDir?: string
  tool: string
  input: SubagentInput | undefined
  options: Options
  /** The resolved agent, or undefined when the host does not know it. */
  agent: { id: string; name?: string; mode?: string; permissions?: unknown } | undefined
  /** Whether the calling session is itself a child session. */
  callerIsChild: boolean
  /** Whether the caller's directory is inside a git work tree. */
  isGit: boolean
}

export type Isolation = { isolate: true } | { isolate: false; reason: string }

/** Whether a subagent call should run in a fresh worktree. */
export function decideIsolation(facts: IsolationFacts): Isolation {
  if (facts.tool !== SUBAGENT_TOOL) return { isolate: false, reason: "not the subagent tool" }
  const input = facts.input
  if (!input) return { isolate: false, reason: "unreadable input" }
  if (input.sessionID !== undefined) return { isolate: false, reason: "continues an existing session" }
  if (input.worktree === false) return { isolate: false, reason: "explicit opt-out" }
  if (input.worktree === undefined && facts.projectDir && targetsExternalDirectory(input.prompt, facts.projectDir, facts.homeDir))
    return { isolate: false, reason: "task targets another directory" }
  const names = new Set([input.agent, facts.agent?.id, facts.agent?.name].filter((name) => name !== undefined))
  if (!facts.options.agents.some((agent) => names.has(agent))) return { isolate: false, reason: "agent not opted in" }
  if (!facts.agent) return { isolate: false, reason: "unknown agent" }
  if (facts.agent.mode === "primary") return { isolate: false, reason: "primary agent" }
  if (rulesAreReadOnly(facts.agent.permissions)) return { isolate: false, reason: "read-only agent (edit denied)" }
  if (facts.callerIsChild) return { isolate: false, reason: "caller is a child session" }
  if (!facts.isGit) return { isolate: false, reason: "not a git checkout" }
  return { isolate: true }
}

/** Only explicit working-directory directives count, not incidental absolute file paths. */
export function targetsExternalDirectory(prompt: string, projectDir: string, homeDir?: string): boolean {
  const paths = [...prompt.matchAll(/(?:working directory|workdir|repository|repo|checkout|work in|work at)\s*(?:is|:|=)?\s*[`"']?(\/[^\s`"',;]+|~\/[^\s`"',;]+)/gi)]
    .map((match) => match[1]?.replace(/[.)]+$/, ""))
    .filter((path): path is string => path !== undefined)
    .map((path) => path.startsWith("~/") && homeDir ? `${homeDir}/${path.slice(2)}` : path)
  // Ambiguous/multi-repository briefs keep isolation; explicit worktree arguments take precedence.
  return paths.length === 1 && !within(paths[0] ?? "", projectDir)
}

/** OpenCode wildcard match: `*` matches any run of characters. */
function wildcard(value: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")
  return new RegExp(`^${escaped}$`).test(value)
}

/**
 * Whether an agent's permission rules deny `edit` everywhere. OpenCode uses the last matching
 * rule, so this mirrors evaluating `edit` on `*`. Adapted from hueyexe/opencode-ensemble (MIT).
 */
export function rulesAreReadOnly(rules: unknown): boolean {
  if (!Array.isArray(rules)) return false
  const match = [...rules].reverse().find((rule: { action?: unknown; resource?: unknown } | null) => {
    if (typeof rule?.action !== "string" || typeof rule.resource !== "string") return false
    return wildcard("edit", rule.action) && (rule.resource === "*" || rule.resource === "**")
  }) as { effect?: unknown } | undefined
  return match?.effect === "deny"
}

/** A branch-safe slug of a task description. */
export function slug(text: string, max = 32): string {
  const value = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "")
  return value || "task"
}

/** The worktree name, which the worktrunk strategy also uses as the branch name. */
export function worktreeName(description: string, suffix: string): string {
  return `subagent-${slug(description)}-${suffix}`
}

export function shortSha(sha: string): string {
  return sha.slice(0, 12)
}

/** The text prepended to the child's first prompt. */
export function notice(lane: Pick<Lane, "directory" | "branch" | "base">, fresh: boolean): string {
  const lines = [
    `You work in an isolated git worktree: ${lane.directory} (branch ${lane.branch}, based on ${shortSha(lane.base)}).`,
    "Run every command and edit every file inside it, not in any other checkout. Commit changes before you finish; do not create empty commits. The parent session reviews and merges your work.",
  ]
  return fresh ? [SUBAGENT_PREAMBLE, ...lines].join("\n") : lines.join("\n")
}

/** The child prompt with the worktree notice prepended. */
export function rewritePrompt(prompt: string, lane: Pick<Lane, "directory" | "branch" | "base">, fresh: boolean): string {
  const text = fresh && prompt.startsWith(SUBAGENT_PREAMBLE) ? prompt.slice(SUBAGENT_PREAMBLE.length).trimStart() : prompt
  return `${notice(lane, fresh)}\n\n${text}`
}

/** The first prompt of a subagent that runs in an existing worktree. */
export function startPrompt(prompt: string, worktree: WorktreeEntry): string {
  const text = prompt.startsWith(SUBAGENT_PREAMBLE) ? prompt.slice(SUBAGENT_PREAMBLE.length).trimStart() : prompt
  const where = `${worktree.directory}${worktree.branch ? ` (branch ${worktree.branch})` : ""}`
  return `${SUBAGENT_PREAMBLE}\nYou work in the git worktree ${where}. Run every command and read every file there.\n\n${text}`
}

export type LaneStatus = { ahead: number; dirty: boolean }

/** Remove a finished lane whose branch has no commits and whose tree is clean. */
export function shouldRemove(status: LaneStatus | undefined, resultStatus: "completed" | "running" | "error"): boolean {
  if (resultStatus === "running" || status === undefined) return false
  return status.ahead === 0 && !status.dirty
}

export function diffCommand(lane: Pick<Lane, "parentDir" | "base" | "branch">): string {
  return `git -C ${quote(lane.parentDir)} diff ${shortSha(lane.base)}...${lane.branch}`
}

function quote(path: string): string {
  return /^[\w@%+=:,./-]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`
}

/** A lane with no commits whose work exists only as uncommitted changes. */
export function isUncommittedOnly(status: LaneStatus): boolean {
  return status.ahead === 0 && status.dirty
}

export function uncommittedOnly(lane: Pick<Lane, "child" | "directory">): string {
  return `the branch has 0 commits; the work exists only as uncommitted changes in ${lane.directory} and is lost if the worktree is force-removed. Continue the subagent (subagent with sessionID ${lane.child}) and ask it to commit its work.`
}

/** The lane note appended to the subagent tool result. */
export function annotation(lane: Lane, status: LaneStatus | undefined, removed: boolean): string {
  const attrs = `branch="${lane.branch}" base="${shortSha(lane.base)}"${lane.target ? ` target="${lane.target}"` : ""}`
  if (removed) {
    return `<subagent-worktree ${attrs} state="removed">\nNo commits and a clean tree, so the worktree was removed. Continuing this session (sessionID ${lane.child}) gives it a fresh worktree.\n</subagent-worktree>`
  }
  const lines = [`<subagent-worktree ${attrs} directory="${lane.directory}" state="${lane.state}">`]
  if (status) {
    lines.push(`Commits ahead of base: ${status.ahead}. Uncommitted changes: ${status.dirty ? "yes" : "no"}.`)
    if (isUncommittedOnly(status)) lines.push(`Warning: ${uncommittedOnly(lane)}`)
  }
  lines.push(`Review: ${diffCommand(lane)}${status?.dirty ? ` (uncommitted: git -C ${quote(lane.directory)} status)` : ""}`)
  lines.push(
    `Merge: subagent_worktree_merge with sessionID ${lane.child} and method "wt-merge"${lane.target ? ` merges into ${lane.target}` : ""}. Method "none" reports status without merging; "list" reports every active lane.`,
  )
  lines.push("</subagent-worktree>")
  return lines.join("\n")
}

/** `wt merge` argv that merges the lane branch into `target`, keeping its history. */
export function mergeArgs(directory: string, target: string): string[] {
  return ["wt", "-C", directory, "merge", target, "--no-squash", "--no-ff", "--yes"]
}

/** Whether `wt merge` output describes a merge or rebase conflict. */
export function isConflict(output: string): boolean {
  return /conflict|could not apply|resolve all conflicts|needs merge/i.test(output)
}

export type MergeMethod = "wt-merge" | "none" | "list"

export type MergeRefusal = { refuse: true; reason: string } | { refuse: false; target: string }

/** Files in both lists, sorted. */
export function overlap(laneFiles: readonly string[], localFiles: readonly string[]): string[] {
  const local = new Set(localFiles)
  return [...new Set(laneFiles.filter((file) => local.has(file)))].sort()
}

/** Whether a lane can merge now, and into which branch. */
export function decideMerge(input: {
  lane: Lane | undefined
  caller: string
  target?: string
  status: LaneStatus | undefined
  /** Files the lane branch changes since its merge base with the target; undefined when unreadable. */
  laneFiles?: readonly string[] | undefined
  /** Uncommitted and untracked files in the target's checkout ([] when it is not checked out); undefined when unreadable. */
  localFiles?: readonly string[] | undefined
}): MergeRefusal {
  const { lane } = input
  if (!lane) return { refuse: true, reason: "no worktree lane for this session" }
  if (lane.state !== "active") return { refuse: true, reason: `the lane is already ${lane.state}` }
  if (lane.parent !== input.caller) return { refuse: true, reason: "only the session that spawned the subagent can merge its lane" }
  const target = input.target ?? lane.target
  if (!target) return { refuse: true, reason: "the lane has no target branch (the caller was on a detached HEAD); pass target" }
  if (!input.status) return { refuse: true, reason: `cannot read the worktree at ${lane.directory}` }
  if (isUncommittedOnly(input.status)) return { refuse: true, reason: uncommittedOnly(lane) }
  if (input.status.dirty) {
    return { refuse: true, reason: `the worktree has uncommitted changes; commit or discard them in ${lane.directory} first` }
  }
  if (input.status.ahead === 0) return { refuse: true, reason: "the branch has no commits to merge" }
  if (!input.laneFiles) return { refuse: true, reason: `cannot list the files ${lane.branch} changes against ${target}` }
  if (!input.localFiles) return { refuse: true, reason: `cannot read the local changes in the ${target} checkout` }
  const files = overlap(input.laneFiles, input.localFiles)
  if (files.length > 0) {
    return {
      refuse: true,
      reason: `the ${target} checkout has uncommitted or untracked changes to files the lane also changes; commit, stash or remove them there first: ${files.join(", ")}`,
    }
  }
  return { refuse: false, target }
}

/** The worktree path that has `branch` checked out, from `git worktree list --porcelain`. */
export function worktreeForBranch(porcelain: string, branch: string): string | undefined {
  for (const block of porcelain.split(/\n\s*\n/)) {
    const lines = block.split("\n")
    const path = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length)
    if (path && lines.includes(`branch refs/heads/${branch}`)) return path
  }
  return undefined
}

/** How long a session lookup in `method: "list"` may take before it counts as unknown. */
export const SESSION_LOOKUP_MS = 2000

export type Liveness = "alive" | "gone" | "unknown"

/** Settle a session lookup: resolved is alive, rejected is gone, and no answer within `ms` is unknown. */
export async function liveness(lookup: Promise<unknown>, ms: number): Promise<Liveness> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<Liveness>((resolve) => {
    timer = setTimeout(() => resolve("unknown"), ms)
  })
  try {
    return await Promise.race([lookup.then((): Liveness => "alive", (): Liveness => "gone"), timeout])
  } finally {
    clearTimeout(timer)
  }
}

export type LaneReport = {
  lane: Lane
  /** undefined when git cannot read the worktree (for example, it was deleted). */
  status: LaneStatus | undefined
  child: Liveness
  parent: Liveness
}

/** Why a lane looks orphaned, or an empty list. */
export function orphanReasons(report: Pick<LaneReport, "child" | "parent" | "status">): string[] {
  const reasons: string[] = []
  if (report.child === "gone") reasons.push("child session gone")
  if (report.parent === "gone") reasons.push("parent session gone")
  if (report.status === undefined) reasons.push("worktree unreadable")
  return reasons
}

/** The `method: "list"` report. It never removes anything. */
export function formatLaneList(reports: readonly LaneReport[], caller: string): string {
  if (reports.length === 0) return `<subagent-worktree-lanes count="0">\nNo active lanes.\n</subagent-worktree-lanes>`
  const lines = [`<subagent-worktree-lanes count="${reports.length}">`]
  for (const report of reports) {
    const { lane, status } = report
    const state = status ? `ahead=${status.ahead} dirty=${status.dirty ? "yes" : "no"}` : "ahead=? dirty=?"
    const reasons = orphanReasons(report)
    const owner = lane.parent === caller ? "yours" : `parent ${lane.parent}`
    lines.push(
      `- ${lane.branch} (sessionID ${lane.child}, ${owner}) ${lane.directory} ${state} child=${report.child} parent=${report.parent}${reasons.length > 0 ? ` ORPHAN: ${reasons.join(", ")}` : ""}`,
    )
    if (status && isUncommittedOnly(status)) lines.push(`  Warning: ${uncommittedOnly(lane)}`)
  }
  if (reports.some((report) => orphanReasons(report).length > 0)) {
    lines.push(
      "Orphaned lanes are reported only; nothing was removed. Review them and remove a worktree yourself (wt remove) once its work is merged or no longer needed.",
    )
  }
  lines.push("</subagent-worktree-lanes>")
  return lines.join("\n")
}

/** The last lines of command output, without ANSI codes. */
export function tail(text: string, lines = 40): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI escapes
  const clean = text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").trim()
  return clean.split("\n").slice(-lines).join("\n")
}
