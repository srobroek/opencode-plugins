/**
 * `cad_run`: start a CAD skill script through cad-flow's `run.py` launcher, which resolves the
 * script under `skills/` and runs it in uv's environment shared by its PEP 723 dependency set.
 * OMP addressed these scripts as `skill://<skill>/scripts/<script>.py`; OpenCode has no such
 * resolver, so the plugin, which knows where its skills live, resolves them instead.
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path"
import { processAlive, type SupervisedRun, supervise } from "@srobroek/opencode-lib/subprocess"

export const RUN_TOOL = "cad_run"
export const STOP_TOOL = "cad_stop"

export const DEFAULT_TIMEOUT_S = 1200
export const MAX_TIMEOUT_S = 3600
export const READY_TIMEOUT_S = 120
/** Characters of stdout a result carries; the rest goes to a file. */
export const STDOUT_LIMIT = 100_000
/** Characters of stderr a result carries, from the end; uv and the scripts log progress there. */
export const STDERR_TAIL = 4_000

export const RUN_DESCRIPTION =
  "Run a CAD skill script in uv's environment for its PEP 723 dependencies, from the session directory.\n" +
  "script is relative to the CAD skills directory (cad-model/scripts/cad_model.py); args pass through as-is. " +
  "background=true starts a server and returns its pid and first stdout line; cad_stop ends it."

export const RUN_INPUT = {
  type: "object",
  properties: {
    script: { type: "string", description: "Script under the CAD skills directory, e.g. cad-flow/scripts/preflight.py" },
    args: { type: "array", items: { type: "string" }, description: "Arguments, one per item" },
    timeout: {
      type: "number",
      description: `Seconds before the run is killed (default ${DEFAULT_TIMEOUT_S}, max ${MAX_TIMEOUT_S}); with background, seconds to wait for the first stdout line (default ${READY_TIMEOUT_S})`,
    },
    background: { type: "boolean", description: "Start a long-running server and return once it prints its first stdout line" },
  },
  required: ["script"],
  additionalProperties: false,
} as const

export const STOP_DESCRIPTION =
  "Stop a background CAD script that cad_run started in this session, by its pid. " +
  "It knows only scripts started since OpenCode last started: after a restart it refuses an earlier server's pid; " +
  "stop that server with its skill's own stop command (cad-viewer/scripts/viewer.py stop) or let its idle timeout end it."

export const STOP_INPUT = {
  type: "object",
  properties: { pid: { type: "number", description: "The pid cad_run reported for the background script" } },
  required: ["pid"],
  additionalProperties: false,
} as const

export type RunParams = { script: string; args: string[]; timeoutSeconds: number; background: boolean }

/** Validate `cad_run` input; a string is the error to report. */
export function readRunParams(input: unknown): RunParams | string {
  const { script, args, timeout, background } = (input ?? {}) as Record<string, unknown>
  if (typeof script !== "string" || script.trim() === "") return "script must be a non-empty string"
  if (args !== undefined && (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")))
    return "args must be an array of strings"
  if (background !== undefined && typeof background !== "boolean") return "background must be a boolean"
  const isBackground = background === true
  if (timeout !== undefined && (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0))
    return "timeout must be a positive number of seconds"
  const timeoutSeconds = Math.min(MAX_TIMEOUT_S, timeout ?? (isBackground ? READY_TIMEOUT_S : DEFAULT_TIMEOUT_S))
  return { script: script.trim(), args: (args as string[] | undefined) ?? [], timeoutSeconds, background: isBackground }
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel)
}

/**
 * The script's path relative to `skillsDir` (slash-separated), or the reason it is refused:
 * outside the skills directory (also through a symlink), not a `.py` file, or missing.
 */
export function resolveScript(skillsDir: string, script: string): string | { error: string } {
  const absolute = resolve(skillsDir, script)
  if (!inside(skillsDir, absolute)) return { error: `script must be under ${skillsDir}: ${script}` }
  if (!absolute.endsWith(".py")) return { error: `script must be a .py file: ${script}` }
  if (!existsSync(absolute) || !statSync(absolute).isFile()) return { error: `script not found: ${absolute}` }
  if (!inside(realpathSync(skillsDir), realpathSync(absolute)))
    return { error: `script resolves outside ${skillsDir}: ${script}` }
  return relative(skillsDir, absolute).split(sep).join("/")
}

/** `uv run --script <skills>/cad-flow/scripts/run.py <script> <args...>` */
export function runArgv(skillsDir: string, script: string, args: readonly string[]): string[] {
  return ["uv", "run", "--script", join(skillsDir, "cad-flow", "scripts", "run.py"), script, ...args]
}

/** The environment a CAD script sees: the server's, plus the session id and the plugin marker. */
export function runEnv(
  base: Record<string, string | undefined>,
  sessionID: string,
  plugin: string,
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) if (value !== undefined) env[key] = value
  env.CAD_SESSION_ID = sessionID
  env.CAD_OPENCODE_PLUGIN = plugin
  return env
}

/** The `--session` a viewer command names, `""` for the default session. */
export function viewerSessionName(args: readonly string[]): string {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] as string
    if (arg === "--session") return args[index + 1] ?? ""
    if (arg.startsWith("--session=")) return arg.slice("--session=".length)
  }
  return ""
}

export const VIEWER_SCRIPT = "cad-viewer/scripts/viewer.py"

/** `viewer.py stop`, for the session named in `serve`'s arguments. */
export function viewerStopArgs(session: string): string[] {
  return session === "" ? ["stop"] : ["stop", "--session", session]
}

export type Exec = (
  argv: string[],
  options: { cwd: string; env: Record<string, string>; timeoutMs: number; signal?: AbortSignal },
) => Promise<SupervisedRun>

export const spawnRun: Exec = async (argv, { cwd, env, timeoutMs, signal }) => {
  try {
    const child = Bun.spawn(argv, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true })
    return await supervise(child, { timeoutMs, signal, group: true })
  } catch (error) {
    return { kind: "exited", exitCode: 127, signalCode: null, stdout: "", stderr: String(error) }
  }
}

/** Where a result too long for the tool output, and a background script's output, is kept. */
export function outputDir(sessionID: string): string {
  const dir = join(tmpdir(), "srobroek-cad", sessionID.replace(/[^\w.-]/g, "_"))
  mkdirSync(dir, { recursive: true })
  return dir
}

function stem(script: string): string {
  return `${Date.now()}-${basename(script, ".py")}`
}

export type RunResult = { ok: boolean; text: string; exitCode: number | null; status: SupervisedRun["kind"] }

/** The tool text for a finished foreground run; overlong output is saved under `dir()`. */
export function formatRun(script: string, run: SupervisedRun, seconds: number, dir: () => string): RunResult {
  const elapsed = `${seconds.toFixed(1)} s`
  const head =
    run.kind === "exited"
      ? `${RUN_TOOL} ${script}: exit ${run.exitCode}${run.signalCode ? ` (${run.signalCode})` : ""} after ${elapsed}`
      : run.kind === "timeout"
        ? `${RUN_TOOL} ${script}: killed after the ${elapsed} timeout; pass a longer timeout if the script needs it`
        : run.kind === "aborted"
          ? `${RUN_TOOL} ${script}: cancelled after ${elapsed}`
          : `${RUN_TOOL} ${script}: the process disappeared without an exit status after ${elapsed}; nothing it printed is a result`
  const lines = [head]
  let saved: string | undefined
  const save = (suffix: string, text: string) => {
    saved ??= join(dir(), stem(script))
    const path = `${saved}.${suffix}`
    writeFileSync(path, text)
    return path
  }
  if (run.stdout !== "") {
    if (run.stdout.length > STDOUT_LIMIT)
      lines.push(run.stdout.slice(0, STDOUT_LIMIT), `[stdout truncated at ${STDOUT_LIMIT} characters; all of it is in ${save("stdout", run.stdout)}]`)
    else lines.push(run.stdout.trimEnd())
  }
  if (run.stderr.trim() !== "") {
    if (run.stderr.length > STDERR_TAIL)
      lines.push(`stderr (last ${STDERR_TAIL} characters; all of it is in ${save("stderr", run.stderr)}):`, run.stderr.slice(-STDERR_TAIL).trimEnd())
    else lines.push("stderr:", run.stderr.trimEnd())
  }
  const exitCode = run.kind === "exited" ? run.exitCode : null
  return { ok: exitCode === 0, text: lines.join("\n"), exitCode, status: run.kind }
}

/** A spawned background script: its pid, its exit, and a kill that is a no-op once it is reaped. */
export type BackgroundChild = { pid: number; exited: Promise<unknown>; kill(signal?: NodeJS.Signals): void }
export type Start = (argv: string[], options: { cwd: string; env: Record<string, string>; stdout: string; stderr: string }) => BackgroundChild

export const startBackground: Start = (argv, { cwd, env, stdout, stderr }) => {
  const child = Bun.spawn(argv, {
    cwd,
    env,
    stdin: "ignore",
    stdout: Bun.file(stdout),
    stderr: Bun.file(stderr),
    // Its own process group, so cad_stop ends the uv launcher and the server together.
    detached: true,
  })
  child.unref()
  return { pid: child.pid, exited: child.exited, kill: (signal) => child.kill(signal) }
}

export type BackgroundJob = {
  pid: number
  script: string
  stdout: string
  stderr: string
  cwd: string
  child: BackgroundChild
  /**
   * The script has not reported its exit and its pid still exists. Once it exits its pid can
   * belong to another process, so nothing signals a job that is not running.
   */
  running: () => boolean
}

export type BackgroundStart =
  | { ok: true; job: BackgroundJob; firstLine: string }
  | { ok: false; text: string; job?: BackgroundJob }

function firstLine(path: string): string | null {
  const text = lstatSync(path, { throwIfNoEntry: false }) ? readFileSync(path, "utf8") : ""
  const end = text.indexOf("\n")
  return end === -1 ? null : text.slice(0, end)
}

function tail(path: string, chars = STDERR_TAIL): string {
  return lstatSync(path, { throwIfNoEntry: false }) ? readFileSync(path, "utf8").slice(-chars).trimEnd() : ""
}

export type Wait = (ms: number) => Promise<void>
const sleep: Wait = (ms) => new Promise((done) => setTimeout(done, ms))

/**
 * Start `argv` detached with its output in files and wait for its first stdout line. The
 * script keeps running once it has printed one; one that exits first, or stays silent past
 * the timeout, is reported (the silent one is still running and is returned for cleanup).
 */
export async function runBackground(
  argv: string[],
  options: { cwd: string; env: Record<string, string>; script: string; timeoutSeconds: number; dir: string; signal?: AbortSignal },
  start: Start = startBackground,
  alive: (pid: number) => boolean = processAlive,
  wait: Wait = sleep,
): Promise<BackgroundStart> {
  const base = join(options.dir, stem(options.script))
  const stdout = `${base}.stdout`
  const stderr = `${base}.stderr`
  writeFileSync(stdout, "")
  writeFileSync(stderr, "")
  let child: BackgroundChild
  try {
    child = start(argv, { cwd: options.cwd, env: options.env, stdout, stderr })
  } catch (error) {
    return { ok: false, text: `${RUN_TOOL} ${options.script}: could not start: ${String(error)}` }
  }
  let exited = false
  const settle = () => {
    exited = true
  }
  child.exited.then(settle, settle)
  const running = () => !exited && alive(child.pid)
  const job: BackgroundJob = { pid: child.pid, script: options.script, stdout, stderr, cwd: options.cwd, child, running }
  const deadline = Date.now() + options.timeoutSeconds * 1000
  for (;;) {
    const line = firstLine(stdout)
    if (line !== null) return { ok: true, job, firstLine: line }
    if (!running()) {
      const err = tail(stderr)
      return {
        ok: false,
        text: [`${RUN_TOOL} ${options.script}: exited before printing a line`, err === "" ? "" : `stderr:\n${err}`]
          .filter(Boolean)
          .join("\n"),
      }
    }
    if (options.signal?.aborted || Date.now() >= deadline)
      return {
        ok: false,
        job,
        text: `${RUN_TOOL} ${options.script}: no stdout line after ${options.timeoutSeconds} s; pid ${child.pid} is still running (cad_stop it, or read ${stdout} and ${stderr})`,
      }
    await wait(100)
  }
}

/**
 * SIGTERM a running background job's process group, then SIGKILL it if it outlives
 * `graceMs`. Like lib's `killChild`, the group is signalled first and the child handle after;
 * a job that is no longer running is never signalled, because its pid may have been reused.
 */
export async function stopJob(job: BackgroundJob, graceMs = 5_000, wait: Wait = sleep): Promise<"stopped" | "gone"> {
  if (!job.running()) return "gone"
  const signal = (name: NodeJS.Signals) => {
    if (!job.running()) return
    try {
      process.kill(-job.pid, name)
    } catch {
      try {
        job.child.kill(name)
      } catch {
        // Already reaped.
      }
    }
  }
  signal("SIGTERM")
  for (let waited = 0; waited < graceMs && job.running(); waited += 100) await wait(100)
  signal("SIGKILL")
  return "stopped"
}
