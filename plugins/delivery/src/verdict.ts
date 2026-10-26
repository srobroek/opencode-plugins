/**
 * The routing verdict of a delivery subagent, read from its final reply.
 *
 * Every delivery agent starts its reply with `VERDICT: <WORD>` and, except the
 * reviewer, ends it with one fenced `json` block. V2 has no agent-level output schema,
 * so this is parsed after the fact and only annotates the subagent result's metadata:
 * no safety invariant depends on it (landing and cleanup read the PR and the receipt).
 */

/** The verdicts each delivery agent may return; the first line must name one. */
export const AGENT_VERDICTS: Readonly<Record<string, readonly string[]>> = {
  implementer: ["DONE", "BLOCKED", "SPLIT"],
  "implementer-high": ["DONE", "BLOCKED", "SPLIT"],
  researcher: ["DONE", "BLOCKED"],
  operator: ["DONE", "BLOCKED"],
  shepherd: ["COMPLETE", "BLOCKED"],
  "pr-reviewer": ["APPROVE", "REQUEST-CHANGES", "COMMENT"],
}

/** Agents whose reply ends with a JSON block. */
const REPORTS_JSON = new Set(["implementer", "implementer-high", "researcher", "operator", "shepherd"])

export type DeliveryVerdict =
  | {
      verdict: string
      agent?: string
      /** The rest of the first line after the verdict word, trimmed. */
      summary?: string
      /** The fenced JSON block, when the reply has a parseable one. */
      fields?: Record<string, unknown>
    }
  | { verdict: "MALFORMED"; agent?: string; reason: string }

const VERDICT_LINE = /^VERDICT:\s*([A-Z][A-Z-]*)\b[\s:—–-]*(.*)$/
const JSON_BLOCK = /```json[ \t]*\r?\n([\s\S]*?)\r?\n```/g

function lastJsonBlock(text: string): { found: false } | { found: true; value: unknown; error?: string } {
  let last: string | undefined
  for (const match of text.matchAll(JSON_BLOCK)) last = match[1]
  if (last === undefined) return { found: false }
  try {
    return { found: true, value: JSON.parse(last) }
  } catch (error) {
    return { found: true, value: undefined, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Parse a subagent's reply. Returns undefined for a non-delivery agent whose reply has
 * no verdict line, so other agents' results stay untouched; a delivery agent's reply
 * that breaks the contract is `MALFORMED`.
 */
export function parseVerdict(text: string, agent?: string): DeliveryVerdict | undefined {
  const allowed = agent === undefined ? undefined : AGENT_VERDICTS[agent]
  const malformed = (reason: string): DeliveryVerdict =>
    agent === undefined ? { verdict: "MALFORMED", reason } : { verdict: "MALFORMED", agent, reason }
  const first =
    text
      .replace(/^\uFEFF/, "")
      .trimStart()
      .split(/\r?\n/, 1)[0]
      ?.trim() ?? ""
  const match = VERDICT_LINE.exec(first.replace(/^\*\*|\*\*$/g, ""))
  if (match === null) {
    if (allowed === undefined) return undefined
    return malformed(`first line is ${JSON.stringify(first.slice(0, 80))}, expected "VERDICT: ${allowed.join("|")}"`)
  }
  const verdict = match[1] as string
  if (allowed !== undefined && !allowed.includes(verdict)) {
    return malformed(`verdict ${verdict} is not one of ${allowed.join(", ")}`)
  }
  const result: DeliveryVerdict = { verdict }
  if (agent !== undefined) result.agent = agent
  const summary = match[2]?.trim()
  if (summary) result.summary = summary
  const block = lastJsonBlock(text)
  if (block.found) {
    if (block.error !== undefined) return malformed(`the json block does not parse: ${block.error}`)
    const value = block.value
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return malformed("the json block is not an object")
    }
    const fields = value as Record<string, unknown>
    if (typeof fields.verdict === "string" && fields.verdict !== verdict) {
      return malformed(`the json block says verdict ${fields.verdict}, the first line says ${verdict}`)
    }
    result.fields = fields
  } else if (agent !== undefined && REPORTS_JSON.has(agent)) {
    return malformed("no fenced json block, expected one at the end of the reply")
  }
  return result
}

/** The note appended to a malformed result, so the lead can ask the child again. */
export function malformedNote(verdict: { reason: string }, sessionID: unknown): string {
  const resume = typeof sessionID === "string" ? ` Continue sessionID ${sessionID} and ask for the report format.` : ""
  return `[delivery] The subagent reply does not follow the report format: ${verdict.reason}.${resume}`
}
