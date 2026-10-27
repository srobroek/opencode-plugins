import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, isAbsolute, join, resolve } from "node:path"
import { type SupervisedRun, supervise } from "@srobroek/opencode-lib/subprocess"

export const PACK_TOOL = "repomix_pack"
/** The repomix the npx fallback runs; a repomix on PATH is used as installed. */
export const REPOMIX_VERSION = "1.18.1"
export const DEFAULT_TIMEOUT_SECONDS = 300
const MAX_TIMEOUT_SECONDS = 900
export const TOP_FILES = 10
/** Above this many tokens the result advises handing the pack to a subagent. */
export const LARGE_PACK_TOKENS = 50_000
/** Packs and run directories older than this are removed before the next pack. */
export const PACK_TTL_MS = 24 * 60 * 60 * 1000
const MAX_ERROR_CHARS = 4_000

export const STYLES = { xml: "xml", markdown: "md", plain: "txt" } as const
export type Style = keyof typeof STYLES

/** What to grep for to find each file's start in a pack of this style. */
export const ANCHORS: Record<Style, string> = { xml: '<file path="', markdown: "## File: ", plain: "File: " }

export const PACK_DESCRIPTION =
  "Pack a local directory or a remote repo at a ref into one file; returns its path, token counts and top files.\n" +
  "Runs repomix (PATH, else npx --yes repomix@" +
  REPOMIX_VERSION +
  ", which asks first). The pack is written under the OpenCode temp dir and never returned: grep it for the " +
  "file anchors and read slices. The target's repomix.config.* is never loaded and the secret scan always runs. " +
  "Use for bulk context over many files; for a single lookup use grep/read."

export const PACK_INPUT = {
  type: "object",
  properties: {
    directory: {
      type: "string",
      description: "Local directory to pack; relative paths resolve against the session directory (default: it)",
    },
    remote: { type: "string", description: "Remote repo instead of a directory: owner/repo or an https URL" },
    ref: { type: "string", description: "Remote only: branch, tag or commit (default: the default branch)" },
    include: { type: "array", items: { type: "string" }, description: 'Globs to include, for example "src/**"' },
    ignore: { type: "array", items: { type: "string" }, description: "Extra globs to exclude" },
    compress: {
      type: "boolean",
      description: "Keep only signatures, types and doc comments (Tree-sitter); lossy for tests and no gain on markdown",
    },
    style: { type: "string", enum: Object.keys(STYLES), description: "Output format (default xml)" },
    lineNumbers: { type: "boolean", description: "Prefix each line with its line number, for citing a review" },
    timeoutSeconds: {
      type: "integer",
      minimum: 1,
      maximum: MAX_TIMEOUT_SECONDS,
      description: `Kill repomix after this long (default ${DEFAULT_TIMEOUT_SECONDS})`,
    },
  },
  additionalProperties: false,
} as const

export type PackParams = {
  directory?: string
  remote?: string
  ref?: string
  include: string[]
  ignore: string[]
  compress: boolean
  style: Style
  lineNumbers: boolean
  timeoutSeconds: number
}

const SHORTHAND = /^[\w.-]+\/[\w.-]+$/
const HTTPS_URL = /^https:\/\/[\w.-]+(?::\d+)?\/[^\s]+$/
const REF = /^[\w][\w./+@-]*$/

function readPatterns(value: unknown, name: string): string[] | string {
  if (value === undefined) return []
  const list = typeof value === "string" ? [value] : value
  if (!Array.isArray(list)) return `${name} must be an array of glob strings`
  for (const pattern of list) {
    if (typeof pattern !== "string" || pattern.trim() === "") return `every ${name} pattern must be a non-empty string`
    // repomix splits the joined list on commas, so a comma inside one pattern would become two.
    if (pattern.includes(",")) return `${name} pattern ${JSON.stringify(pattern)} contains a comma; pass each glob separately`
  }
  return list as string[]
}

/** Validate `repomix_pack` input, or return why it is unusable. */
export function readPackParams(input: unknown): PackParams | string {
  const value = (input ?? {}) as Record<string, unknown>
  const { directory, remote, ref } = value
  if (directory !== undefined && (typeof directory !== "string" || directory.trim() === ""))
    return "directory must be a non-empty string"
  if (remote !== undefined && (typeof remote !== "string" || remote.trim() === "")) return "remote must be a non-empty string"
  if (directory !== undefined && remote !== undefined) return "pass either directory or remote, not both"
  if (typeof remote === "string" && !SHORTHAND.test(remote) && !HTTPS_URL.test(remote))
    return `remote ${JSON.stringify(remote)} is not owner/repo or an https URL`
  if (ref !== undefined) {
    if (remote === undefined) return "ref applies only to a remote pack; check out the ref locally or pass remote"
    if (typeof ref !== "string" || !REF.test(ref) || ref.includes("..")) return `ref ${JSON.stringify(ref)} is not a branch, tag or commit`
  }
  const include = readPatterns(value.include, "include")
  if (typeof include === "string") return include
  const ignore = readPatterns(value.ignore, "ignore")
  if (typeof ignore === "string") return ignore
  for (const key of ["compress", "lineNumbers"] as const)
    if (value[key] !== undefined && typeof value[key] !== "boolean") return `${key} must be a boolean`
  const style = value.style ?? "xml"
  if (typeof style !== "string" || !(style in STYLES)) return `style must be one of ${Object.keys(STYLES).join(", ")}`
  const timeout = value.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS
  if (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT_SECONDS)
    return `timeoutSeconds must be an integer from 1 to ${MAX_TIMEOUT_SECONDS}`
  const params: PackParams = {
    include,
    ignore,
    compress: value.compress === true,
    style: style as Style,
    lineNumbers: value.lineNumbers === true,
    timeoutSeconds: timeout,
  }
  if (typeof directory === "string") params.directory = directory
  if (typeof remote === "string") params.remote = remote
  if (typeof ref === "string") params.ref = ref
  return params
}

export type Target = { kind: "local"; directory: string } | { kind: "remote"; remote: string; ref?: string }

export function resolveTarget(params: PackParams, cwd: string): Target {
  if (params.remote !== undefined) {
    const target: Target = { kind: "remote", remote: params.remote }
    if (params.ref !== undefined) target.ref = params.ref
    return target
  }
  const directory = params.directory ?? "."
  return { kind: "local", directory: isAbsolute(directory) ? directory : resolve(cwd, directory) }
}

/** The permission resource: the absolute directory, or `remote@ref`. */
export function targetResource(target: Target): string {
  return target.kind === "local" ? target.directory : target.ref ? `${target.remote}@${target.ref}` : target.remote
}

export type Runner = { kind: "path" | "npx"; argv: string[] }

/** repomix from PATH when installed, else the pinned npx package. */
export function chooseRunner(which: (bin: string) => string | null): Runner {
  const found = which("repomix")
  return found ? { kind: "path", argv: [found] } : { kind: "npx", argv: ["npx", "--yes", `repomix@${REPOMIX_VERSION}`] }
}

/**
 * The repomix command line. `--config` names an empty file, so neither the target's
 * repomix.config.* nor the user's global one is loaded (a JS/TS config is code), and the
 * run directory holds no config either. The secret scan is never switched off and a
 * remote's config is never trusted. Values use `--flag=value` so none reads as a flag.
 */
export function packArgv(runner: Runner, params: PackParams, target: Target, config: string, output: string): string[] {
  return [
    ...runner.argv,
    `--config=${config}`,
    `--output=${output}`,
    `--style=${params.style}`,
    "--no-file-summary",
    "--no-git-sort-by-changes",
    `--top-files-len=${TOP_FILES}`,
    ...(params.compress ? ["--compress"] : []),
    ...(params.lineNumbers ? ["--output-show-line-numbers"] : []),
    ...(params.include.length > 0 ? [`--include=${params.include.join(",")}`] : []),
    ...(params.ignore.length > 0 ? [`--ignore=${params.ignore.join(",")}`] : []),
    ...(target.kind === "remote"
      ? [`--remote=${target.remote}`, ...(target.ref ? [`--remote-branch=${target.ref}`] : [])]
      : [target.directory]),
  ]
}

/** A file-name stem naming the target, so two packs of one repo at two refs sort together. */
export function packLabel(target: Target): string {
  const raw =
    target.kind === "local"
      ? basename(target.directory)
      : `${target.remote.replace(/\.git$/, "").split("/").slice(-1)[0]}${target.ref ? `-${target.ref}` : ""}`
  return raw.replace(/[^\w.-]+/g, "-").replace(/^[-.]+/, "").slice(0, 60) || "pack"
}

export type Summary = {
  version: string | null
  files: number | null
  tokens: number | null
  chars: number | null
  topFiles: { path: string; tokens: number }[]
  suspiciousExcluded: string[]
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: matches terminal escapes
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g

const count = (text: string): number => Number(text.replace(/,/g, ""))

/** Read repomix's human summary: totals, the top files and the files the secret scan dropped. */
export function parseSummary(stdout: string): Summary {
  const lines = stdout.replace(ANSI, "").split(/\r\n|\r|\n/)
  const summary: Summary = { version: null, files: null, tokens: null, chars: null, topFiles: [], suspiciousExcluded: [] }
  let section: "top" | "security" | null = null
  for (const line of lines) {
    const version = /Repomix v(\d[\w.+-]*)/.exec(line)
    if (version && summary.version === null) summary.version = version[1] ?? null
    if (/Top \d+ Files/.test(line)) section = "top"
    else if (/Security Check:/.test(line)) section = "security"
    else if (/Pack Summary:|^\s*(Total Files|These files have been excluded)/.test(line)) section = null
    const total = /^\s*Total (Files|Tokens|Chars):\s*([\d,]+)/.exec(line)
    if (total) {
      const key = total[1] === "Files" ? "files" : total[1] === "Tokens" ? "tokens" : "chars"
      summary[key] = count(total[2] ?? "")
      continue
    }
    if (section === "top") {
      const top = /^\s*\d+\.\s+(.+?) \(([\d,]+) tokens/.exec(line)
      if (top) summary.topFiles.push({ path: top[1] ?? "", tokens: count(top[2] ?? "") })
    } else if (section === "security") {
      const flagged = /^\s*\d+\.\s+(\S.*?)\s*$/.exec(line)
      if (flagged) summary.suspiciousExcluded.push(flagged[1] ?? "")
    }
  }
  return summary
}

export type PackResult = {
  ok: boolean
  status: "packed" | "failed" | "timeout" | "aborted" | "lost"
  path?: string
  summary?: Summary
  text: string
}

function tail(text: string): string {
  const clean = text.replace(ANSI, "").trim()
  return clean.length > MAX_ERROR_CHARS ? `…${clean.slice(-MAX_ERROR_CHARS)}` : clean
}

const fmt = (n: number | null) => (n === null ? "?" : n.toLocaleString("en-US"))

/** Turn one repomix run into the tool result: metrics and the path, never the pack. */
export function interpretPack(
  run: SupervisedRun,
  output: string,
  style: Style,
  timeoutSeconds: number,
  exists: (path: string) => boolean,
): PackResult {
  if (run.kind !== "exited") {
    const why =
      run.kind === "timeout"
        ? `repomix did not finish within ${timeoutSeconds}s and was killed`
        : run.kind === "aborted"
          ? "repomix was cancelled"
          : "repomix ended without an exit status"
    return { ok: false, status: run.kind, text: [why, tail(run.stderr)].filter(Boolean).join("\n") }
  }
  if (run.exitCode !== 0 || !exists(output)) {
    const head = run.exitCode !== 0 ? `repomix failed (exit ${run.exitCode}).` : "repomix exited 0 but wrote no pack."
    return { ok: false, status: "failed", text: [head, tail(run.stderr), tail(run.stdout)].filter(Boolean).join("\n") }
  }
  const summary = parseSummary(run.stdout)
  const lines = [
    `Packed ${fmt(summary.files)} files, ${fmt(summary.tokens)} tokens (${fmt(summary.chars)} chars) to ${output}`,
    `Never read the whole pack: grep it for '${ANCHORS[style]}' to list files, then read slices with offset and limit.`,
  ]
  if (summary.tokens !== null && summary.tokens > LARGE_PACK_TOKENS)
    lines.push(`Over ${fmt(LARGE_PACK_TOKENS)} tokens: hand the path to a researcher subagent rather than reading it here.`)
  if (summary.topFiles.length > 0)
    lines.push("Top files by tokens:", ...summary.topFiles.map((file) => `  ${fmt(file.tokens)}\t${file.path}`))
  if (summary.suspiciousExcluded.length > 0)
    lines.push(
      `Left out by the secret scan (${summary.suspiciousExcluded.length}): ${summary.suspiciousExcluded.join(", ")}`,
    )
  return { ok: true, status: "packed", path: output, summary, text: lines.join("\n") }
}

/** Remove this plugin's packs and run directories older than `ttlMs`. Never throws. */
export function prunePacks(root: string, now: number, ttlMs = PACK_TTL_MS): void {
  let names: string[]
  try {
    names = readdirSync(root)
  } catch {
    return
  }
  for (const name of names) {
    if (!/^(repomix-|run-)/.test(name)) continue
    const path = join(root, name)
    try {
      if (now - statSync(path).mtimeMs > ttlMs) rmSync(path, { recursive: true, force: true })
    } catch {
      // Gone already or not ours to remove.
    }
  }
}

export type Exec = (
  argv: string[],
  options: { cwd: string; timeoutMs: number; signal?: AbortSignal },
) => Promise<SupervisedRun>

export const spawnRepomix: Exec = async (argv, { cwd, timeoutMs, signal }) => {
  try {
    const child = Bun.spawn(argv, {
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
      // The npx shim, repomix and its worker threads are ended together on timeout.
      detached: true,
    })
    return await supervise(child, { timeoutMs, signal, group: true })
  } catch (error) {
    return { kind: "exited", exitCode: 127, signalCode: null, stdout: "", stderr: String(error) }
  }
}

export const defaultPackRoot = () => join(tmpdir(), "opencode", "repomix")

export type PackDeps = { exec?: Exec; root?: string; now?: () => number; exists?: (path: string) => boolean }

/**
 * Run one pack. repomix runs in a fresh, empty directory under `root` with an empty
 * config file, and writes `root/repomix-<label>-<id>.<ext>`; the run directory is removed after.
 */
export async function runPack(
  params: PackParams,
  target: Target,
  runner: Runner,
  signal: AbortSignal | undefined,
  deps: PackDeps = {},
): Promise<PackResult> {
  const root = deps.root ?? defaultPackRoot()
  const now = deps.now?.() ?? Date.now()
  mkdirSync(root, { recursive: true })
  prunePacks(root, now)
  const run = mkdtempSync(join(root, "run-"))
  const config = join(run, "repomix.empty.json")
  writeFileSync(config, "{}\n")
  const id = `${now.toString(36)}${basename(run).slice(4)}`
  const output = join(root, `repomix-${packLabel(target)}-${id}.${STYLES[params.style]}`)
  const exists =
    deps.exists ??
    ((path: string) => {
      try {
        return statSync(path).isFile()
      } catch {
        return false
      }
    })
  try {
    const argv = packArgv(runner, params, target, config, output)
    const result = await (deps.exec ?? spawnRepomix)(argv, { cwd: run, timeoutMs: params.timeoutSeconds * 1000, signal })
    return interpretPack(result, output, params.style, params.timeoutSeconds, exists)
  } finally {
    rmSync(run, { recursive: true, force: true })
  }
}

type Evaluation = {
  action: string
  resources: ReadonlyArray<string>
  metadata?: Record<string, unknown>
  effect: string
  message?: string
}

/** Turn an allowed pack that would run through npx into a prompt: npx downloads and runs code. */
export function confirmPack(evaluation: Evaluation): void {
  if (evaluation.effect !== "allow" || evaluation.action !== PACK_TOOL || evaluation.metadata?.runner !== "npx") return
  evaluation.effect = "ask"
  evaluation.message = `repomix is not on PATH. Run npx --yes repomix@${REPOMIX_VERSION} to pack ${evaluation.resources.join(", ")}? npx downloads repomix from the npm registry first.`
}
