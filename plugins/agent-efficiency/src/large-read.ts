import { closeSync, openSync, readSync, statSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"
import type { Context } from "@opencode/plugin/promise/plugin"
import { commandWords } from "@srobroek/opencode-lib/command-words"
import { scanShell } from "@srobroek/opencode-lib/shell-command"
import { shellCall } from "@srobroek/opencode-lib/tool-targets"
import { onSessionDeleted } from "./session-cache.ts"
import { CONTROL_PREFIXES, commandScripts } from "./shell-scripts.ts"

export type LargeReadOptions = { agents: ReadonlySet<string>; bytes: number; lines: number }

export const DEFAULT_LARGE_READ_AGENTS: ReadonlyArray<string> = ["coder", "general", "implementer", "implementer-high"]
export const DEFAULT_LARGE_READ_BYTES = 32768
export const DEFAULT_LARGE_READ_LINES = 350
/** The most a size check reads from a file. */
export const SNIFF_LIMIT = 1024 * 1024

const BINARY_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "tif", "tiff", "avif", "heic", "svgz", "pdf",
  "zip", "gz", "tgz", "bz2", "xz", "zst", "7z", "rar", "tar", "jar", "wasm", "so", "dylib", "dll", "exe", "bin", "o", "a",
  "mp3", "mp4", "mov", "avi", "mkv", "webm", "wav", "flac", "ogg", "ttf", "otf", "woff", "woff2", "sqlite", "db", "parquet", "pyc", "class",
])

/** `largeRead` option: off with `false`, otherwise on with defaults for anything unset or invalid. */
export function parseLargeReadOptions(options: Record<string, unknown>): LargeReadOptions | undefined {
  const raw = options.largeRead
  if (raw === false) return undefined
  const value = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {}
  const positive = (field: unknown, fallback: number) => typeof field === "number" && Number.isFinite(field) && field > 0 ? field : fallback
  const agents = Array.isArray(value.agents) ? value.agents.filter((id): id is string => typeof id === "string") : DEFAULT_LARGE_READ_AGENTS
  return {
    agents: new Set(agents),
    bytes: positive(value.bytes, DEFAULT_LARGE_READ_BYTES),
    lines: positive(value.lines, DEFAULT_LARGE_READ_LINES),
  }
}

export type LargeFile = { bytes: number; lines: number; truncated: boolean }

/**
 * The size of a regular text file when it is over `bytes` or `lines`, else `undefined`.
 * Images, PDFs and other binaries (by extension or a NUL byte in the first 8 KiB),
 * directories and unreadable or missing paths are `undefined`. Never reads more than
 * `SNIFF_LIMIT`, so `lines` is a lower bound (`truncated`) for a larger file.
 */
export function largeFile(path: string, limits: { bytes: number; lines: number }): LargeFile | undefined {
  const extension = path.includes(".") ? path.slice(path.lastIndexOf(".") + 1).toLowerCase() : ""
  if (BINARY_EXTENSIONS.has(extension)) return undefined
  let fd: number | undefined
  try {
    const stat = statSync(path)
    if (!stat.isFile() || stat.size === 0) return undefined
    const buffer = Buffer.alloc(Math.min(stat.size, SNIFF_LIMIT))
    fd = openSync(path, "r")
    const read = readSync(fd, buffer, 0, buffer.length, 0)
    const sample = buffer.subarray(0, read)
    if (sample.subarray(0, 8192).includes(0)) return undefined
    let lines = 0
    for (let at = sample.indexOf(10); at >= 0; at = sample.indexOf(10, at + 1)) lines++
    if (sample.length > 0 && sample[sample.length - 1] !== 10) lines++
    if (stat.size <= limits.bytes && lines <= limits.lines) return undefined
    return { bytes: stat.size, lines, truncated: stat.size > SNIFF_LIMIT }
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

export function largeReadRefusal(path: string, file: LargeFile): string {
  const lines = file.truncated ? `${file.lines}+` : `${file.lines}`
  const kib = Math.ceil(file.bytes / 1024)
  return `agent-efficiency large-read: ${path} has ${lines} lines / ${kib} KiB. Read the part you need with \`read\` offset/limit, or search it with \`grep\`. To get a summary or the relevant lines from a large file or log, delegate to \`explore\` (files) or \`operator\` (logs and command output), and ask for line numbers.`
}

/** The path an untargeted `read` call names, or `undefined` when it has `offset` or `limit` or no path. */
export function untargetedReadPath(tool: string, input: unknown): string | undefined {
  if (tool !== "read" || input === null || typeof input !== "object") return undefined
  const value = input as Record<string, unknown>
  if (value.offset != null || value.limit != null) return undefined
  return typeof value.path === "string" && value.path ? value.path : undefined
}

const WHOLE_FILE_READERS = new Set(["cat", "less", "more"])
const PIPES = new Set(["|", "|&"])
const OPEN_GROUPS = new Set(["(", "{"])
const CLOSE_GROUPS = new Set([")", "}"])

/** Whether a redirection word is an output target (`> f`, `>> f`, `&> f`, `1> f`), not `2> f` or `>&1`. */
function writesStdout(source: string, start: number): boolean {
  return /(?:^|[^\d])\d{0,1}(?:>>?|>\|)\s*$/.test(source.slice(0, start)) && !/(?:^|[^\d])2(?:>>?|>\|)\s*$/.test(source.slice(0, start))
}

function cdTarget(args: readonly string[], dir: string | null, expands: boolean): string | null {
  const target = args[0] === "--" ? args[1] : args[0]
  if (dir === null || expands || target === undefined || target === "-" || target.startsWith("~") || /[$`]/.test(target)) return null
  return resolve(dir, target)
}

/**
 * Absolute paths a shell command shows whole with `cat`, `less` or `more` while the output
 * goes to the terminal: not piped to another command, not redirected to a file. Follows
 * `sh -c`, `eval`, `xargs`, loops, groups, substitutions and `cd`.
 */
export function wholeFileReads(command: string, cwd: string, depth = 0): string[] {
  if (depth > 32) return []
  const found: string[] = []
  let dir: string | null = cwd
  const saved: Array<{ dir: string | null; start: number }> = []
  const scan = scanShell(command, { executableSubstitutionsOnly: true })
  for (const source of scan.substitutions) found.push(...wholeFileReads(source, dir ?? cwd, depth + 1))
  const { items } = scan
  for (let index = 0; index < items.length; index++) {
    const item = items[index]
    if (item === undefined) continue
    if (item.kind === "operator") {
      if (OPEN_GROUPS.has(item.operator)) saved.push({ dir, start: found.length })
      else if (CLOSE_GROUPS.has(item.operator)) {
        const group = saved.pop()
        if (group !== undefined) {
          if (item.operator === ")") dir = group.dir
          const next = items[index + 1]
          if (next?.kind === "operator" && PIPES.has(next.operator)) found.length = group.start
        }
      }
      continue
    }
    const words = [...item.words]
    while (words[0] && !words[0].quoted && CONTROL_PREFIXES.has(words[0].value)) words.shift()
    const { argv } = commandWords(words.map((word) => word.value))
    const offset = words.length - argv.length
    const executable = words[offset]
    if (!executable || executable.quoted || executable.expands) continue
    const name = argv[0]?.split("/").pop() ?? ""
    if (name === "cd") {
      dir = cdTarget(argv.slice(1), dir, words.slice(offset + 1).some((word) => word.expands))
      continue
    }
    for (const source of commandScripts(argv, item.hereDocuments)) found.push(...wholeFileReads(source, dir ?? cwd, depth + 1))
    if (!WHOLE_FILE_READERS.has(name)) continue
    const next = items[index + 1]
    if (next?.kind === "operator" && PIPES.has(next.operator)) continue
    if (item.redirects.some((redirect) => writesStdout(command, redirect.start))) continue
    for (let at = 1; at < argv.length; at++) {
      const word = words[offset + at]
      const arg = argv[at] as string
      if (!word || arg === "--" || arg === "-" || arg.startsWith("-") || word.expands || /[$`]/.test(arg)) continue
      if (isAbsolute(arg)) found.push(arg)
      else if (dir !== null) found.push(resolve(dir, arg))
    }
  }
  return found
}

type SessionState = { info: Promise<{ child: boolean; directory: string }>; seen: Set<string> }

export async function setupLargeRead(ctx: Context, options: LargeReadOptions): Promise<() => Promise<void>> {
  const sessions = new Map<string, SessionState>()
  const stop = onSessionDeleted(ctx, (sessionID) => sessions.delete(sessionID))
  const fallback = process.cwd()
  const stateFor = (sessionID: string): SessionState => {
    let state = sessions.get(sessionID)
    if (state === undefined) {
      const info = ctx.session.get({ sessionID } as never).then((session) => {
        const found = session as { parentID?: string | null; location?: { directory?: string } }
        return { child: typeof found.parentID === "string", directory: found.location?.directory ?? fallback }
      }).catch(() => ({ child: true, directory: fallback }))
      state = { info, seen: new Set() }
      sessions.set(sessionID, state)
    }
    return state
  }
  const hook = await ctx.tool.hook("execute.before", async (event) => {
    const shell = shellCall(event.tool, event.input)
    const target = shell ? undefined : untargetedReadPath(event.tool, event.input)
    if (!shell && target === undefined) return
    const state = stateFor(event.sessionID)
    const { child, directory } = await state.info
    if ((child && !options.agents.has(event.agent)) || sessions.get(event.sessionID) !== state) return
    const base = shell?.workdir ? resolve(directory, shell.workdir) : directory
    const paths = shell ? wholeFileReads(shell.command, base) : [resolve(base, target as string)]
    const reasons: string[] = []
    for (const path of new Set(paths)) {
      if (state.seen.has(path)) continue
      const file = largeFile(path, options)
      if (file === undefined) continue
      state.seen.add(path)
      reasons.push(largeReadRefusal(path, file))
    }
    if (reasons.length) throw new Error(reasons.join("\n"))
  })
  return async () => {
    await stop()
    await hook.dispose()
    sessions.clear()
  }
}
