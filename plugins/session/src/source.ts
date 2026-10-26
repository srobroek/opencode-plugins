/**
 * Where sessions come from. Every source is read-only.
 *
 * - `opencode` (default): the plugin context's `session.list`, `get` and `context`.
 *   `context()` starts at the last completed compaction, so older turns are not loaded.
 * - `api`: `opencode api get …` against the background service, paging the full
 *   message history. Opt-in, because that service is not necessarily the server
 *   running this session.
 * - `omp`: Oh My Pi JSONL transcripts (see `omp.ts`).
 */

import type { Context } from "@opencode/plugin/promise/plugin"
import { isRecord, type NormalizeOptions, type Transcript, toTranscript } from "./transcript.ts"

export type SourceKind = "opencode" | "api" | "omp"

export interface Summary {
  id: string
  title?: string
  directory: string
  projectID?: string
  parentID?: string
  created: number | null
  updated: number | null
  archived: boolean
  outcome?: string
}

export type RootQuery = {
  project?: string
  directory?: string
  search?: string
  archived?: boolean
}

export interface Source {
  readonly kind: SourceKind
  /** Whether `transcript` includes turns from before the last compaction. */
  readonly complete: boolean
  /** Top-level sessions, newest first. */
  roots(query: RootQuery, signal?: AbortSignal): AsyncIterable<Summary>
  info(id: string): Promise<Summary | undefined>
  transcript(id: string, options: NormalizeOptions): Promise<Transcript>
}

type Loose = Record<string, unknown>

const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null)

/** A V2 `Session.Info` (plugin or HTTP shape) as a summary. */
export function toSummary(raw: unknown): Summary | undefined {
  if (!isRecord(raw) || typeof raw.id !== "string") return undefined
  const time = isRecord(raw.time) ? raw.time : {}
  const location = isRecord(raw.location) ? raw.location : {}
  const summary: Summary = {
    id: raw.id,
    directory: typeof location.directory === "string" ? location.directory : "",
    created: num(time.created),
    updated: num(time.updated),
    archived: time.archived !== undefined && time.archived !== null,
  }
  if (typeof raw.title === "string" && raw.title) summary.title = raw.title
  if (typeof raw.projectID === "string") summary.projectID = raw.projectID
  if (typeof raw.parentID === "string") summary.parentID = raw.parentID
  if (typeof raw.outcome === "string") summary.outcome = raw.outcome
  return summary
}

/** The list filter every source call uses: top-level only, archived excluded unless asked. */
export function listQuery(query: RootQuery, limit: number): Loose {
  const out: Loose = { parentID: null, order: "desc", limit, archived: query.archived === true }
  if (query.project !== undefined) out.project = query.project
  if (query.directory !== undefined) out.directory = query.directory
  if (query.search) out.search = query.search
  return out
}

export type SessionClient = Pick<Context["session"], "list" | "get" | "context">

/** The default source: the plugin context. Touches only `list`, `get` and `context`. */
export function ctxSource(session: SessionClient, pageSize = 50): Source {
  return {
    kind: "opencode",
    complete: false,
    async *roots(query, signal) {
      // The host's default list includes children and archived sessions; always filter.
      let page = await session.list(listQuery(query, pageSize) as Parameters<SessionClient["list"]>[0])
      for (;;) {
        signal?.throwIfAborted()
        for (const raw of page.data) {
          const summary = toSummary(raw)
          if (summary) yield summary
        }
        const next = page.cursor?.next
        if (!next) return
        page = await session.list({ cursor: next } as Parameters<SessionClient["list"]>[0])
      }
    },
    async info(id) {
      try {
        return toSummary(await session.get({ sessionID: id }))
      } catch {
        return undefined
      }
    },
    async transcript(id, options) {
      return toTranscript((await session.context({ sessionID: id })) as readonly unknown[], options)
    },
  }
}

/** Runs `opencode api get <path>` and returns stdout. */
export type ApiRunner = (path: string) => Promise<string>

/** `args` go after `api`, for example `["--server", "http://127.0.0.1:4096"]`. */
export function spawnApiRunner(command: readonly string[] = ["opencode"], args: readonly string[] = []): ApiRunner {
  return async (path) => {
    const child = Bun.spawn([...command, "api", ...args, "get", path], { stdout: "pipe", stderr: "pipe", stdin: "ignore" })
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (code !== 0) throw new Error(`opencode api get ${path} exited ${code}: ${stderr.trim().slice(0, 300)}`)
    return stdout
  }
}

function queryString(params: Loose): string {
  const parts: string[] = []
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value === null ? "null" : String(value))}`)
  }
  return parts.join("&")
}

function unwrap(raw: unknown): unknown {
  return isRecord(raw) && "data" in raw && !("id" in raw) && !Array.isArray(raw.data) ? raw.data : raw
}

/**
 * The `api` source. Query strings go in the path: `opencode api get` ignores
 * `--param` for raw paths. The message cursor is not combined with `order`.
 */
export function apiSource(run: ApiRunner, options: { pageSize?: number; maxMessages?: number } = {}): Source {
  const pageSize = options.pageSize ?? 50
  const maxMessages = options.maxMessages ?? 5000
  const get = async (path: string): Promise<unknown> => JSON.parse(await run(path))
  return {
    kind: "api",
    complete: true,
    async *roots(query, signal) {
      let page = unwrap(await get(`/api/session?${queryString(listQuery(query, pageSize))}`))
      for (;;) {
        signal?.throwIfAborted()
        const data = isRecord(page) && Array.isArray(page.data) ? page.data : []
        for (const raw of data) {
          const summary = toSummary(raw)
          if (summary) yield summary
        }
        const cursor = isRecord(page) && isRecord(page.cursor) ? page.cursor.next : undefined
        if (typeof cursor !== "string" || !cursor) return
        page = unwrap(await get(`/api/session?${queryString({ cursor })}`))
      }
    },
    async info(id) {
      try {
        return toSummary(unwrap(await get(`/api/session/${encodeURIComponent(id)}`)))
      } catch {
        return undefined
      }
    },
    async transcript(id, normalize) {
      const newestFirst: unknown[] = []
      let path = `/api/session/${encodeURIComponent(id)}/message?${queryString({ order: "desc", limit: pageSize })}`
      while (newestFirst.length < maxMessages) {
        const page = await get(path)
        const data = isRecord(page) && Array.isArray(page.data) ? page.data : Array.isArray(page) ? page : []
        newestFirst.push(...data)
        const cursor = isRecord(page) && isRecord(page.cursor) ? page.cursor.next : undefined
        if (typeof cursor !== "string" || !cursor || data.length === 0) break
        path = `/api/session/${encodeURIComponent(id)}/message?${queryString({ cursor, limit: pageSize })}`
      }
      return toTranscript(newestFirst.reverse(), normalize)
    },
  }
}
