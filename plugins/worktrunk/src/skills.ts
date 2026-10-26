import { readFile } from "node:fs/promises"
import { join } from "node:path"

/** The skills this plugin ships, each in `skills/<name>/SKILL.md`. */
export const SKILL_NAMES = ["worktrunk-preflight", "worktrunk-worktrees"] as const

/** `skills/` at the package root; `src/` and the bundled `dist/` both sit one level below it. */
export const SKILLS_DIRECTORY = join(import.meta.dir, "..", "skills")

export type SkillFile = {
  name: string
  description?: string
  autoinvoke: boolean
  content: string
}

function unquote(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2 && (trimmed[0] === '"' || trimmed[0] === "'") && trimmed.at(-1) === trimmed[0])
    return trimmed.slice(1, -1)
  return trimmed
}

/**
 * Split a SKILL.md into its frontmatter fields and body. Only flat `key: value`
 * lines are read; `name` is required.
 */
export function parseSkillMarkdown(markdown: string): SkillFile {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(markdown)
  if (!match) throw new Error("SKILL.md has no frontmatter")
  const fields: Record<string, string> = {}
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    const field = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line)
    if (field) fields[field[1] ?? ""] = unquote(field[2] ?? "")
  }
  const name = fields.name
  if (!name) throw new Error("SKILL.md frontmatter has no name")
  const skill: SkillFile = {
    name,
    autoinvoke: fields["disable-model-invocation"] !== "true",
    content: markdown.slice(match[0].length).trim(),
  }
  if (fields.description) skill.description = fields.description
  return skill
}

export type LoadedSkill = SkillFile & { path: string }

/** Read and parse every shipped skill. */
export async function loadSkills(directory: string = SKILLS_DIRECTORY): Promise<LoadedSkill[]> {
  return Promise.all(
    SKILL_NAMES.map(async (name) => {
      const path = join(directory, name, "SKILL.md")
      return { ...parseSkillMarkdown(await readFile(path, "utf8")), path }
    }),
  )
}
