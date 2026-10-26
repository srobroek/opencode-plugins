/**
 * The source-neutral transcript model and the OpenCode V2 message normalizer.
 *
 * A turn is a user (or shell, or skill) message plus every following assistant,
 * synthetic and system message up to and including the next `idle`. Without an
 * idle marker a turn runs to the next user message.
 */

import { writeTargets } from "@srobroek/opencode-lib/tool-targets"
import { clip, oneLine } from "./text.ts"

export type Outcome = "succeeded" | "failed" | "interrupted"

export interface Trace {
  name: string
  brief: string
  result: string
  error: boolean
  /** Child session of a `subagent` call. */
  child?: string
  /** A call made inside Code Mode `execute`. */
  nested?: boolean
}

export interface ShellRun {
  command: string
  output: string
}

/** Assistant output in the order it was produced. */
export type Part = { type: "text"; text: string } | { type: "reasoning"; text: string } | { type: "tool"; trace: Trace }

export interface Turn {
  time: number | null
  kind: "user" | "shell" | "skill" | "orphan"
  user: string
  attachments: string[]
  assistant: string[]
  reasoning: string[]
  tools: Trace[]
  notes: string[]
  files: string[]
  shells: ShellRun[]
  parts: Part[]
  ended?: Outcome
  error?: string
  finish?: string
}

export interface Section {
  heading: string
  body: string
}

export interface Compaction {
  time: number | null
  summary: string
  sections: Section[]
}

export interface TodoTask {
  content: string
  status: string
}

export interface TodoPhase {
  name: string
  tasks: TodoTask[]
}

export interface Transcript {
  /** Chronological, empty turns dropped. */
  turns: Turn[]
  /** Completed compactions, chronological. */
  compactions: Compaction[]
  /** Index of the first turn after the last completed compaction; 0 when there is none. */
  boundary: number
  /** Directories the session worked in, oldest first. */
  locations: string[]
  /** omp only: the latest todo board. */
  todo?: TodoPhase[]
  /** omp only: how the session ended. */
  exitReason?: string
  /** Messages read from the source. */
  messages: number
}

export type NormalizeOptions = { includeReasoning?: boolean }

type Loose = Record<string, unknown>

export function isRecord(value: unknown): value is Loose {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

const str = (value: unknown): string => (typeof value === "string" ? value : "")

export function newTurn(kind: Turn["kind"], time: number | null, user = ""): Turn {
  return {
    time,
    kind,
    user,
    attachments: [],
    assistant: [],
    reasoning: [],
    tools: [],
    notes: [],
    files: [],
    shells: [],
    parts: [],
  }
}

export function addText(turn: Turn, text: string): void {
  turn.assistant.push(text)
  turn.parts.push({ type: "text", text })
}

export function addReasoning(turn: Turn, text: string): void {
  turn.reasoning.push(text)
  turn.parts.push({ type: "reasoning", text })
}

export function addTrace(turn: Turn, trace: Trace): void {
  turn.tools.push(trace)
  turn.parts.push({ type: "tool", trace })
}

/** A turn with nothing a reader can use: no user text, prose, reasoning or tool call. */
export function isEmptyTurn(turn: Turn): boolean {
  return (
    !turn.user.trim() &&
    turn.assistant.every((text) => !text.trim()) &&
    turn.reasoning.length === 0 &&
    turn.tools.length === 0 &&
    turn.shells.length === 0
  )
}

const BRIEF_KEYS = ["description", "path", "command", "pattern", "url", "query", "id", "agent", "file", "task", "i"]

/** One short argument echo per tool call, never the whole payload. */
export function briefArgs(args: unknown): string {
  if (!isRecord(args)) return ""
  for (const key of BRIEF_KEYS) {
    const value = args[key]
    if (typeof value === "string" && value.trim()) return oneLine(clip(value, 120))
    if (typeof value === "number" || typeof value === "boolean") return String(value)
  }
  return ""
}

/** The first text content of a tool result, one line, or a file name. */
export function contentText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  for (const part of content) {
    if (!isRecord(part)) continue
    if (part.type === "text" && typeof part.text === "string") return part.text
    if (part.type === "file") return `[file ${str(part.name) || str(part.mime) || "attachment"}]`
  }
  return ""
}

/** Every text content of a tool result, joined; used for branch evidence. */
function allText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .filter((part): part is Loose => isRecord(part) && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n")
}

function metadataFiles(metadata: unknown): string[] {
  if (!isRecord(metadata) || !Array.isArray(metadata.files)) return []
  const out: string[] = []
  for (const file of metadata.files) {
    if (typeof file === "string") out.push(file)
    else if (isRecord(file)) {
      const path = str(file.path) || str(file.file) || str(file.filePath)
      if (path) out.push(path)
    }
  }
  return out
}

const shortTool = (name: string): string => name.split(".").pop() ?? name

/** Fold one assistant tool part into a turn: its trace, files, shell runs and nested execute calls. */
export function applyToolPart(turn: Turn, part: Loose): void {
  const name = str(part.name) || "?"
  const state = isRecord(part.state) ? part.state : {}
  const input = state.input
  const status = str(state.status)
  let result = ""
  let error = false
  if (status === "completed") result = contentText(state.content)
  else if (status === "error") {
    error = true
    result = isRecord(state.error) ? str(state.error.message) : contentText(state.content)
  } else if (status) result = `(${status})`
  const trace: Trace = { name, brief: briefArgs(input), result: clip(oneLine(result), 240), error }
  const metadata = state.metadata
  if (name === "subagent" && isRecord(metadata) && typeof metadata.sessionID === "string") trace.child = metadata.sessionID
  addTrace(turn, trace)

  turn.files.push(...writeTargets(name, input), ...metadataFiles(metadata))
  if (name === "shell" && isRecord(input) && typeof input.command === "string") {
    turn.shells.push({ command: input.command, output: allText(state.content) })
  }
  if (name === "execute" && isRecord(metadata) && Array.isArray(metadata.toolCalls)) {
    for (const call of metadata.toolCalls) {
      if (!isRecord(call)) continue
      const tool = str(call.tool) || "?"
      const callStatus = str(call.status)
      addTrace(turn, {
        name: `execute.${tool}`,
        brief: briefArgs(call.input),
        result: callStatus && callStatus !== "completed" ? `(${callStatus})` : "",
        error: callStatus === "error",
        nested: true,
      })
      const short = shortTool(tool)
      turn.files.push(...writeTargets(short, call.input))
      if (short === "shell" && isRecord(call.input) && typeof call.input.command === "string") {
        turn.shells.push({ command: call.input.command, output: "" })
      }
    }
  }
}

/** `## Heading` sections of a compaction summary, each clipped. */
export function compactionSections(summary: string, limit = 600): Section[] {
  const sections: Section[] = []
  let current: Section | undefined
  const body: string[] = []
  const flush = () => {
    if (current) sections.push({ heading: current.heading, body: clip(body.join("\n").trim(), limit) })
    body.length = 0
  }
  for (const line of summary.split("\n")) {
    const heading = /^##\s+(.+?)\s*$/.exec(line)
    if (heading?.[1]) {
      flush()
      current = { heading: heading[1], body: "" }
      continue
    }
    if (current) body.push(line)
  }
  flush()
  return sections
}

export function section(compaction: Compaction | undefined, heading: string): string | undefined {
  const wanted = heading.toLowerCase()
  return compaction?.sections.find((entry) => entry.heading.toLowerCase() === wanted)?.body
}

/** Drop empty turns and move the compaction boundary onto the kept turns. */
export function finishTurns(turns: Turn[], boundary: number): { turns: Turn[]; boundary: number } {
  const kept: Turn[] = []
  let keptBoundary = -1
  turns.forEach((turn, index) => {
    if (index >= boundary && keptBoundary < 0) keptBoundary = kept.length
    if (!isEmptyTurn(turn)) kept.push(turn)
  })
  return { turns: kept, boundary: keptBoundary < 0 ? kept.length : keptBoundary }
}

/** Normalize OpenCode V2 session messages (from `context()` or the message API) into turns. */
export function toTranscript(messages: readonly unknown[], options: NormalizeOptions = {}): Transcript {
  const turns: Turn[] = []
  const compactions: Compaction[] = []
  const locations: string[] = []
  let boundary = 0
  let current: Turn | undefined
  const open = (time: number | null): Turn => {
    if (current === undefined || current.ended !== undefined) {
      current = newTurn("orphan", time)
      turns.push(current)
    }
    return current
  }
  const start = (kind: Turn["kind"], time: number | null, user: string): Turn => {
    current = newTurn(kind, time, user)
    turns.push(current)
    return current
  }

  for (const raw of messages) {
    if (!isRecord(raw)) continue
    const time = isRecord(raw.time) && typeof raw.time.created === "number" ? raw.time.created : null
    switch (raw.type) {
      case "user": {
        const turn = start("user", time, str(raw.text))
        if (Array.isArray(raw.files)) {
          for (const file of raw.files) {
            if (isRecord(file)) turn.attachments.push(str(file.name) || str(file.mime) || "attachment")
          }
        }
        break
      }
      case "shell": {
        const output = isRecord(raw.output) ? str(raw.output.output) : ""
        const turn = start("shell", time, `$ ${str(raw.command)}`)
        turn.shells.push({ command: str(raw.command), output })
        break
      }
      case "skill": {
        const name = str(raw.name) || str(raw.skill)
        const usable = current && current.ended === undefined && current.assistant.length === 0 && current.tools.length === 0
        if (usable && current) current.notes.push(`skill: ${name}`)
        else start("skill", time, `/${name}`)
        break
      }
      case "assistant": {
        const turn = open(time)
        if (Array.isArray(raw.content)) {
          for (const part of raw.content) {
            if (!isRecord(part)) continue
            if (part.type === "text" && typeof part.text === "string") addText(turn, part.text)
            else if (part.type === "reasoning" && options.includeReasoning && typeof part.text === "string")
              addReasoning(turn, part.text)
            else if (part.type === "tool") applyToolPart(turn, part)
          }
        }
        if (isRecord(raw.snapshot)) turn.files.push(...metadataFiles(raw.snapshot))
        if (typeof raw.finish === "string") turn.finish = raw.finish
        if (isRecord(raw.error)) turn.error = str(raw.error.message) || str(raw.error.type)
        break
      }
      case "synthetic": {
        const turn = open(time)
        const description = oneLine(str(raw.description))
        turn.notes.push(`synthetic: ${description || clip(oneLine(str(raw.text)), 120)}`)
        break
      }
      case "compaction": {
        if (raw.status !== "completed") break
        const summary = str(raw.summary)
        compactions.push({ time, summary, sections: compactionSections(summary) })
        current = undefined
        boundary = turns.length
        break
      }
      case "idle": {
        if (current && current.ended === undefined) {
          current.ended = (str(raw.outcome) || "succeeded") as Outcome
          if (isRecord(raw.error)) current.error = str(raw.error.message) || current.error
        }
        break
      }
      case "location-switched": {
        const directory = isRecord(raw.location) ? str(raw.location.directory) : ""
        if (directory) locations.push(directory)
        break
      }
      default:
        break
    }
  }
  const finished = finishTurns(turns, boundary)
  return { ...finished, compactions, locations, messages: messages.length }
}
