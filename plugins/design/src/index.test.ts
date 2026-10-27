import { expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { SupervisedRun } from "@srobroek/opencode-lib/subprocess"
import { createFakeContext } from "@srobroek/opencode-lib/testing"
import plugin, { createPlugin, SCAN_TOOL, SETUP_TOOL } from "./index.ts"

const SKILLS = [
  "accessibility-audit",
  "design-component-truth",
  "design-evidence",
  "design-guide",
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

type Execute = (input: unknown, context: unknown) => Promise<{ content: string; metadata: Record<string, unknown> }>

const context = { sessionID: "ses_1", agent: "build", messageID: "msg_1", id: "call_1", signal: new AbortController().signal }

test("registers the design skills, the four design agents, both tools and the scan prompt", async () => {
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
  expect([...fake.tools.keys()]).toEqual([SETUP_TOOL, SCAN_TOOL])
  expect(fake.hooks("permission")).toEqual(["evaluate"])
  await cleanup?.()
  expect(fake.active()).toBe(0)
  expect(fake.tools.size).toBe(0)
})

test("confirmScan=false leaves the scan to the configured permission rules", async () => {
  const fake = createFakeContext({ options: { confirmScan: false } })
  await plugin.setup(fake.context)
  expect(fake.hooks("permission")).toEqual([])
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

test("design_setup asks for the resolved workspace and copies the formulas", async () => {
  const repo = mkdtempSync(join(tmpdir(), "design-setup-"))
  try {
    mkdirSync(join(repo, ".beads"))
    const fake = createFakeContext({ directory: repo })
    await plugin.setup(fake.context)
    const setup = fake.tools.get(SETUP_TOOL)?.execute as Execute
    const result = await setup({}, context)
    expect(result.metadata.ok).toBe(true)
    expect(fake.asserts[0]).toMatchObject({ action: SETUP_TOOL, resources: [repo] })
    expect(existsSync(join(repo, ".beads", "formulas", "design-touch.formula.toml"))).toBe(true)
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test("design_impeccable_scan asks before npx runs, and a rejection stops it", async () => {
  const seen: string[][] = []
  const exec = async (argv: string[]): Promise<SupervisedRun> => {
    seen.push(argv)
    return { kind: "exited", exitCode: 0, signalCode: null, stdout: "[]", stderr: "" }
  }
  const fake = createFakeContext({ directory: "/project" })
  await createPlugin({ exec }).setup(fake.context)
  const scan = fake.tools.get(SCAN_TOOL)?.execute as Execute
  const result = await scan({ targets: ["src", "https://example.test/"] }, context)
  expect(result.metadata).toMatchObject({ ok: true, status: "clean", findings: 0 })
  expect(fake.asserts[0]).toMatchObject({ action: SCAN_TOOL, resources: ["/project/src", "https://example.test/"] })
  expect(seen[0]).toEqual(["npx", "--yes", "impeccable", "detect", "--json", "/project/src", "https://example.test/"])

  const refused = createFakeContext({
    assert: () => {
      throw new Error("rejected")
    },
  })
  await createPlugin({ exec }).setup(refused.context)
  const blocked = refused.tools.get(SCAN_TOOL)?.execute as Execute
  await expect(blocked({ targets: ["src"] }, context)).rejects.toThrow("rejected")
  expect(seen).toHaveLength(1)
  expect((await blocked({ targets: [] }, context)).metadata.ok).toBe(false)
})
