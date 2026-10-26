/** Pure decision logic for subagent worktree lanes. */

export const SUBAGENT_TOOL = "subagent"
export const MERGE_TOOL = "subagent_worktree_merge"
export const LANE_PREFIX = "lane/"
export const SUBAGENT_PREAMBLE = "You are a subagent spawned by another session."

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
  return read
}

export type IsolationFacts = {
  tool: string
  input: SubagentInput | undefined
  options: Options
  /** The resolved agent, or undefined when the host does not know it. */
  agent: { id: string; name?: string; mode?: string } | undefined
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
  const names = new Set([input.agent, facts.agent?.id, facts.agent?.name].filter((name) => name !== undefined))
  if (!facts.options.agents.some((agent) => names.has(agent))) return { isolate: false, reason: "agent not opted in" }
  if (!facts.agent) return { isolate: false, reason: "unknown agent" }
  if (facts.agent.mode === "primary") return { isolate: false, reason: "primary agent" }
  if (facts.callerIsChild) return { isolate: false, reason: "caller is a child session" }
  if (!facts.isGit) return { isolate: false, reason: "not a git checkout" }
  return { isolate: true }
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
    "Run every command and edit every file inside it, not in any other checkout. Commit your work on this branch before you finish; the parent session reviews and merges it.",
  ]
  return fresh ? [SUBAGENT_PREAMBLE, ...lines].join("\n") : lines.join("\n")
}

/** The child prompt with the worktree notice prepended. */
export function rewritePrompt(prompt: string, lane: Pick<Lane, "directory" | "branch" | "base">, fresh: boolean): string {
  const text = fresh && prompt.startsWith(SUBAGENT_PREAMBLE) ? prompt.slice(SUBAGENT_PREAMBLE.length).trimStart() : prompt
  return `${notice(lane, fresh)}\n\n${text}`
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

/** The lane note appended to the subagent tool result. */
export function annotation(lane: Lane, status: LaneStatus | undefined, removed: boolean): string {
  const attrs = `branch="${lane.branch}" base="${shortSha(lane.base)}"${lane.target ? ` target="${lane.target}"` : ""}`
  if (removed) {
    return `<subagent-worktree ${attrs} state="removed">\nNo commits and a clean tree, so the worktree was removed. Continuing this session (sessionID ${lane.child}) gives it a fresh worktree.\n</subagent-worktree>`
  }
  const lines = [`<subagent-worktree ${attrs} directory="${lane.directory}" state="${lane.state}">`]
  if (status) {
    lines.push(`Commits ahead of base: ${status.ahead}. Uncommitted changes: ${status.dirty ? "yes" : "no"}.`)
  }
  lines.push(`Review: ${diffCommand(lane)}${status?.dirty ? ` (uncommitted: git -C ${quote(lane.directory)} status)` : ""}`)
  lines.push(
    `Merge: subagent_worktree_merge with sessionID ${lane.child} and method "wt-merge"${lane.target ? ` merges into ${lane.target}` : ""}. Method "none" reports status without merging.`,
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

export type MergeMethod = "wt-merge" | "none"

export type MergeRefusal = { refuse: true; reason: string } | { refuse: false; target: string }

/** Whether a lane can merge now, and into which branch. */
export function decideMerge(input: {
  lane: Lane | undefined
  caller: string
  target?: string
  status: LaneStatus | undefined
}): MergeRefusal {
  const { lane } = input
  if (!lane) return { refuse: true, reason: "no worktree lane for this session" }
  if (lane.state !== "active") return { refuse: true, reason: `the lane is already ${lane.state}` }
  if (lane.parent !== input.caller) return { refuse: true, reason: "only the session that spawned the subagent can merge its lane" }
  const target = input.target ?? lane.target
  if (!target) return { refuse: true, reason: "the lane has no target branch (the caller was on a detached HEAD); pass target" }
  if (!input.status) return { refuse: true, reason: `cannot read the worktree at ${lane.directory}` }
  if (input.status.dirty) {
    return { refuse: true, reason: `the worktree has uncommitted changes; commit or discard them in ${lane.directory} first` }
  }
  if (input.status.ahead === 0) return { refuse: true, reason: "the branch has no commits to merge" }
  return { refuse: false, target }
}

/** The last lines of command output, without ANSI codes. */
export function tail(text: string, lines = 40): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI escapes
  const clean = text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").trim()
  return clean.split("\n").slice(-lines).join("\n")
}
