import { stat as fsStat, open } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"
import type { Context } from "@opencode/plugin/promise/plugin"
import { commandWords } from "@srobroek/opencode-lib/command-words"
import { type ShellOperator, type SimpleCommand, scanShell } from "@srobroek/opencode-lib/shell-command"
import { shellCall } from "@srobroek/opencode-lib/tool-targets"
import { onSessionDeleted } from "./session-cache.ts"
import { CONTROL_PREFIXES, commandScripts } from "./shell-scripts.ts"

export type LargeReadOptions = { agents: ReadonlySet<string>; bytes: number; lines: number; timeoutMs: number }

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
    timeoutMs: positive(value.timeoutMs, DEFAULT_LARGE_READ_TIMEOUT_MS),
  }
}

export type LargeFile = { bytes: number; lines: number; truncated: boolean }

export const DEFAULT_LARGE_READ_TIMEOUT_MS = 500

/** The result of `work`, or `undefined` when it rejects or takes longer than `ms`. */
export async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<undefined>((done) => {
    timer = setTimeout(done, ms, undefined)
  })
  try {
    return await Promise.race([work, deadline])
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

async function inspect(path: string, limits: { bytes: number; lines: number }): Promise<LargeFile | undefined> {
  const stat = await fsStat(path)
  if (!stat.isFile() || stat.size === 0) return undefined
  const handle = await open(path, "r")
  try {
    const buffer = Buffer.alloc(Math.min(stat.size, SNIFF_LIMIT))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const sample = buffer.subarray(0, bytesRead)
    if (sample.subarray(0, 8192).includes(0)) return undefined
    let lines = 0
    for (let at = sample.indexOf(10); at >= 0; at = sample.indexOf(10, at + 1)) lines++
    if (sample.length > 0 && sample[sample.length - 1] !== 10) lines++
    if (stat.size <= limits.bytes && lines <= limits.lines) return undefined
    return { bytes: stat.size, lines, truncated: stat.size > SNIFF_LIMIT }
  } finally {
    await handle.close()
  }
}

/**
 * The size of a regular text file when it is over `bytes` or `lines`, else `undefined`.
 * Images, PDFs and other binaries (by extension or a NUL byte in the first 8 KiB),
 * directories and unreadable or missing paths are `undefined`, and so is a file the
 * filesystem does not answer for within `timeoutMs` (a stalled mount): the guard fails
 * open. Never reads more than `SNIFF_LIMIT`, so `lines` is a lower bound (`truncated`)
 * for a larger file.
 */
export async function largeFile(path: string, limits: { bytes: number; lines: number }, timeoutMs = DEFAULT_LARGE_READ_TIMEOUT_MS): Promise<LargeFile | undefined> {
  const extension = path.includes(".") ? path.slice(path.lastIndexOf(".") + 1).toLowerCase() : ""
  if (BINARY_EXTENSIONS.has(extension)) return undefined
  return withDeadline(inspect(path, limits), timeoutMs)
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
const LOOP_STARTS = new Set(["for", "while", "until", "select", "if"])
const LOOP_ENDS = new Set(["done", "fi"])

/** Whether a redirection word is an output target (`> f`, `>> f`, `&> f`, `1> f`), not `2> f` or `>&1`. */
function writesStdout(source: string, start: number): boolean {
  const before = source.slice(0, start)
  return /(?:^|[^\d])\d?(?:>>?|>\|)\s*$/.test(before) && !/(?:^|[^\d])2(?:>>?|>\|)\s*$/.test(before)
}

/** Whether a redirection word is a literal stdin file (`< f`, `0< f`), not a here-document, here-string or `<&`. */
function readsStdin(source: string, start: number): boolean {
  return /(?:^|[^<\d])0?<\s*$/.test(source.slice(0, start))
}

function literalDirectory(dir: string | null, target: string | undefined, expands: boolean): string | null {
  if (dir === null || expands || target === undefined || target === "-" || target.startsWith("~") || /[$`*?]/.test(target)) return null
  return resolve(dir, target)
}

function cdTarget(args: readonly string[], dir: string | null, expands: boolean): string | null {
  return literalDirectory(dir, args[0] === "--" ? args[1] : args[0], expands)
}

type Scope = { closes: (item: SimpleCommand | ShellOperator) => boolean; dir: string | null; start: number; restore: boolean }

const closesWith = (operator: string) => (item: SimpleCommand | ShellOperator) => item.kind === "operator" && item.operator === operator
const firstWord = (item: SimpleCommand): string | undefined => item.words[0] && !item.words[0].quoted ? item.words[0].value : undefined

/**
 * Absolute paths a shell command shows whole with `cat`, `less` or `more` while the output
 * goes to the terminal: not piped to another command, not redirected to a file. Follows
 * `sh -c`, `eval`, `xargs`, loops, groups, substitutions, `cd` and wrapper directories
 * (`env -C dir`). A pipe or output redirect on a script, group or loop covers the reads inside it.
 */
export function wholeFileReads(command: string, cwd: string, depth = 0): string[] {
  if (depth > 32) return []
  const found: string[] = []
  let dir: string | null = cwd
  const scopes: Scope[] = []
  const scan = scanShell(command, { executableSubstitutionsOnly: true })
  for (const source of scan.substitutions) found.push(...wholeFileReads(source, dir ?? cwd, depth + 1))
  const { items } = scan
  const silenced = (item: SimpleCommand | undefined, next: SimpleCommand | ShellOperator | undefined): boolean =>
    (next?.kind === "operator" && PIPES.has(next.operator)) || (item?.redirects.some((redirect) => writesStdout(command, redirect.start)) ?? false)
  for (let index = 0; index < items.length; index++) {
    const item = items[index]
    if (item === undefined) continue
    const next = items[index + 1]
    if (item.kind === "operator") {
      if (item.operator === "(" || item.operator === "{") {
        scopes.push({ closes: closesWith(item.operator === "(" ? ")" : "}"), dir, start: found.length, restore: item.operator === "(" })
      } else if (scopes[scopes.length - 1]?.closes(item)) {
        const scope = scopes.pop() as Scope
        if (scope.restore) dir = scope.dir
        const trailing = next?.kind === "command" && next.words.length === 0 ? next : undefined
        if (silenced(trailing, next)) found.length = scope.start
      }
      continue
    }
    const head = firstWord(item)
    if (head !== undefined && LOOP_STARTS.has(head)) {
      scopes.push({ closes: (candidate) => candidate.kind === "command" && LOOP_ENDS.has(firstWord(candidate) ?? ""), dir, start: found.length, restore: false })
    } else if (scopes[scopes.length - 1]?.closes(item)) {
      const scope = scopes.pop() as Scope
      if (silenced(item, next)) found.length = scope.start
      continue
    }
    const words = [...item.words]
    while (words[0] && !words[0].quoted && CONTROL_PREFIXES.has(words[0].value)) words.shift()
    const { argv, directories } = commandWords(words.map((word) => word.value))
    const offset = words.length - argv.length
    const executable = words[offset]
    if (!executable || executable.quoted || executable.expands) continue
    const name = argv[0]?.split("/").pop() ?? ""
    if (name === "cd") {
      dir = cdTarget(argv.slice(1), dir, words.slice(offset + 1).some((word) => word.expands))
      continue
    }
    // Wrappers such as `env -C dir` run the command in another directory; redirections stay in `dir`.
    let commandDir = dir
    for (const wrapper of directories) commandDir = literalDirectory(commandDir, wrapper, false)
    const quiet = silenced(item, next)
    if (!quiet) for (const source of commandScripts(argv, item.hereDocuments)) found.push(...wholeFileReads(source, commandDir ?? cwd, depth + 1))
    if (!WHOLE_FILE_READERS.has(name) || quiet) continue
    const operands: string[] = []
    for (let at = 1; at < argv.length; at++) {
      const word = words[offset + at]
      const arg = argv[at] as string
      if (arg === "--" || (arg.startsWith("-") && arg !== "-")) continue
      operands.push(arg)
      if (!word || arg === "-" || word.expands || /[$`]/.test(arg)) continue
      if (isAbsolute(arg)) found.push(arg)
      else if (commandDir !== null) found.push(resolve(commandDir, arg))
    }
    if (operands.length === 0 || operands.includes("-")) {
      for (const redirect of item.redirects) {
        if (!readsStdin(command, redirect.start) || redirect.expands || /[$`]/.test(redirect.value)) continue
        if (isAbsolute(redirect.value)) found.push(redirect.value)
        else if (dir !== null) found.push(resolve(dir, redirect.value))
      }
    }
  }
  return found
}

type SessionState = { seen: Set<string> }

export async function setupLargeRead(ctx: Context, options: LargeReadOptions): Promise<() => Promise<void>> {
  // Refusal history per session; evicted when the session is deleted. The session itself is
  // looked up on every call so a move to another directory and a failed lookup never stick.
  const sessions = new Map<string, SessionState>()
  const stop = onSessionDeleted(ctx, (sessionID) => sessions.delete(sessionID))
  const hook = await ctx.tool.hook("execute.before", async (event) => {
    const shell = shellCall(event.tool, event.input)
    const target = shell ? undefined : untargetedReadPath(event.tool, event.input)
    if (!shell && target === undefined) return
    let found: { parentID?: string | null; location?: { directory?: string } }
    try {
      found = (await ctx.session.get({ sessionID: event.sessionID } as never)) as typeof found
    } catch {
      return
    }
    const directory = found?.location?.directory
    if (directory === undefined) return
    if (typeof found.parentID === "string" && !options.agents.has(event.agent)) return
    let state = sessions.get(event.sessionID)
    if (state === undefined) {
      state = { seen: new Set() }
      sessions.set(event.sessionID, state)
    }
    const base = shell?.workdir ? resolve(directory, shell.workdir) : directory
    const paths = shell ? wholeFileReads(shell.command, base) : [resolve(base, target as string)]
    const reasons: string[] = []
    for (const path of new Set(paths)) {
      if (state.seen.has(path)) continue
      const file = await largeFile(path, options, options.timeoutMs)
      if (file === undefined) continue
      if (sessions.get(event.sessionID) !== state) return
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
