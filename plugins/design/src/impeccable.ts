import { isAbsolute, resolve } from "node:path"
import { type SupervisedRun, supervise } from "@srobroek/opencode-lib/subprocess"

export const SCAN_TOOL = "design_impeccable_scan"

export const DEFAULT_TIMEOUT_SECONDS = 180
const MAX_TIMEOUT_SECONDS = 900
/** Detector JSON past this many characters is cut, so a large tree cannot flood the context. */
export const MAX_OUTPUT_CHARS = 60_000

export const SCAN_DESCRIPTION =
  "Run impeccable's deterministic design detector (npx --yes impeccable detect --json) over files, directories, " +
  "or a URL, and return its JSON findings. Asks before every run, because npx may download impeccable and its " +
  "engine. Findings are a coarse corroborating signal: HTML-engine findings can carry line 0, so confirm each one " +
  "on the rendered surface before citing it."

export const SCAN_INPUT = {
  type: "object",
  properties: {
    targets: {
      type: "array",
      items: { type: "string" },
      minItems: 1,
      description: "Files, directories, or one http(s) URL to scan; relative paths resolve against the session directory",
    },
    noConfig: {
      type: "boolean",
      description: "Raw scan that ignores .impeccable/config.json ignores and inline waivers (--no-config)",
    },
    viewport: {
      type: "string",
      pattern: "^[1-9][0-9]{1,4}x[1-9][0-9]{1,4}$",
      description: "URL scans only: viewport as WIDTHxHEIGHT, for example 375x812 (detector default 1280x800)",
    },
    timeoutSeconds: {
      type: "integer",
      minimum: 1,
      maximum: MAX_TIMEOUT_SECONDS,
      description: `Kill the scan after this long (default ${DEFAULT_TIMEOUT_SECONDS}; a first run downloads the engine)`,
    },
  },
  required: ["targets"],
  additionalProperties: false,
} as const

export type ScanParams = { targets: string[]; noConfig: boolean; viewport?: string; timeoutSeconds: number }

const URL_TARGET = /^https?:\/\//i
const VIEWPORT = /^[1-9][0-9]{1,4}x[1-9][0-9]{1,4}$/

/** Validate `design_impeccable_scan` input, or return why it is unusable. */
export function readScanParams(input: unknown): ScanParams | string {
  const value = (input ?? {}) as Record<string, unknown>
  const targets = value.targets
  if (!Array.isArray(targets) || targets.length === 0) return "targets must be a non-empty array of strings"
  for (const target of targets) {
    if (typeof target !== "string" || target.trim() === "") return "every target must be a non-empty string"
    // A target the CLI would read as a flag changes what runs, not what is scanned.
    if (target.startsWith("-")) return `target ${JSON.stringify(target)} starts with "-"; pass a path such as ./${target}`
  }
  if (value.noConfig !== undefined && typeof value.noConfig !== "boolean") return "noConfig must be a boolean"
  if (value.viewport !== undefined && (typeof value.viewport !== "string" || !VIEWPORT.test(value.viewport)))
    return "viewport must be WIDTHxHEIGHT, for example 375x812"
  const timeout = value.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS
  if (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT_SECONDS)
    return `timeoutSeconds must be an integer from 1 to ${MAX_TIMEOUT_SECONDS}`
  const params: ScanParams = { targets: targets as string[], noConfig: value.noConfig === true, timeoutSeconds: timeout }
  if (typeof value.viewport === "string") params.viewport = value.viewport
  return params
}

/** Targets as the detector receives them: URLs as given, paths absolute against `cwd`. */
export function resolveTargets(targets: readonly string[], cwd: string): string[] {
  return targets.map((target) => (URL_TARGET.test(target) || isAbsolute(target) ? target : resolve(cwd, target)))
}

export function scanArgv(params: ScanParams, targets: readonly string[]): string[] {
  return [
    "npx",
    "--yes",
    "impeccable",
    "detect",
    "--json",
    ...(params.noConfig ? ["--no-config"] : []),
    ...(params.viewport ? ["--viewport", params.viewport] : []),
    ...targets,
  ]
}

/** The number of findings in the detector's JSON, or null when its shape is not recognised. */
export function countFindings(json: unknown): number | null {
  if (Array.isArray(json)) return json.length
  if (json !== null && typeof json === "object") {
    const record = json as Record<string, unknown>
    for (const key of ["findings", "results", "issues"]) {
      const list = record[key]
      if (Array.isArray(list)) return list.length
    }
  }
  return null
}

export type ScanResult = {
  ok: boolean
  /** clean (exit 0), findings (exit 2), unscanned (exit 1), or why no detector verdict exists. */
  status: "clean" | "findings" | "unscanned" | "failed" | "timeout" | "aborted" | "lost"
  exitCode?: number
  findings: number | null
  text: string
}

function clip(text: string): string {
  return text.length > MAX_OUTPUT_CHARS
    ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n[output cut at ${MAX_OUTPUT_CHARS} characters; scan fewer targets]`
    : text
}

/**
 * Read one detector run. Exit 0 is a completed scan without primary findings, 2 a
 * completed scan with findings, 1 a target it could not scan; anything else, or no
 * exit at all, is no verdict.
 */
export function interpretScan(run: SupervisedRun, timeoutSeconds: number): ScanResult {
  const stderr = run.stderr.trim()
  if (run.kind !== "exited") {
    const why =
      run.kind === "timeout"
        ? `impeccable detect did not finish within ${timeoutSeconds}s and was killed`
        : run.kind === "aborted"
          ? "impeccable detect was cancelled"
          : "impeccable detect ended without an exit status"
    return { ok: false, status: run.kind, findings: null, text: [why, stderr].filter(Boolean).join("\n") }
  }
  const stdout = run.stdout.trim()
  let parsed: unknown
  let json = false
  try {
    parsed = JSON.parse(stdout)
    json = stdout !== ""
  } catch {
    json = false
  }
  const findings = json ? countFindings(parsed) : null
  const code = run.exitCode
  const status: ScanResult["status"] = code === 0 ? "clean" : code === 2 ? "findings" : code === 1 ? "unscanned" : "failed"
  const head =
    status === "clean"
      ? "impeccable detect: no primary findings. A clean run is evidence, not proof; still drive the surface."
      : status === "findings"
        ? `impeccable detect: ${findings ?? "some"} finding(s). Corroborate each on the rendered surface before citing it.`
        : status === "unscanned"
          ? "impeccable detect: at least one target could not be scanned (exit 1)."
          : `impeccable detect failed (exit ${code}).`
  const body = json ? stdout : [stdout, stderr].filter(Boolean).join("\n")
  return {
    ok: status === "clean" || status === "findings",
    status,
    exitCode: code,
    findings,
    text: body ? `${head}\n${clip(body)}` : head,
  }
}

export type Exec = (
  argv: string[],
  options: { cwd: string; timeoutMs: number; signal?: AbortSignal },
) => Promise<SupervisedRun>

export const spawnScan: Exec = async (argv, { cwd, timeoutMs, signal }) => {
  try {
    const child = Bun.spawn(argv, {
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      // The npx shim and the engine it fetches are ended together on timeout.
      detached: true,
    })
    return await supervise(child, { timeoutMs, signal, group: true })
  } catch (error) {
    return { kind: "exited", exitCode: 127, signalCode: null, stdout: "", stderr: String(error) }
  }
}

export async function runScan(
  params: ScanParams,
  cwd: string,
  signal?: AbortSignal,
  exec: Exec = spawnScan,
): Promise<ScanResult> {
  const argv = scanArgv(params, resolveTargets(params.targets, cwd))
  const run = await exec(argv, { cwd, timeoutMs: params.timeoutSeconds * 1000, signal })
  return interpretScan(run, params.timeoutSeconds)
}

type Evaluation = { action: string; resources: ReadonlyArray<string>; effect: string; message?: string }

/** Turn an allowed scan into a prompt: npx may fetch and run code from the network. */
export function confirmScan(evaluation: Evaluation): void {
  if (evaluation.effect !== "allow" || evaluation.action !== SCAN_TOOL) return
  evaluation.effect = "ask"
  evaluation.message = `Run npx --yes impeccable detect on ${evaluation.resources.join(", ")}? npx may download impeccable and its engine from the network before scanning.`
}
