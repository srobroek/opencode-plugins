/**
 * Trim the system prompt of read-only subagents. OpenCode 2.1.4 builds a child session's
 * system prompt as [agent prompt, instructions] and its built-in context hooks then add the
 * model identity (spliced in at index 1) and a worktree hint (pushed). The instructions part
 * joins its sources with blank lines: Code Mode catalog, MCP, references, skills, the
 * discovered AGENTS.md files ("Instructions from: <path>\n<content>", one per file), then
 * the date ("Today's date: ...") and environment.
 */

export type Segment = "instructions" | "identity" | "worktree"

export const SEGMENTS: ReadonlyArray<Segment> = ["instructions", "identity", "worktree"]

/** Read-only agents shipped in this repository, the built-in explore, and ids reserved for upcoming read-only agents. */
export const DEFAULT_LEAN_AGENTS: ReadonlyArray<string> = [
  "explore",
  "pr-reviewer",
  "adversarial-challenger",
  "design-critic",
  "a11y-auditor",
  "speckit-verify",
  "seance",
  "security-reviewer",
  "code-reviewer",
]

const IDENTITY = "# Your Model\n- Name: "
const WORKTREE = "When you create a worktree outside the current working directory and intend to use it"
const INSTRUCTIONS = "Instructions from: "
const DATE = "\n\nToday's date: "

export type SystemPart = { type: "text"; text: string }

/**
 * Remove the AGENTS.md block from an instructions part. The block starts at the first
 * "Instructions from: " that opens a section and ends where the date section starts. A part
 * without both markers is returned unchanged, so file content is never cut by a guess.
 */
export function dropInstructions(text: string): string {
  const start = text.startsWith(INSTRUCTIONS) ? 0 : text.indexOf(`\n\n${INSTRUCTIONS}`)
  if (start === -1) return text
  const end = text.indexOf(DATE, start)
  if (end === -1) return text
  return start === 0 ? text.slice(end + 2) : text.slice(0, start) + text.slice(end)
}

/** The system parts with the dropped segments removed. Same input, same output, so the prompt cache holds. */
export function leanSystem<P extends SystemPart>(system: ReadonlyArray<P>, drop: ReadonlySet<Segment>): P[] {
  return system.flatMap((part) => {
    if (part.type !== "text") return [part]
    if (drop.has("identity") && part.text.startsWith(IDENTITY)) return []
    if (drop.has("worktree") && part.text.startsWith(WORKTREE)) return []
    if (drop.has("instructions")) {
      const text = dropInstructions(part.text)
      if (text !== part.text) return [{ ...part, text }]
    }
    return [part]
  })
}

export type LeanOptions = { agents: ReadonlySet<string>; drop: ReadonlySet<Segment> } | undefined

/** `leanSubagents: false` turns the trim off; a list replaces the default agents. `leanDrop` picks the segments. */
export function parseLeanOptions(options: Record<string, unknown>): LeanOptions {
  const agents = options.leanSubagents
  if (agents === false) return undefined
  const ids = Array.isArray(agents) ? agents.filter((id): id is string => typeof id === "string") : DEFAULT_LEAN_AGENTS
  const drop = Array.isArray(options.leanDrop)
    ? options.leanDrop.filter((name): name is Segment => SEGMENTS.includes(name as Segment))
    : SEGMENTS
  if (ids.length === 0 || drop.length === 0) return undefined
  return { agents: new Set(ids), drop: new Set(drop) }
}
