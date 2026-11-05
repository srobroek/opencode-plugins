import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { createFakeContext } from "@srobroek/opencode-lib/testing"
import plugin, { COMMAND, scaffoldPrompt } from "./index.ts"

test("registers the skills with their references beside them", async () => {
  const fake = createFakeContext()
  const cleanup = await plugin.setup(fake.context)
  expect([...fake.skills.keys()].sort()).toEqual(["license-picker", "project-scaffold", "project-secrets"])
  for (const id of fake.skills.keys()) {
    const skill = fake.skills.get(id) as unknown as { path: string; content: string }
    for (const reference of skill.content.matchAll(/`(references\/[\w-]+\.md)`/g))
      expect(existsSync(join(dirname(skill.path), reference[1] ?? ""))).toBe(true)
  }
  await cleanup?.()
  expect(fake.active()).toBe(0)
  expect(fake.commands.size).toBe(0)
})

test("project-scaffold links every reference it names", async () => {
  const fake = createFakeContext()
  const cleanup = await plugin.setup(fake.context)
  const skill = fake.skills.get("project-scaffold") as unknown as { path: string }
  for (const name of ["rust", "python", "go", "typescript", "monorepo", "plugins", "layout", "shapes", "governance", "capabilities", "justfile", "ci-hooks", "worktrees", "brownfield"])
    expect(existsSync(join(dirname(skill.path), "references", `${name}.md`))).toBe(true)
  await cleanup?.()
})

test("project-secrets links every reference it names", async () => {
  const fake = createFakeContext()
  const cleanup = await plugin.setup(fake.context)
  const skill = fake.skills.get("project-secrets") as unknown as { path: string }
  for (const name of ["fnox-config", "ci-github", "aws-leases", "mcp"])
    expect(existsSync(join(dirname(skill.path), "references", `${name}.md`))).toBe(true)
  await cleanup?.()
})

test("scaffoldPrompt loads the skill and forwards the arguments", () => {
  expect(scaffoldPrompt("  rust cli  ")).toContain("`project-scaffold` skill")
  expect(scaffoldPrompt("  rust cli  ")).toContain("The user's request: rust cli")
  expect(scaffoldPrompt("   ")).toContain("start with the skill's interview")
  expect(scaffoldPrompt("")).not.toContain("The user's request")
})

test("/new-project submits the scaffold prompt in the invoking session", async () => {
  const fake = createFakeContext()
  const cleanup = await plugin.setup(fake.context)
  const command = fake.commands.get(COMMAND)
  expect(command?.name).toBe("new-project")
  await command?.execute({ sessionID: "ses_1", prompt: { text: "go service" }, delivery: "queue" } as never)
  const call = fake.calls.find((entry) => entry.method === "session.prompt")
  const input = call?.input as { sessionID: string; text: string; delivery: string }
  expect(input.sessionID).toBe("ses_1")
  expect(input.text).toContain("The user's request: go service")
  expect(input.delivery).toBe("queue")
  await cleanup?.()
  expect(fake.commands.has(COMMAND)).toBe(false)
  expect(fake.active()).toBe(0)
})
