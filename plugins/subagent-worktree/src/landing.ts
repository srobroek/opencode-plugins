/**
 * Reading `delivery_land` and `delivery_cleanup` results without depending on the
 * `delivery` plugin: it may not be installed, and a result may be an object, JSON text or
 * prose. Whatever is not understood yields nothing.
 */

import type { Lane } from "./lane.ts"

export const LAND_TOOL = "delivery_land"
export const CLEANUP_TOOL = "delivery_cleanup"
export const LANDING_TOOLS: readonly string[] = [LAND_TOOL, CLEANUP_TOOL]

type Loose = Record<string, unknown>

const isObject = (value: unknown): value is Loose => value !== null && typeof value === "object" && !Array.isArray(value)
const text = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined)

/** Every object and text a result carries: its fields, `output`, `metadata`, and JSON inside text parts. */
function shapes(result: unknown): { objects: Loose[]; texts: string[] } {
  const objects: Loose[] = []
  const texts: string[] = []
  const visit = (value: unknown, depth: number) => {
    if (depth > 3) return
    if (typeof value === "string") {
      texts.push(value)
      try {
        const parsed: unknown = JSON.parse(value)
        if (isObject(parsed)) visit(parsed, depth + 1)
      } catch {}
      return
    }
    if (Array.isArray(value)) {
      for (const part of value) visit(isObject(part) && typeof part.text === "string" ? part.text : part, depth + 1)
      return
    }
    if (!isObject(value)) return
    objects.push(value)
    for (const key of ["output", "metadata", "content"]) visit(value[key], depth + 1)
  }
  visit(result, 0)
  return { objects, texts }
}

export type LandingFacts = {
  /** Worktree paths the result says were removed. */
  removed: string[]
  /** Worktree paths the result names, removed or not (a path that is gone counts as landed). */
  named: string[]
}

const REMOVED_TEXT = /removed (.+?) and (?:its local )?branch/g

/** What a `delivery_land` or `delivery_cleanup` result says about worktrees. */
export function readLanding(result: unknown): LandingFacts {
  const { objects, texts } = shapes(result)
  const removed = new Set<string>()
  const named = new Set<string>()
  for (const object of objects) {
    const worktree = text(object.worktree)
    if (object.ok === true && worktree) {
      removed.add(worktree)
      named.add(worktree)
    }
    const cleanup = isObject(object.cleanup) ? object.cleanup : undefined
    if (cleanup?.ok === true && text(cleanup.removed)) removed.add(text(cleanup.removed) as string)
    const held = isObject(object.receipt) ? object.receipt : undefined
    const path = isObject(held?.worktree) ? text(held.worktree.path) : undefined
    if (path) named.add(path)
  }
  for (const line of texts) {
    for (const match of line.matchAll(REMOVED_TEXT)) {
      removed.add(match[1] as string)
      named.add(match[1] as string)
    }
  }
  for (const path of removed) named.add(path)
  return { removed: [...removed], named: [...named] }
}

/**
 * The active lane a landing result is about: one whose directory the result says was
 * removed, or names and is gone. `canonical` compares paths; `isGone` says whether a named
 * directory no longer exists.
 */
export function laneForLanding(
  result: unknown,
  lanes: readonly Lane[],
  canonical: (path: string) => string = (path) => path,
  isGone: (path: string) => boolean = () => false,
): Lane | undefined {
  const facts = readLanding(result)
  const removed = new Set(facts.removed.map(canonical))
  const named = new Set(facts.named.map(canonical))
  return lanes.find((lane) => {
    if (lane.state !== "active") return false
    const directory = canonical(lane.directory)
    return removed.has(directory) || (named.has(directory) && isGone(lane.directory))
  })
}
