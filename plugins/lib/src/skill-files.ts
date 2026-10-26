/**
 * Register `SKILL.md` files shipped inside a plugin package through `ctx.skill.transform`.
 *
 * A plugin keeps its skills as markdown next to its code (`skills/<id>/SKILL.md`, with
 * `references/` beside it). The skill's `path` is the absolute file path, so relative
 * references in the body resolve against the skill's own directory.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { Skill } from "@opencode/plugin"
import type { Context } from "@opencode/plugin/promise/plugin"

export type SkillFile = {
  /** The frontmatter `name`, used as both id and name. */
  name: string
  description?: string
  /** `false` when the frontmatter sets `disable-model-invocation: true`: the user loads it, the model does not. */
  autoinvoke?: false
  /** The body after the frontmatter. */
  content: string
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

function unquote(value: string): string {
  const first = value[0]
  if (value.length > 1 && (first === '"' || first === "'") && value.endsWith(first)) return value.slice(1, -1)
  return value
}

/** The name, description and body of a `SKILL.md`. Throws when the frontmatter has no `name`. */
export function parseSkillFile(text: string): SkillFile {
  const match = FRONTMATTER.exec(text.replace(/^\uFEFF/, ""))
  const fields = new Map<string, string>()
  for (const line of (match?.[1] ?? "").split(/\r?\n/)) {
    const at = line.indexOf(":")
    if (at > 0 && !/^\s/.test(line)) fields.set(line.slice(0, at).trim(), unquote(line.slice(at + 1).trim()))
  }
  const name = fields.get("name")
  if (!name) throw new Error("SKILL.md frontmatter has no name")
  const description = fields.get("description")
  const content = match ? text.replace(/^\uFEFF/, "").slice(match[0].length) : text
  return {
    name,
    ...(description ? { description } : {}),
    ...(fields.get("disable-model-invocation") === "true" ? { autoinvoke: false as const } : {}),
    content,
  }
}

/** The `Skill.Info` for the `SKILL.md` at absolute `path`. */
export function skillInfo(path: string): Skill.Info {
  const file = parseSkillFile(readFileSync(path, "utf8"))
  return {
    id: file.name,
    name: file.name,
    description: file.description,
    ...(file.autoinvoke === false ? { autoinvoke: false } : {}),
    path,
    content: file.content,
  } as Skill.Info
}

/** The absolute `SKILL.md` path of every `<directory>/<name>/` that has one, sorted by name. */
export function skillPaths(directory: string): string[] {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(directory, entry.name, "SKILL.md"))
    .filter((path) => existsSync(path))
    .sort()
}

/**
 * Add each skill unless one with the same id already exists, so a user's own skill of
 * that name wins. Files are read once, before the transform registers.
 */
export async function registerSkills(skill: Context["skill"], paths: readonly string[]) {
  const infos = paths.map(skillInfo)
  return skill.transform((editor) => {
    for (const info of infos) if (editor.get(info.id) === undefined) editor.add(info)
  })
}
