/** Renderers for list rows, turns and plan state. Output is neutralized by the caller. */

import { type BranchEvidence, EXACT_TIERS } from "./branch.ts"
import { absoluteTime, clip, oneLine, relativeTime } from "./text.ts"
import type { TodoPhase, Turn } from "./transcript.ts"

const TURN_USER_CHARS = 1200
const TURN_ASSISTANT_CHARS = 1600
const TURN_REASONING_CHARS = 800
const TURN_TOOLS = 12

const TODO_GLYPH: Record<string, string> = { completed: "[x]", in_progress: "[~]", pending: "[ ]", blocked: "[!]" }

/** The branch a session worked on, with `(inferred)` and drift against the worktree now. */
export function branchLabel(evidence: BranchEvidence | null, now: string | undefined): string {
  if (!evidence) return now ? `? [worktree now on ${now}]` : "?"
  const suffix = EXACT_TIERS[evidence.tier] ? "" : " (inferred)"
  if (now && now !== evidence.branch) return `${evidence.branch}${suffix} [worked-on → worktree now on ${now}]`
  return `${evidence.branch}${suffix}`
}

export function renderTodos(phases: readonly TodoPhase[]): string[] {
  const lines: string[] = []
  for (const phase of phases) {
    const done = phase.tasks.filter((task) => task.status === "completed").length
    lines.push(`  ${phase.name || "(unnamed phase)"} — ${done}/${phase.tasks.length}`)
    for (const task of phase.tasks) lines.push(`    ${TODO_GLYPH[task.status] ?? "[?]"} ${task.content}`)
  }
  return lines
}

const KIND_LABEL: Record<Turn["kind"], string> = {
  user: "USER",
  shell: "USER SHELL",
  skill: "USER SKILL",
  orphan: "(no user message)",
}

/** One turn: the request, the prose, reasoning when kept, tool traces and end state. */
export function renderTurn(turn: Turn, index: number): string {
  const lines = [`### [${index}] ${KIND_LABEL[turn.kind]} — ${absoluteTime(turn.time)}`]
  if (turn.user.trim()) lines.push(clip(turn.user, TURN_USER_CHARS))
  if (turn.attachments.length > 0) lines.push(`attachments: ${turn.attachments.join(", ")}`)
  for (const note of turn.notes) lines.push(`  · ${note}`)
  const visible = turn.parts.filter((part) => part.type !== "text" || part.text.trim())
  if (visible.length > 0) lines.push("ASSISTANT:")
  const tools = visible.filter((part) => part.type === "tool")
  const hidden = Math.max(0, tools.length - TURN_TOOLS)
  if (hidden > 0) lines.push(`  … ${hidden} earlier tool call(s) not shown`)
  let skipped = 0
  let prose = TURN_ASSISTANT_CHARS
  let reasoning = TURN_REASONING_CHARS
  // Prose budget goes to the newest text first: the end of a turn is where it left off.
  const textBudget = new Map<number, number>()
  for (let at = visible.length - 1; at >= 0; at -= 1) {
    const part = visible[at]
    if (part?.type !== "text") continue
    const room = Math.max(0, prose)
    textBudget.set(at, room)
    prose -= part.text.trim().length
  }
  visible.forEach((part, at) => {
    if (part.type === "text") {
      const room = textBudget.get(at) ?? 0
      if (room >= 80) lines.push(clip(part.text, room))
      else if (lines[lines.length - 1] !== "[…earlier prose clipped]") lines.push("[…earlier prose clipped]")
      return
    }
    if (part.type === "reasoning") {
      if (reasoning > 0) lines.push(`[reasoning] ${clip(part.text, reasoning)}`)
      reasoning -= part.text.length
      return
    }
    if (skipped++ < hidden) return
    const tool = part.trace
    lines.push(`  ${tool.nested ? "  ↳" : "⮑"} ${tool.name}${tool.brief ? ` (${tool.brief})` : ""}`)
    if (tool.result) lines.push(`     ${tool.error ? "✗" : "↳"} ${tool.result}`)
    if (tool.child) lines.push(`     ↳ child session ${tool.child} (drill down with session="${tool.child}")`)
  })
  const end: string[] = []
  if (turn.ended && turn.ended !== "succeeded") end.push(turn.ended)
  if (turn.error) end.push(`error: ${oneLine(clip(turn.error, 200))}`)
  if (turn.finish === "length" || turn.finish === "error") end.push(`finish: ${turn.finish}`)
  if (end.length > 0) lines.push(`  end: ${end.join(" — ")}`)
  return lines.join("\n")
}

export type RowView = {
  id: string
  idLength: number
  updated: number | null
  turns?: number
  compactions?: number
  unfinished?: boolean
  archived?: boolean
  score?: number
  recommended?: boolean
  title?: string
  worktree: string
  directory: string
  branch?: string
  goal?: string
  objective?: string
  leftOff?: string
  error?: string
}

export function renderRow(row: RowView, position: number, now: number): string[] {
  const flags: string[] = []
  if (row.turns !== undefined) flags.push(`${row.turns} turn${row.turns === 1 ? "" : "s"}`)
  if (row.compactions) flags.push(`compacted×${row.compactions}`)
  if (row.unfinished) flags.push("unfinished")
  if (row.archived) flags.push("archived")
  if (row.score !== undefined) flags.push(`score ${row.score.toFixed(2)}`)
  if (row.recommended) flags.push("★ recommended")
  const id = row.id.length > row.idLength ? row.id.slice(0, row.idLength) : row.id
  const lines = [
    `${String(position).padStart(2)}. ${id}  ${relativeTime(row.updated, now)} (${absoluteTime(row.updated)})` +
      (flags.length > 0 ? `  ${flags.join("  ")}` : ""),
  ]
  if (row.title) lines.push(`    title: ${clip(oneLine(row.title), 200)}`)
  lines.push(`    worktree: ${row.worktree} — ${row.directory || "?"}`)
  if (row.branch) lines.push(`    branch: ${row.branch}`)
  if (row.objective) lines.push(`    objective: ${clip(oneLine(row.objective), 160)}`)
  if (row.goal) lines.push(`    goal: ${clip(oneLine(row.goal), 160)}`)
  if (row.error) lines.push(`    (transcript unreadable: ${clip(oneLine(row.error), 160)})`)
  else lines.push(`    ↳ left off: ${row.leftOff ? clip(row.leftOff, 160) : "(no assistant prose recorded)"}`)
  return lines
}
