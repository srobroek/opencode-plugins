/** Builders for OpenCode V2 session messages and omp transcripts, for tests only. */

import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

let counter = 0
const nextId = (prefix: string) => `${prefix}_${(++counter).toString(16).padStart(6, "0")}`
let clock = Date.parse("2026-10-20T10:00:00.000Z")
const tick = () => {
  clock += 60_000
  return clock
}

export const user = (text: string, extra: Record<string, unknown> = {}) => ({
  id: nextId("msg"),
  type: "user",
  time: { created: tick() },
  text,
  ...extra,
})

export type ToolSpec = {
  name: string
  input?: Record<string, unknown>
  output?: string
  error?: string
  status?: "completed" | "error" | "running"
  metadata?: Record<string, unknown>
}

export const tool = (spec: ToolSpec) => {
  const status = spec.status ?? (spec.error ? "error" : "completed")
  const state: Record<string, unknown> = { status, input: spec.input ?? {} }
  if (status === "completed") state.content = [{ type: "text", text: spec.output ?? "" }]
  if (status === "error") state.error = { type: "tool", message: spec.error ?? "failed" }
  if (status === "running") state.metadata = {}
  if (spec.metadata) state.metadata = spec.metadata
  return { type: "tool", id: nextId("call"), name: spec.name, state, time: { created: clock } }
}

export const assistant = (
  parts: Array<string | { reasoning: string } | ReturnType<typeof tool>>,
  extra: Record<string, unknown> = {},
) => ({
  id: nextId("msg"),
  type: "assistant",
  time: { created: tick(), completed: clock },
  agent: "build",
  model: { providerID: "test", id: "model" },
  content: parts.map((part) =>
    typeof part === "string"
      ? { type: "text", text: part }
      : "reasoning" in part
        ? { type: "reasoning", text: part.reasoning }
        : part,
  ),
  ...extra,
})

export const idle = (outcome: "succeeded" | "failed" | "interrupted" = "succeeded", error?: string) => ({
  id: nextId("msg"),
  type: "idle",
  time: { created: tick() },
  outcome,
  ...(error ? { error: { type: "x", message: error } } : {}),
})

export const compaction = (summary: string, status: "completed" | "running" | "failed" = "completed") => ({
  id: nextId("msg"),
  type: "compaction",
  time: { created: tick() },
  status,
  reason: "auto",
  summary,
})

export const synthetic = (text: string, description?: string) => ({
  id: nextId("msg"),
  type: "synthetic",
  time: { created: tick() },
  text,
  ...(description ? { description } : {}),
})

export const shellMessage = (command: string, output = "") => ({
  id: nextId("msg"),
  type: "shell",
  time: { created: tick() },
  shellID: nextId("sh"),
  command,
  status: "exited",
  exit: 0,
  output: { output, cursor: 0, size: output.length, truncated: false },
})

export const skillMessage = (name: string) => ({
  id: nextId("msg"),
  type: "skill",
  time: { created: tick() },
  skill: name,
  name,
  text: "",
})

export const moved = (directory: string) => ({
  id: nextId("msg"),
  type: "location-switched",
  time: { created: tick() },
  location: { directory },
})

export const SUMMARY = [
  "## Objective",
  "- Ship the CSV export command",
  "",
  "## Decisions",
  "- Use a streaming writer",
  "",
  "## Next Move",
  "- Wire the --csv flag into the CLI",
].join("\n")

export const session = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  projectID: "proj_1",
  cost: 0,
  tokens: {},
  time: { created: 1, updated: 1 },
  location: { directory: "/repo/main" },
  ...extra,
})

// omp ---------------------------------------------------------------------------

export type OmpEntry =
  | { kind: "user"; text: string; at?: string }
  | {
      kind: "assistant"
      text?: string
      thinking?: string
      tools?: Array<{ name: string; args?: Record<string, unknown>; intent?: string; result?: string; isError?: boolean }>
      at?: string
    }
  | { kind: "todo"; phases: Array<{ name: string; tasks: Array<{ content: string; status: string }> }>; at?: string }
  | { kind: "compaction"; summary: string; at?: string }
  | { kind: "exit"; reason: string; exitKind: string; at?: string }

export type OmpSession = {
  stem: string
  cwd: string
  title?: string
  updatedAt?: string
  entries: OmpEntry[]
}

/** One omp session in the store's one-record-per-line form. */
export function renderOmp(fixture: OmpSession): string {
  const uuid = fixture.stem.split("_").slice(1).join("_") || fixture.stem
  const lines: string[] = [
    JSON.stringify({
      type: "title",
      v: 1,
      title: fixture.title ?? "",
      updatedAt: fixture.updatedAt ?? "2026-08-24T12:00:00.000Z",
      pad: " ".repeat(16),
    }),
    JSON.stringify({ type: "session", version: 3, id: uuid, timestamp: "2026-08-24T10:00:00.000Z", cwd: fixture.cwd }),
  ]
  fixture.entries.forEach((entry, index) => {
    const timestamp = entry.at ?? `2026-08-24T10:${String(index).padStart(2, "0")}:00.000Z`
    const message = (body: Record<string, unknown>) =>
      JSON.stringify({ type: "message", id: nextId("e"), parentId: null, timestamp, message: { timestamp, ...body } })
    if (entry.kind === "user") {
      lines.push(message({ role: "user", content: [{ type: "text", text: entry.text }] }))
    } else if (entry.kind === "compaction") {
      lines.push(JSON.stringify({ type: "compaction", id: nextId("e"), timestamp, shortSummary: entry.summary, summary: entry.summary }))
    } else if (entry.kind === "exit") {
      lines.push(
        JSON.stringify({ type: "custom", customType: "session_exit", id: nextId("e"), timestamp, data: { reason: entry.reason, kind: entry.exitKind } }),
      )
    } else if (entry.kind === "todo") {
      const callId = nextId("tool")
      lines.push(
        message({ role: "assistant", content: [{ type: "toolCall", id: callId, name: "todo", arguments: { op: "done" } }] }),
        message({
          role: "toolResult",
          toolCallId: callId,
          toolName: "todo",
          isError: false,
          content: [{ type: "text", text: "board updated" }],
          details: { phases: entry.phases },
        }),
      )
    } else {
      const content: Record<string, unknown>[] = []
      if (entry.thinking) content.push({ type: "thinking", thinking: entry.thinking })
      if (entry.text) content.push({ type: "text", text: entry.text })
      const results: string[] = []
      for (const call of entry.tools ?? []) {
        const callId = nextId("tool")
        content.push({ type: "toolCall", id: callId, name: call.name, arguments: call.args ?? {}, ...(call.intent ? { intent: call.intent } : {}) })
        if (call.result !== undefined) {
          results.push(
            message({
              role: "toolResult",
              toolCallId: callId,
              toolName: call.name,
              isError: call.isError === true,
              content: [{ type: "text", text: call.result }],
            }),
          )
        }
      }
      lines.push(message({ role: "assistant", content }), ...results)
    }
  })
  return `${lines.join("\n")}\n`
}

/** Write sessions into an omp store root, one directory per escaped cwd. */
export function writeOmpStore(root: string, sessions: OmpSession[]): string[] {
  return sessions.map((fixture) => {
    const file = join(root, fixture.cwd.replace(/\//g, "-"), `${fixture.stem}.jsonl`)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, renderOmp(fixture))
    return file
  })
}
