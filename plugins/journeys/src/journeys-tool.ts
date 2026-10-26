/**
 * The journeys.py runner and the formula installer behind the `journeys_index` and
 * `journey_install_formulas` tools. Ported from omp-plugins (`journeys/extensions/journeys-tool.ts`).
 */

import { execFile } from "node:child_process"
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync } from "node:fs"
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

/**
 * Bound on one journeys.py run. index/lint/prune only walk local markdown, so this
 * only stops a hung helper (a FIFO, a stalled mount). The abort signal cancels sooner.
 */
export const TIMEOUT_MS = 600_000
const MAX_BUFFER = 10 * 1024 * 1024

export const JOURNEYS_SCRIPT = fileURLToPath(new URL("../skills/journey-init/scripts/journeys.py", import.meta.url))
export const FORMULAS_DIR = fileURLToPath(new URL("../skills/journey-verify/formulas/", import.meta.url))
export const REQUIRED_FORMULAS = ["journey-step-agentic-verification", "journey-step-human-verification"] as const

export type Exec = (
  file: string,
  args: string[],
  options: { cwd: string; shell: false; timeout: number; maxBuffer: number; signal?: AbortSignal },
) => Promise<{ stdout: string; stderr: string }>

const exec: Exec = async (file, args, options) => {
  const result = await execFileAsync(file, args, options)
  return { stdout: result.stdout, stderr: result.stderr }
}

export type JourneysCommand = "index" | "lint" | "prune"

export type JourneysIndexParams = {
  command: JourneysCommand
  journeysDir: string
  keep?: number
  yes?: boolean
  journey?: string
}

/** A run that reached an exit status, or why it reached none. */
export type JourneysExecution =
  | { stdout: string; stderr: string; exitCode: number }
  | { stdout: string; stderr: string; unrun: string }

/** Whether a call changes files: `index` writes INDEX.md, `prune --yes` deletes runs. Lint and a dry-run prune only read. */
export function journeysWrites(params: Pick<JourneysIndexParams, "command" | "yes">): boolean {
  if (params.command === "lint") return false
  if (params.command === "prune") return params.yes === true
  return true
}

export function journeysArgs(params: JourneysIndexParams, script = JOURNEYS_SCRIPT): string[] {
  const args = [script, params.command, params.journeysDir]
  if (params.command !== "prune") return args
  if (params.keep !== undefined) args.push("--keep", String(params.keep))
  if (params.journey !== undefined) args.push("--journey", params.journey)
  if (params.yes) args.push("--yes")
  return args
}

type ExecError = { code?: unknown; killed?: unknown; stdout?: unknown; stderr?: unknown; message?: unknown }

/** Run the bundled Python helper with `cwd` as its working directory. */
export async function runJourneys(
  cwd: string,
  params: JourneysIndexParams,
  signal?: AbortSignal,
  runner: Exec = exec,
  timeoutMs = TIMEOUT_MS,
): Promise<JourneysExecution> {
  try {
    const result = await runner("python3", journeysArgs(params), {
      cwd,
      shell: false,
      timeout: timeoutMs,
      maxBuffer: MAX_BUFFER,
      signal,
    })
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 }
  } catch (error) {
    const failure: ExecError = typeof error === "object" && error !== null ? error : {}
    const stdout = typeof failure.stdout === "string" ? failure.stdout : ""
    const stderr =
      typeof failure.stderr === "string" ? failure.stderr : typeof failure.message === "string" ? failure.message : ""
    // A killed helper made no finding: report why it stopped instead of a failed exit.
    if (signal?.aborted) return { stdout, stderr, unrun: "cancelled" }
    if (failure.killed === true && failure.code === null)
      return { stdout, stderr, unrun: `timed out after ${timeoutMs / 1000} s` }
    return { stdout, stderr, exitCode: typeof failure.code === "number" ? failure.code : 1 }
  }
}

/** Resolve a local path or file URL without treating URL syntax as a relative path. */
function localPath(raw: string): string | null {
  if (!raw.includes("://") && !raw.startsWith("file:")) return raw
  if (!raw.startsWith("file:")) return null
  try {
    return fileURLToPath(raw)
  } catch {
    return null
  }
}

/** The physical directory a command or formula install operates in, or `null` when it is unusable. */
export function managedRoot(dir: string, base: string): string | null {
  const local = localPath(dir)
  if (local === null) return null
  if (local.split(sep === "\\" ? /[\\/]/ : "/").includes("..")) return null
  try {
    return realpathSync(resolve(base, local))
  } catch {
    return null
  }
}

function safePath(path: string, base: string): void {
  const absolute = resolve(isAbsolute(path) ? path : join(base, path))
  const inside = relative(base, absolute)
  if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new Error(`outside the managed root: ${absolute}`)
  }
  let current = base
  if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`unsafe symlink: ${current}`)
  for (const part of inside.split(sep === "\\" ? /[\\/]/ : "/").filter(Boolean)) {
    current = join(current, part)
    if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`unsafe symlink: ${current}`)
  }
}

export function formulaSources(dir = FORMULAS_DIR): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith(".formula.toml"))
    .sort()
    .map((name) => join(dir, name))
}

export type InstallResult = { ok: boolean; text: string; copied?: number; unchanged?: number }

/**
 * Copy the package-owned formula TOMLs into `<repoRoot>/.beads/formulas/`. Identical
 * copies stay; a divergent destination is refused unless `force`. Symlinked paths are
 * always refused.
 */
export function installFormulas(
  rawRepoRoot: string,
  force: boolean,
  base: string,
  rawSourcesDir = FORMULAS_DIR,
): InstallResult {
  const repoRoot = managedRoot(rawRepoRoot, base)
  const sourcesDir = managedRoot(rawSourcesDir, base)
  if (repoRoot === null) return { ok: false, text: `ERROR not a Beads workspace: ${rawRepoRoot}` }
  if (sourcesDir === null) return { ok: false, text: `ERROR no formula sources: ${rawSourcesDir}` }
  try {
    safePath(repoRoot, repoRoot)
    safePath(sourcesDir, sourcesDir)
    safePath(join(repoRoot, ".beads", "formulas"), repoRoot)
  } catch (error) {
    return { ok: false, text: `ERROR ${error instanceof Error ? error.message : String(error)}` }
  }
  const beadsDir = join(repoRoot, ".beads")
  if (!lstatSync(beadsDir, { throwIfNoEntry: false })?.isDirectory()) {
    return { ok: false, text: `ERROR not a Beads workspace: ${repoRoot}` }
  }
  const destinationDir = join(beadsDir, "formulas")
  const destinationStat = lstatSync(destinationDir, { throwIfNoEntry: false })
  if (destinationStat && (destinationStat.isSymbolicLink() || !destinationStat.isDirectory())) {
    return { ok: false, text: `ERROR unsafe formula destination: ${destinationDir}` }
  }
  for (const name of REQUIRED_FORMULAS) {
    const source = join(sourcesDir, `${name}.formula.toml`)
    const st = lstatSync(source, { throwIfNoEntry: false })
    if (!st?.isFile() || st.isSymbolicLink()) {
      return { ok: false, text: `ERROR required formula missing or unsafe: ${source}` }
    }
  }
  const sources = formulaSources(sourcesDir)
  const unchanged = new Set<string>()
  const unsafe: string[] = []
  const conflicts: string[] = []
  for (const source of sources) {
    const sourceStat = lstatSync(source)
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
      return { ok: false, text: `ERROR unsafe formula source: ${source}` }
    }
    const destination = join(destinationDir, basename(source))
    const st = lstatSync(destination, { throwIfNoEntry: false })
    if (!st) continue
    if (st.isSymbolicLink() || !st.isFile()) unsafe.push(destination)
    else if (readFileSync(destination).equals(readFileSync(source))) unchanged.add(source)
    else conflicts.push(destination)
  }
  if (unsafe.length) return { ok: false, text: `ERROR unsafe formula destinations: ${unsafe.join(", ")}` }
  if (conflicts.length && !force) {
    return { ok: false, text: `ERROR refusing to overwrite divergent formula files: ${conflicts.join(", ")}` }
  }
  mkdirSync(destinationDir, { recursive: true })
  let copied = 0
  for (const source of sources) {
    if (unchanged.has(source)) continue
    copyFileSync(source, join(destinationDir, basename(source)))
    copied += 1
  }
  return {
    ok: true,
    text: `formulas: ${copied} copied, ${unchanged.size} unchanged`,
    copied,
    unchanged: unchanged.size,
  }
}
