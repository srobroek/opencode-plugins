/** Pure extracts over a normalized transcript: goal, walk, files, plan evidence, branch, end state. */

import { isAbsolute, relative } from "node:path"
import { parse, parsedInvocations } from "@srobroek/opencode-lib/shell-command"
import { type BranchEvidence, BranchTracker } from "./branch.ts"
import { clip, oneLine } from "./text.ts"
import type { Transcript, Turn } from "./transcript.ts"

const ACK = /^(y|yes|ok|okay|go|continue|proceed|do it|lgtm|thanks?|sure)\b/i

/** An acknowledgement carries no goal: `ok`, `go on`, `lgtm thanks`. */
export function isAcknowledgement(text: string): boolean {
  const trimmed = text.trim()
  return trimmed.length === 0 || (trimmed.length < 40 && ACK.test(trimmed))
}

/** The newest substantive user request at or before `end` (exclusive). */
export function lastGoal(turns: readonly Turn[], end = turns.length): { index: number; text: string } | undefined {
  for (let index = Math.min(end, turns.length) - 1; index >= 0; index -= 1) {
    const turn = turns[index]
    if (turn?.kind === "user" && !isAcknowledgement(turn.user)) return { index, text: turn.user }
  }
  return undefined
}

/** The oldest substantive user request in the loaded transcript. */
export function firstUser(turns: readonly Turn[]): string | undefined {
  return turns.find((turn) => turn.kind === "user" && !isAcknowledgement(turn.user))?.user
}

/** The newest assistant prose, one line. */
export function lastProse(turns: readonly Turn[]): string {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const texts = turns[index]?.assistant.filter((text) => text.trim()) ?? []
    const text = texts[texts.length - 1]
    if (text) return oneLine(text)
  }
  return ""
}

export type StopReason = "goal" | "compaction" | "budget" | "turns" | "start"

export type WalkOptions = {
  /** Skip this many newest turns. */
  before: number
  /** Cap on rendered turns; undefined means no cap. */
  turns?: number
  /** Budget for the rendered turns, in characters. */
  maxChars: number
  /** Minimum turns before the goal stop applies. */
  minTurns: number
  /** Index of the first turn after the last compaction. */
  boundary: number
  /** Whether a compaction exists at or before the boundary. */
  compacted: boolean
  /** Walk past the compaction boundary when older turns are loaded. */
  pastCompaction: boolean
  render: (turn: Turn, index: number) => string
}

export type WalkResult = {
  /** Rendered blocks, newest first, with their chronological index (0-based). */
  shown: Array<{ index: number; text: string }>
  stop: StopReason
  /** The single newest turn did not fit and was clipped. */
  oversized: boolean
}

/**
 * Walk newest to oldest until the left-off state is likely clear: the last goal
 * plus `minTurns`, the last compaction, the budget, a turn cap, or the start.
 * The budget stops between turns, never inside one, except that a single turn
 * larger than the budget is clipped rather than dropped.
 */
export function walkBack(turns: readonly Turn[], options: WalkOptions): WalkResult {
  const end = Math.max(0, turns.length - Math.max(0, options.before))
  const goal = lastGoal(turns, end)
  const shown: WalkResult["shown"] = []
  let used = 0
  for (let index = end - 1; index >= 0; index -= 1) {
    if (!options.pastCompaction && options.compacted && index < options.boundary) {
      return { shown, stop: "compaction", oversized: false }
    }
    const turn = turns[index]
    if (!turn) continue
    const block = options.render(turn, index + 1)
    const size = block.length + (shown.length > 0 ? 1 : 0)
    if (used + size > options.maxChars) {
      if (shown.length === 0) {
        const room = Math.max(200, options.maxChars - 60)
        shown.push({ index, text: `${block.slice(0, room).trimEnd()}\n…[turn clipped to fit max_chars]` })
        return { shown, stop: "budget", oversized: true }
      }
      return { shown, stop: "budget", oversized: false }
    }
    shown.push({ index, text: block })
    used += size
    if (goal && index <= goal.index && shown.length >= options.minTurns) return { shown, stop: "goal", oversized: false }
    if (options.turns !== undefined && shown.length >= options.turns) return { shown, stop: "turns", oversized: false }
  }
  return { shown, stop: options.compacted && !options.pastCompaction ? "compaction" : "start", oversized: false }
}

/** Paths relative to `directory` when they are inside it. */
export function relativePath(path: string, directory: string): string {
  if (!isAbsolute(path) || !directory) return path
  const rel = relative(directory, path)
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : path
}

/** Files the session wrote, newest first, deduplicated, capped. */
export function filesTouched(
  turns: readonly Turn[],
  directory: string,
  cap = 30,
): { files: string[]; more: number } {
  const seen = new Set<string>()
  const ordered: string[] = []
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const files = turns[index]?.files ?? []
    for (let at = files.length - 1; at >= 0; at -= 1) {
      const file = files[at]
      if (!file) continue
      const path = relativePath(file, directory)
      if (seen.has(path)) continue
      seen.add(path)
      ordered.push(path)
    }
  }
  return { files: ordered.slice(0, cap), more: Math.max(0, ordered.length - cap) }
}

const BEADS_VERBS = new Set(["create", "update", "close", "claim", "reopen"])
const BD_BOOLEAN_FLAGS = ["--json", "--quiet", "-q", "--verbose", "-v", "--sandbox", "--no-daemon", "--readonly"]

/** The last `bd create|update|close|claim|reopen` invocations, oldest first. */
export function beadsEvidence(turns: readonly Turn[], cap = 10): string[] {
  const found: string[] = []
  for (const turn of turns) {
    for (const run of turn.shells) {
      for (const invocation of parsedInvocations(parse(run.command), "bd", BD_BOOLEAN_FLAGS)) {
        if (!invocation.verb || !BEADS_VERBS.has(invocation.verb)) continue
        found.push(oneLine(clip(["bd", ...invocation.args].join(" "), 120)))
      }
    }
  }
  return found.slice(-cap)
}

/** Branch evidence over every shell run, in order: the command, then its output. */
export function branchEvidence(turns: readonly Turn[]): BranchEvidence | null {
  const tracker = new BranchTracker()
  for (const turn of turns) {
    for (const run of turn.shells) {
      tracker.command(run.command)
      if (run.output) tracker.output(run.output)
    }
  }
  return tracker.get()
}

/** How the session ended, as short labels. */
export function endState(transcript: Transcript, outcome?: string): string[] {
  const out: string[] = []
  if (outcome) out.push(`session outcome: ${outcome}`)
  const last = transcript.turns[transcript.turns.length - 1]
  if (last) {
    if (last.ended && last.ended !== outcome) out.push(`last turn: ${last.ended}`)
    if (!last.ended && last.kind !== "orphan" && transcript.exitReason === undefined)
      out.push("last turn: no idle marker (still running or cut off)")
    if (last.error) out.push(`error: ${oneLine(clip(last.error, 200))}`)
    if (last.finish === "length" || last.finish === "error") out.push(`finish: ${last.finish}`)
  }
  if (transcript.exitReason) out.push(`session end: ${transcript.exitReason}`)
  return out
}

/** Whether the session looks unfinished: not succeeded, or the last turn never went idle. */
export function unfinished(transcript: Transcript, outcome?: string): boolean {
  if (outcome && outcome !== "succeeded") return true
  const last = transcript.turns[transcript.turns.length - 1]
  if (!last) return false
  if (last.ended && last.ended !== "succeeded") return true
  return last.ended === undefined && transcript.exitReason === undefined
}
