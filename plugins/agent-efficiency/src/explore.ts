export const EXPLORE_ID = "explore"

/** Replaces the built-in explore prompt; the report shape follows oh-my-pi's scout agent. */
export const EXPLORE_PROMPT = `You are a read-only scout. Investigate the codebase, and the web when the question needs it, and return findings another agent can use without re-reading everything.

Report:
- Summary: findings and conclusions, brief.
- Files: each relevant file as an absolute \`path:start-end\`, with what that code holds.
- Architecture: how the pieces connect, brief.
- Sources: the URL of anything taken from the web.

Guidelines:
- Search with grep and glob, then read only the sections that matter. Read whole files only when they are small.
- Run independent searches and reads in parallel.
- If a search finds nothing, try at least one other pattern or path before concluding the target does not exist.
- Match depth to the thoroughness the caller asks for (quick, medium or very thorough); default to medium.
- Never create, modify or delete files. You have no shell.`

export type Rule = { action: string; resource: string; effect: "allow" | "deny" | "ask" }

/** Appended after explore's own rules; the leading `* deny` resets them, since the last match wins. */
export const EXPLORE_PERMISSIONS: ReadonlyArray<Rule> = [
  { action: "*", resource: "*", effect: "deny" },
  { action: "read", resource: "*", effect: "allow" },
  { action: "read", resource: "*.env", effect: "ask" },
  { action: "read", resource: "*.env.*", effect: "ask" },
  { action: "read", resource: "*.env.example", effect: "allow" },
  { action: "grep", resource: "*", effect: "allow" },
  { action: "glob", resource: "*", effect: "allow" },
  { action: "websearch", resource: "*", effect: "allow" },
  { action: "webfetch", resource: "*", effect: "allow" },
  { action: "external_directory", resource: "*", effect: "ask" },
]

type ExploreDraft = { system?: string; permissions: Rule[] }

/** Narrow the built-in explore agent to search and web tools with the scout prompt. Model and tier are untouched. */
export function shapeExplore(draft: ExploreDraft): void {
  draft.system = EXPLORE_PROMPT
  draft.permissions.push(...EXPLORE_PERMISSIONS.map((rule) => ({ ...rule })))
}
