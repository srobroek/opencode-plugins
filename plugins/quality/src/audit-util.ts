import { existsSync, realpathSync } from "node:fs"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"

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

/** The nearest existing ancestor of `path`, resolved through symlinks, with the missing tail re-appended. */
function realish(path: string): string {
  let existing = path
  const tail: string[] = []
  while (!existsSync(existing)) {
    const parent = dirname(existing)
    if (parent === existing) break
    tail.unshift(existing.slice(parent.length).replace(/^[\\/]+/, ""))
    existing = parent
  }
  const real = existsSync(existing) ? realpathSync(existing) : existing
  return tail.length === 0 ? real : resolve(real, ...tail)
}

function inside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

export class PathError extends Error {}

/**
 * Resolve `path` against `base` (absolute paths are kept) and require the result to stay inside
 * `root`, both lexically and after following symlinks. Throws {@link PathError} otherwise.
 */
export function resolveInside(root: string, base: string, path: string | undefined): string {
  const target = path === undefined || path === "" ? base : isAbsolute(path) ? path : resolve(base, path)
  const lexical = resolve(target)
  if (!inside(resolve(root), lexical) || !inside(realish(root), realish(lexical)))
    throw new PathError(`${path ?? target} is outside the session directory ${root}`)
  return lexical
}
