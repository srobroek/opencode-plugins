/**
 * Route the spec-kit skills that conflict with beads. `speckit-implement` reads and ticks
 * tasks.md, so its content becomes a redirect to the implement step's beads; the
 * taskstoissues skills open a second tracker, so their content becomes a refusal and the
 * `skill` tool refuses to load them. Both apply only where a beads workspace is active.
 */

/** Marks content this plugin wrote, so a rewritten skill is not rewritten again. */
export const MARKER = "<!-- srobroek.speckit -->"

export const IMPLEMENT_SKILLS: readonly string[] = ["speckit-implement", "speckit.implement"]

export const TASKSTOISSUES_SKILLS: readonly string[] = [
  "speckit-taskstoissues",
  "speckit.taskstoissues",
  "speckit-github-taskstoissues",
  "speckit.github.taskstoissues",
]

export const IMPLEMENT_REDIRECT = `${MARKER}
# speckit-implement is replaced in this repository

This repository tracks tasks in beads, so the upstream implement command, which reads
and ticks \`specs/<spec>/tasks.md\`, does not run here. Work the task beads under the
molecule's unconditional \`implement\` step instead:

1. Find the run: \`bd query 'spec_id="<NNN-slug>"' --json\`, then \`bd mol current <root-id>\`.
2. Check the implement step's prerequisites are closed, including every analysis
   approval gate that was not waived. Stop and report when one is open.
3. Pick work with \`bd ready\`, claim it with \`bd update <id> --claim\`, implement and
   test it, then \`bd close <id> --reason "<evidence>"\`.
4. Keep the implement step open until every child is closed; then close it.

Do not create or edit \`specs/*/tasks.md\`; the speckit plugin refuses those writes.
If a check script demands tasks.md (\`check-prerequisites.sh --require-tasks\`), skip it
and read \`bd list --spec <NNN-slug>\`.`

export const TASKSTOISSUES_REFUSAL =
  "blocked by speckit: taskstoissues turns tasks.md into GitHub issues, a second task tracker in a repository whose task state already lives in beads. Do not invoke it; link an existing GitHub issue instead with bd update <id> --external-ref gh-<number>. Disable: set the srobroek.speckit plugin option blockTasksToIssues=false"

const TASKSTOISSUES_CONTENT = `${MARKER}\n${TASKSTOISSUES_REFUSAL}\n`

export type SkillLike = { id: string; content?: string; description?: string }

export type SkillRouting = { implement: boolean; taskstoissues: boolean }

/** The content one skill should have, or `undefined` to leave it as it is. */
export function rewriteSkill(
  skill: SkillLike,
  routing: SkillRouting,
): Pick<SkillLike, "content" | "description"> | undefined {
  if (skill.content?.startsWith(MARKER)) return undefined
  if (routing.implement && IMPLEMENT_SKILLS.includes(skill.id))
    return {
      content: IMPLEMENT_REDIRECT,
      description:
        "Work a SpecKit feature's implementation task beads under its molecule's implement step (replaces the tasks.md implement command)",
    }
  if (routing.taskstoissues && TASKSTOISSUES_SKILLS.includes(skill.id))
    return { content: TASKSTOISSUES_CONTENT, description: "Disabled here: task state lives in beads; do not load" }
  return undefined
}

/** Whether some skill in `skills` still has upstream content this plugin replaces. */
export function staleSkills(skills: ReadonlyArray<SkillLike>, routing: SkillRouting): boolean {
  return skills.some((skill) => rewriteSkill(skill, routing) !== undefined)
}

/** The refusal for a `skill` tool call that loads a taskstoissues skill. */
export function skillRefusal(tool: string, input: unknown): string | undefined {
  if (tool !== "skill" || input === null || typeof input !== "object") return undefined
  const id = (input as { id?: unknown }).id
  return typeof id === "string" && TASKSTOISSUES_SKILLS.includes(id) ? TASKSTOISSUES_REFUSAL : undefined
}
