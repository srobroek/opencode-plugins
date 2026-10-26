/**
 * Read-only `omp` source: Oh My Pi JSONL transcripts under `~/.omp/agent/sessions`.
 *
 * Parsing is ported from omp-plugins `session/extensions/store.ts` without the
 * `@oh-my-pi/*` packages: a small streaming JSONL visitor replaces the native one.
 * Each file is read up to its size at the start, malformed lines are skipped, and
 * a file that changes during the read is an error rather than a partial result.
 */

import { type Dirent, existsSync, readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { pathKeys } from "./git.ts"
import type { RootQuery, Source, Summary } from "./source.ts"
import { clip, oneLine } from "./text.ts"
import {
  addReasoning,
  addText,
  addTrace,
  briefArgs,
  compactionSections,
  finishTurns,
  isRecord,
  type NormalizeOptions,
  newTurn,
  type ShellRun,
  type TodoPhase,
  type TodoTask,
  type Trace,
  type Transcript,
  type Turn,
} from "./transcript.ts"

export const DEFAULT_OMP_DIR = join(homedir(), ".omp", "agent", "sessions")

interface Snapshot {
  size: number
  mtimeMs: number
  ctimeMs: number
}

function snapshot(file: string): Snapshot {
  const info = statSync(file)
  if (!info.isFile()) throw new Error(`Transcript must be a regular file: ${file}`)
  return { size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs }
}

function assertUnchanged(file: string, before: Snapshot): void {
  const after = snapshot(file)
  if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
    throw new Error(`Transcript changed while being read: ${file}. Retry after the session stops writing.`)
  }
}

/**
 * Stream JSON lines from `file`, up to `maxBytes` (default: its size at the start).
 * Malformed lines, including a truncated final line, are skipped. Return `false`
 * from `visit` to stop early.
 */
export async function visitJsonl(
  file: string,
  visit: (entry: unknown) => boolean | undefined,
  maxBytes?: number,
): Promise<void> {
  const before = snapshot(file)
  const limit = Math.min(before.size, maxBytes ?? before.size)
  const decoder = new TextDecoder()
  let buffer = ""
  let stopped = false
  const emit = (line: string): void => {
    if (stopped || !line.trim()) return
    let entry: unknown
    try {
      entry = JSON.parse(line)
    } catch {
      return
    }
    if (visit(entry) === false) stopped = true
  }
  for await (const chunk of Bun.file(file).slice(0, limit).stream()) {
    buffer += decoder.decode(chunk, { stream: true })
    let newline = buffer.indexOf("\n")
    while (newline >= 0) {
      emit(buffer.slice(0, newline))
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf("\n")
    }
    if (stopped) break
  }
  buffer += decoder.decode()
  // A head read stops mid-file; only a full read may parse the unterminated tail.
  if (!stopped && limit === before.size) emit(buffer)
  if (maxBytes === undefined || limit === before.size) assertUnchanged(file, before)
}

function parseTime(value: unknown): number | null {
  if (typeof value !== "string" || !value) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

/** Every `*.jsonl` one level under the store's directories; spill directories are ignored. */
export function storeFiles(root: string): string[] {
  if (!existsSync(root)) return []
  const out: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = join(root, entry.name)
    let children: Dirent[]
    try {
      children = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const child of children) if (child.isFile() && child.name.endsWith(".jsonl")) out.push(join(dir, child.name))
  }
  return out
}

export interface OmpHead {
  id: string
  file: string
  cwd: string
  title: string
  startedAtMs: number | null
  updatedAtMs: number | null
  continuedFrom: number
}

const stemId = (file: string): string =>
  (file.split("/").pop() ?? file).replace(/\.jsonl$/, "").replace(/^[^_]*_/, "")

/** Identity from the leading records: the `title` header and the `session` record. */
export async function readHead(file: string, maxBytes = 16 * 1024): Promise<OmpHead | null> {
  if (!existsSync(file)) return null
  const head: OmpHead = {
    id: stemId(file),
    file,
    cwd: "",
    title: "",
    startedAtMs: null,
    updatedAtMs: null,
    continuedFrom: 0,
  }
  let sawSession = false
  await visitJsonl(
    file,
    (entry) => {
      if (!isRecord(entry)) return
      if (entry.type === "title") {
        if (typeof entry.title === "string") head.title = entry.title
        head.updatedAtMs = parseTime(entry.updatedAt) ?? head.updatedAtMs
        return
      }
      if (entry.type !== "session") return sawSession ? false : undefined
      sawSession = true
      if (typeof entry.cwd === "string") head.cwd = entry.cwd
      if (typeof entry.id === "string") head.id = entry.id
      head.startedAtMs = parseTime(entry.timestamp)
      if (Array.isArray(entry.previousSessionFiles)) head.continuedFrom = entry.previousSessionFiles.length
      if (typeof entry.title === "string" && entry.title) head.title = entry.title
      return false
    },
    maxBytes,
  )
  if (head.updatedAtMs === null) head.updatedAtMs = statSync(file).mtimeMs
  return head.cwd ? head : null
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .filter((block): block is Record<string, unknown> => isRecord(block) && block.type === "text")
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .join("\n")
}

/** The todo board in a `todo` tool result; an empty board clears earlier tasks. */
export function todoBoard(message: Record<string, unknown>): TodoPhase[] | undefined {
  if (message.toolName !== "todo" || !isRecord(message.details) || !Array.isArray(message.details.phases)) return undefined
  const phases: TodoPhase[] = []
  for (const phase of message.details.phases) {
    if (!isRecord(phase)) continue
    const tasks: TodoTask[] = []
    if (Array.isArray(phase.tasks)) {
      for (const task of phase.tasks) {
        if (!isRecord(task)) continue
        tasks.push({
          content: typeof task.content === "string" ? task.content : "",
          status: typeof task.status === "string" ? task.status : "",
        })
      }
    }
    if (tasks.length > 0) phases.push({ name: typeof phase.name === "string" ? phase.name : "", tasks })
  }
  return phases
}

const WRITE_TOOLS = new Set(["edit", "write", "ast_edit"])

/** Parse an omp transcript into the shared turn model. */
export async function parseOmpTranscript(file: string, options: NormalizeOptions = {}): Promise<Transcript> {
  const turns: Turn[] = []
  const compactions: Transcript["compactions"] = []
  let boundary = 0
  let todo: TodoPhase[] | undefined
  let exitReason: string | undefined
  let messages = 0
  let current: Turn | undefined
  const pending = new Map<string, { trace: Trace; run?: ShellRun }>()

  await visitJsonl(file, (entry) => {
    if (!isRecord(entry)) return
    messages += 1
    const time = parseTime(entry.timestamp)
    if (entry.type === "compaction") {
      const summary =
        typeof entry.summary === "string" && entry.summary
          ? entry.summary
          : typeof entry.shortSummary === "string"
            ? entry.shortSummary
            : ""
      compactions.push({ time, summary, sections: compactionSections(summary) })
      boundary = turns.length
      current = undefined
      return
    }
    if (entry.type === "custom" && entry.customType === "session_exit") {
      const data = isRecord(entry.data) ? entry.data : {}
      exitReason = [data.kind, data.reason].filter((part) => typeof part === "string" && part).join("/")
      return
    }
    if (entry.type !== "message" || !isRecord(entry.message)) return
    const message = entry.message
    if (message.role === "toolResult") {
      const ref = pending.get(String(message.toolCallId ?? ""))
      const text = textOf(message.content)
      if (ref) {
        ref.trace.result = clip(oneLine(text), 240)
        ref.trace.error = message.isError === true
        if (ref.run) ref.run.output = text
      }
      const board = todoBoard(message)
      if (board !== undefined) todo = board
      return
    }
    if (message.role === "user") {
      current = newTurn("user", time, textOf(message.content))
      turns.push(current)
      return
    }
    if (message.role !== "assistant") return
    if (!current) {
      current = newTurn("orphan", time)
      turns.push(current)
    }
    const turn = current
    if (typeof message.content === "string") addText(turn, message.content)
    if (!Array.isArray(message.content)) return
    for (const block of message.content) {
      if (!isRecord(block)) continue
      if (block.type === "text" && typeof block.text === "string") addText(turn, block.text)
      else if (block.type === "thinking" && options.includeReasoning && typeof block.thinking === "string")
        addReasoning(turn, block.thinking)
      else if (block.type === "toolCall") {
        const name = typeof block.name === "string" ? block.name : "?"
        const args = isRecord(block.arguments) ? block.arguments : {}
        const trace: Trace = {
          name,
          brief: typeof block.intent === "string" && block.intent ? oneLine(block.intent) : briefArgs(args),
          result: "",
          error: false,
        }
        addTrace(turn, trace)
        let run: ShellRun | undefined
        if (name === "bash" && typeof args.command === "string") {
          run = { command: args.command, output: "" }
          turn.shells.push(run)
        }
        if (WRITE_TOOLS.has(name) && typeof args.path === "string") turn.files.push(args.path)
        if (typeof block.id === "string") pending.set(block.id, { trace, run })
      }
    }
  })
  const finished = finishTurns(turns, boundary)
  const transcript: Transcript = { ...finished, compactions, locations: [], messages }
  if (todo !== undefined) transcript.todo = todo
  if (exitReason) transcript.exitReason = exitReason
  return transcript
}

function headSummary(head: OmpHead): Summary {
  const summary: Summary = {
    id: head.id,
    directory: head.cwd,
    created: head.startedAtMs,
    updated: head.updatedAtMs,
    archived: false,
  }
  if (head.title) summary.title = head.title
  return summary
}

/**
 * The omp source. `family` is the accept-set of directory spellings for this
 * repository; a query with `project` set keeps only sessions recorded there.
 */
export function ompSource(root: string, family: ReadonlySet<string>): Source {
  let heads: Promise<OmpHead[]> | undefined
  const all = (): Promise<OmpHead[]> => {
    heads ??= (async () => {
      const out: OmpHead[] = []
      for (const file of storeFiles(root)) {
        try {
          const head = await readHead(file)
          if (head) out.push(head)
        } catch {
          // A transcript being written or unreadable is skipped in listings.
        }
      }
      return out.sort((a, b) => (b.updatedAtMs ?? 0) - (a.updatedAtMs ?? 0))
    })()
    return heads
  }
  const byId = async (id: string) => (await all()).find((head) => head.id === id)
  return {
    kind: "omp",
    complete: true,
    async *roots(query: RootQuery, signal?: AbortSignal) {
      const search = query.search?.toLowerCase()
      const directory = query.directory === undefined ? undefined : new Set(pathKeys(query.directory))
      for (const head of await all()) {
        signal?.throwIfAborted()
        const keys = pathKeys(head.cwd)
        if (query.project !== undefined && !keys.some((key) => family.has(key))) continue
        if (directory && !keys.some((key) => directory.has(key))) continue
        if (search && !head.title.toLowerCase().includes(search)) continue
        yield headSummary(head)
      }
    },
    async info(id) {
      const head = await byId(id)
      return head ? headSummary(head) : undefined
    },
    async transcript(id, options) {
      const head = await byId(id)
      if (!head) throw new Error(`no omp session ${id} under ${root}`)
      return parseOmpTranscript(head.file, options)
    },
  }
}
