import { describe, expect, test } from "bun:test"
import { createFakeContext } from "@srobroek/opencode-lib/testing"
import type { MergeRequest } from "./flag-cleanup.ts"
import { createPlugin, readOptions, SKILL_NAMES, SKIP_CI_ADVISORY, shellCwd } from "./index.ts"

const session = { id: "ses_1", location: { directory: "/project" } }
const base = { sessionID: "ses_1", agent: "build", messageID: "msg_1" }

function setup(options: Record<string, unknown> = {}, overrides: Parameters<typeof createPlugin>[0] = {}) {
  const fake = createFakeContext({ sessions: [session], options })
  const merges: MergeRequest[][] = []
  const plugin = createPlugin({
    commitGate: (command) => (command.includes("bad") ? { reason: "nope" } : undefined),
    advise: (command) => (command.includes("gh pr create") ? ["trunk-dev: advice"] : []),
    followUp: async (found) => {
      merges.push([...found])
      return "trunk-dev: created cleanup bead c-1"
    },
    reminder: async () => undefined,
    ...overrides,
  })
  return { fake, plugin, merges }
}

const shellResult = (exit: number, output = "ok") => ({ output: { exit, output }, metadata: { exit }, content: output })

describe("trunk-dev plugin", () => {
  test("session reminder runs once across concurrent shell results, including failures", async () => {
    let calls = 0
    const { fake, plugin } = setup({}, { reminder: async () => { calls++; return "stale reminder" } })
    const cleanup = await plugin.setup(fake.context)
    const fire = (id: string) => fake.fire.tool("execute.after", { ...base, id, tool: "bash", input: { command: "false" }, status: "completed", result: shellResult(1) })
    const events = await Promise.all([fire("c1"), fire("c2")])
    expect(calls).toBe(1)
    expect(events.filter((event) => String((event as { result: { content: unknown } }).result.content).includes("stale reminder"))).toHaveLength(1)
    await cleanup?.()
  })

  test("disabled session reminders never probe", async () => {
    let calls = 0
    const { fake, plugin } = setup({ disable: ["session-reminders"] }, { reminder: async () => { calls++; return "note" } })
    const cleanup = await plugin.setup(fake.context)
    await fake.fire.tool("execute.after", { ...base, id: "c1", tool: "shell", input: { command: "true" }, status: "completed", result: shellResult(0) })
    expect(calls).toBe(0)
    await cleanup?.()
  })
  test("the commit gate throws from execute.before on shell only", async () => {
    const { fake, plugin } = setup()
    const cleanup = await plugin.setup(fake.context)
    await expect(
      fake.fire.tool("execute.before", { ...base, id: "c1", tool: "shell", input: { command: "git commit -m bad" } }),
    ).rejects.toThrow("trunk-dev: nope")
    await fake.fire.tool("execute.before", { ...base, id: "c2", tool: "shell", input: { command: "git status" } })
    await fake.fire.tool("execute.before", { ...base, id: "c3", tool: "edit", input: { command: "bad" } })
    await cleanup?.()
    expect(fake.active()).toBe(0)
  })

  test("a disabled commit gate lets the command through", async () => {
    const { fake, plugin } = setup({ disable: ["commit-gate"] })
    const cleanup = await plugin.setup(fake.context)
    await fake.fire.tool("execute.before", { ...base, id: "c1", tool: "shell", input: { command: "git commit -m bad" } })
    await cleanup?.()
  })

  test("execute.after appends skip-CI and MR advisories to a successful shell call", async () => {
    const { fake, plugin } = setup()
    const cleanup = await plugin.setup(fake.context)
    const event = await fake.fire.tool("execute.after", {
      ...base,
      id: "c1",
      tool: "shell",
      input: { command: "gh pr create -t 'fix: x' -b 'see [skip ci]'" },
      status: "completed",
      result: shellResult(0),
    })
    const content = String((event as { result: { content: unknown } }).result.content)
    expect(content).toContain(SKIP_CI_ADVISORY)
    expect(content).toContain("trunk-dev: advice")
    const failed = await fake.fire.tool("execute.after", {
      ...base,
      id: "c2",
      tool: "shell",
      input: { command: "gh pr create -t 'fix: x' -b '[skip ci]'" },
      status: "completed",
      result: shellResult(1, "boom"),
    })
    expect((failed as { result: { content: unknown } }).result.content).toBe("boom")
    await cleanup?.()
  })

  test("a proved delivery_land triggers the flag-cleanup follow-up; a refusal does not", async () => {
    const { fake, plugin, merges } = setup()
    const cleanup = await plugin.setup(fake.context)
    const landed = await fake.fire.tool("execute.after", {
      ...base,
      id: "c1",
      tool: "delivery_land",
      input: { pr: 6 },
      status: "completed",
      result: { output: { ok: true, pr: 6, receipt: { repo: { forge: "github" } } }, content: "delivery_land proved" },
    })
    expect(merges).toEqual([[{ forge: "gh", number: "6", cwd: "/project" }]])
    expect(String((landed as { result: { content: unknown } }).result.content)).toContain("created cleanup bead c-1")
    await fake.fire.tool("execute.after", {
      ...base,
      id: "c2",
      tool: "delivery_land",
      input: { pr: 6 },
      status: "completed",
      result: { output: { ok: false, reason: "no" }, content: "refused" },
    })
    await fake.fire.tool("execute.after", { ...base, id: "c3", tool: "delivery_land", input: {}, status: "error", error: {} })
    expect(merges).toHaveLength(1)
    await cleanup?.()
  })

  test("a successful shell gh pr merge triggers the follow-up in the call's workdir", async () => {
    const { fake, plugin, merges } = setup()
    const cleanup = await plugin.setup(fake.context)
    await fake.fire.tool("execute.after", {
      ...base,
      id: "c1",
      tool: "shell",
      input: { command: "gh pr merge 9 --squash", workdir: "sub" },
      status: "completed",
      result: shellResult(0),
    })
    expect(merges).toEqual([[{ forge: "gh", number: "9", cwd: "/project/sub" }]])
    await cleanup?.()
  })

  test("a failing follow-up never fails the call", async () => {
    const { fake, plugin } = setup({}, { followUp: async () => Promise.reject(new Error("bd missing")) })
    const cleanup = await plugin.setup(fake.context)
    const event = await fake.fire.tool("execute.after", {
      ...base,
      id: "c1",
      tool: "delivery_land",
      input: {},
      status: "completed",
      result: { output: { ok: true, pr: 1 }, content: "proved" },
    })
    expect((event as { result: { content: unknown } }).result.content).toBe("proved")
    await cleanup?.()
  })

  test("registers its skills and disposes everything", async () => {
    const { fake, plugin } = setup()
    const cleanup = await plugin.setup(fake.context)
    expect([...fake.skills.keys()].sort()).toEqual([...SKILL_NAMES].sort())
    await cleanup?.()
    expect(fake.active()).toBe(0)
  })

  test("options and workdir helpers", () => {
    expect([...readOptions({ disable: ["skip-ci", "nope"] })]).toEqual(["skip-ci"])
    expect(shellCwd(undefined, "/p")).toBe("/p")
    expect(shellCwd("/abs", "/p")).toBe("/abs")
    expect(shellCwd("rel", "/p")).toBe("/p/rel")
  })
})
