import { describe, expect, test } from "bun:test"
import {
  IMPLEMENT_REDIRECT,
  MARKER,
  rewriteSkill,
  skillRefusal,
  staleSkills,
  TASKSTOISSUES_REFUSAL,
  TASKSTOISSUES_SKILLS,
} from "./skills.ts"

const on = { implement: true, taskstoissues: true }
const off = { implement: false, taskstoissues: false }

describe("rewriteSkill", () => {
  test("replaces the upstream implement skill with the beads route", () => {
    const next = rewriteSkill({ id: "speckit-implement", content: "process tasks.md" }, on)
    expect(next?.content).toBe(IMPLEMENT_REDIRECT)
    expect(next?.content?.startsWith(MARKER)).toBe(true)
  })

  test("replaces every taskstoissues name, including the spec-kit 1.2 github extension", () => {
    for (const id of TASKSTOISSUES_SKILLS)
      expect(rewriteSkill({ id, content: "x" }, on)?.content).toContain(TASKSTOISSUES_REFUSAL)
  })

  test("leaves rewritten, unrelated and switched-off skills alone", () => {
    expect(rewriteSkill({ id: "speckit-implement", content: IMPLEMENT_REDIRECT }, on)).toBeUndefined()
    expect(rewriteSkill({ id: "speckit-tasks", content: "x" }, on)).toBeUndefined()
    expect(rewriteSkill({ id: "speckit-implement", content: "x" }, off)).toBeUndefined()
    expect(rewriteSkill({ id: "speckit-github-taskstoissues-extra", content: "x" }, on)).toBeUndefined()
  })
})

test("staleSkills reports only skills still carrying upstream content", () => {
  expect(staleSkills([{ id: "speckit-implement", content: "upstream" }], on)).toBe(true)
  expect(staleSkills([{ id: "speckit-implement", content: IMPLEMENT_REDIRECT }], on)).toBe(false)
  expect(staleSkills([{ id: "speckit-plan", content: "x" }], on)).toBe(false)
})

test("skillRefusal refuses only a skill tool load of a taskstoissues skill", () => {
  expect(skillRefusal("skill", { id: "speckit-taskstoissues" })).toBe(TASKSTOISSUES_REFUSAL)
  expect(skillRefusal("skill", { id: "speckit-github-taskstoissues" })).toBe(TASKSTOISSUES_REFUSAL)
  expect(skillRefusal("skill", { id: "speckit-tasks" })).toBeUndefined()
  expect(skillRefusal("read", { id: "speckit-taskstoissues" })).toBeUndefined()
  expect(skillRefusal("skill", null)).toBeUndefined()
})
