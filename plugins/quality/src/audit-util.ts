import { readFileSync, realpathSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative, resolve, sep } from "node:path"

/** The most characters a helper tool puts in its text result. */
export const TEXT_CAP = 4000

/** Join lines and cut the result at `cap` characters, saying so. */
export function capText(lines: readonly string[], cap = TEXT_CAP): string {
  const text = lines.join("\n")
  if (text.length <= cap) return text
  return `${text.slice(0, cap - 24).trimEnd()}\n... (output truncated)`
}

/** The middle value of a list (mean of the two middle values for an even count); NaN when empty. */
export function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
}

/** Sorted line numbers as compact ranges: `[1,2,3,7]` becomes `1-3,7`. */
export function compactRanges(lines: readonly number[], maxRanges = 12): string {
  const sorted = [...new Set(lines)].sort((a, b) => a - b)
  const ranges: string[] = []
  let start = 0
  for (let i = 0; i < sorted.length; i++) {
    const current = sorted[i] as number
    if (i + 1 < sorted.length && sorted[i + 1] === current + 1) continue
    const first = sorted[start] as number
    ranges.push(first === current ? `${current}` : `${first}-${current}`)
    start = i + 1
  }
  if (ranges.length <= maxRanges) return ranges.join(",")
  return `${ranges.slice(0, maxRanges).join(",")},... (+${ranges.length - maxRanges} ranges)`
}

/** `part / whole` as a percentage with one decimal; 100 when `whole` is 0 (nothing to cover). */
export function percent(part: number, whole: number): number {
  return whole === 0 ? 100 : Math.round((part / whole) * 1000) / 10
}

function inside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

export class PathError extends Error {}

/** The OpenCode temp directory, where the audit keeps its reports. */
export function opencodeTempDir(): string {
  return join(realpathSync(tmpdir()), "opencode")
}

/** The directories a report may live in: the session directory and the OpenCode temp directory. */
export function reportRoots(sessionDirectory: string): string[] {
  const real = (path: string): string => {
    try {
      return realpathSync(path)
    } catch {
      return resolve(path)
    }
  }
  return [real(sessionDirectory), opencodeTempDir()]
}

export const MAX_REPORT_BYTES = 200 * 1024 * 1024

/**
 * Read a report. A relative path resolves against the session directory. The file is resolved with
 * `realpathSync` at read time and its real path must be inside one of the roots, so a link that
 * points elsewhere is refused. Throws {@link PathError} for a path outside the roots; a missing
 * file or an oversized one throws a plain Error.
 */
export function readReportFile(sessionDirectory: string, path: string, roots = reportRoots(sessionDirectory)): string {
  const target = isAbsolute(path) ? path : resolve(sessionDirectory, path)
  let real: string
  try {
    real = realpathSync(target)
  } catch {
    // Nothing to follow yet: judge the lexical path, so a missing file elsewhere is still a refusal.
    const lexical = [...roots, resolve(sessionDirectory), join(tmpdir(), "opencode")]
    if (!lexical.some((root) => inside(root, resolve(target))))
      throw new PathError(`${path} is outside the session and OpenCode temp directories`)
    throw new Error(`${path} does not exist`)
  }
  if (!roots.some((root) => inside(root, real))) throw new PathError(`${path} is outside the session and OpenCode temp directories`)
  if (statSync(real).size > MAX_REPORT_BYTES) throw new Error(`${path} is larger than ${MAX_REPORT_BYTES / 1024 / 1024} MB`)
  return readFileSync(real, "utf8")
}
