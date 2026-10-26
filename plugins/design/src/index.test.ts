import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { createFakeContext } from "@srobroek/opencode-lib/testing"
import plugin from "./index.ts"

const SKILLS = [
  "accessibility-audit",
  "design-component-truth",
  "design-evidence",
  "design-md",
  "design-no-slop",
  "design-prototype",
  "design-system-audit",
  "design-token-discipline",
  "design-upstream-preflight",
  "motion-design",
  "ui-microcopy",
  "ui-review",
  "wireloom",
]

test("registers the design skills and the four design agents", async () => {
  const fake = createFakeContext()
  const cleanup = await plugin.setup(fake.context)
  expect([...fake.skills.keys()]).toEqual(SKILLS)
  expect([...fake.agents.keys()].sort()).toEqual(["a11y-auditor", "design-critic", "ui-implementer", "ui-ux-specialist"])
  for (const agent of fake.agents.values()) expect(agent.mode).toBe("subagent")
  expect(fake.agents.get("ui-ux-specialist")?.permissions).toContainEqual({
    action: "subagent",
    resource: "design-critic",
    effect: "allow",
  })
  await cleanup?.()
  expect(fake.active()).toBe(0)
})

test("every own references/ path in a design skill resolves; other skills' references exist too", async () => {
  const fake = createFakeContext()
  await plugin.setup(fake.context)
  const skills = new Map([...fake.skills].map(([id, skill]) => [id, skill as unknown as { path: string; content: string }]))
  for (const skill of skills.values()) {
    for (const match of skill.content.matchAll(/(?:the `([\w-]+)` skill's )?`(references\/[\w.-]+\.md)`/g)) {
      const owner = match[1] ? skills.get(match[1]) : skill
      expect(owner).toBeDefined()
      expect(existsSync(join(dirname(owner?.path ?? ""), match[2] ?? ""))).toBe(true)
    }
  }
})
