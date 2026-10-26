import { describe, expect, test } from "bun:test"
import { Worktree } from "@opencode/plugin"
import { createFakeContext } from "@srobroek/opencode-lib/testing"
import { createPlugin, mergeGateCall, operationError, readOptions, shellCwd } from "./index.ts"
import type { Probes } from "./merge-gate.ts"
import { STRATEGY_ID } from "./worktree.ts"

type Loose = Record<string, unknown>

/** The lib fake plus the worktree and skill domains this plugin uses. */
function fakeContext(options: Loose = {}, sessions: Loose[] = []) {
  const fake = createFakeContext({ options, sessions: sessions as never })
  const strategies: { id: string }[] = []
  const skills = new Map<string, Loose>()
  let live = 0
  const registration = (onDispose: () => void) => {
    live++
    let disposed = false
    return {
      dispose: async () => {
        if (disposed) return
        disposed = true
        live--
        onDispose()
      },
    }
  }
  const context = fake.context as unknown as Loose
  context.worktree = {
    transform: async (callback: (editor: { add: (definition: { id: string }) => void }) => void) => {
      const added: { id: string }[] = []
      callback({ add: (definition) => void added.push(definition) })
      strategies.push(...added)
      return registration(() => {
        for (const definition of added) strategies.splice(strategies.indexOf(definition), 1)
      })
    },
  }
  context.skill = {
    transform: async (callback: (editor: unknown) => void) => {
      const added: string[] = []
      callback({
        get: (id: string) => skills.get(id),
        add: (skill: Loose & { id: string }) => {
          skills.set(skill.id, skill)
          added.push(skill.id)
        },
      })
      return registration(() => {
        for (const id of added) skills.delete(id)
      })
    },
  }
  return { fake, strategies, skills, active: () => live + fake.active() }
}

const shell = (command: string, extra: Loose = {}) => ({
  tool: "shell",
  sessionID: "ses_1",
  input: { command, ...extra },
})

const probes = (seen: string[] = []): Probes => ({
  git: async (args, cwd) => {
    seen.push(cwd)
    return args[0] === "branch" ? "worker" : "origin/main"
  },
  wt: async () => null,
})

describe("pure helpers", () => {
  test("strategy is on unless explicitly disabled", () => {
    expect(readOptions(undefined).strategy).toBe(true)
    expect(readOptions({ strategy: true }).strategy).toBe(true)
    expect(readOptions({ strategy: false }).strategy).toBe(false)
  })
  test("only shell calls that mention merge are checked", () => {
    expect(mergeGateCall("shell", { command: "ls" })).toBeUndefined()
    expect(mergeGateCall("read", { command: "wt merge x" })).toBeUndefined()
    expect(mergeGateCall("shell", { command: "wt merge x", workdir: "sub" })).toEqual({
      command: "wt merge x",
      workdir: "sub",
    })
  })
  test("workdir resolves against the session directory", () => {
    expect(shellCwd(undefined, "/s")).toBe("/s")
    expect(shellCwd("sub", "/s")).toBe("/s/sub")
    expect(shellCwd("/abs", "/s")).toBe("/abs")
  })
  test("operationError is a Worktree.OperationError with forceRequired only when set", () => {
    const dirty = operationError("dirty", true)
    expect(dirty).toBeInstanceOf(Worktree.OperationError)
    expect((dirty as Worktree.OperationError).forceRequired).toBe(true)
    expect((operationError("other") as Worktree.OperationError).forceRequired).toBeUndefined()
  })
})

describe("setup", () => {
  test("registers the strategy, the gate and the skills, and disposes all of them", async () => {
    const ctx = fakeContext()
    const cleanup = await createPlugin({ probes: probes() }).setup(ctx.fake.context)
    expect(ctx.strategies.map((strategy) => strategy.id)).toEqual([STRATEGY_ID])
    expect(ctx.fake.hooks("tool")).toEqual(["execute.before"])
    expect([...ctx.skills.keys()]).toEqual(["worktrunk-preflight", "worktrunk-worktrees"])
    const skill = ctx.skills.get("worktrunk-preflight") as Loose
    expect(skill.path).toMatch(/skills\/worktrunk-preflight\/SKILL\.md$/)
    expect(skill.content).toContain("preflight.py")
    await (cleanup as () => Promise<void>)()
    expect(ctx.active()).toBe(0)
    expect(ctx.strategies).toHaveLength(0)
    expect(ctx.skills.size).toBe(0)
  })

  test("strategy: false skips the worktree strategy only", async () => {
    const ctx = fakeContext({ strategy: false })
    const cleanup = await createPlugin({ probes: probes() }).setup(ctx.fake.context)
    expect(ctx.strategies).toHaveLength(0)
    expect(ctx.fake.hooks("tool")).toEqual(["execute.before"])
    await (cleanup as () => Promise<void>)()
    expect(ctx.active()).toBe(0)
  })

  test("keeps a skill the host already has", async () => {
    const ctx = fakeContext()
    ctx.skills.set("worktrunk-worktrees", { id: "worktrunk-worktrees", content: "user override" })
    await createPlugin({ probes: probes() }).setup(ctx.fake.context)
    expect(ctx.skills.get("worktrunk-worktrees")?.content).toBe("user override")
  })

  test("the gate blocks an unflagged epic merge and allows a flagged one", async () => {
    const ctx = fakeContext()
    await createPlugin({ probes: probes() }).setup(ctx.fake.context)
    await expect(ctx.fake.fire.tool("execute.before", shell("wt merge develop"))).rejects.toThrow(
      "worker-to-epic merges must preserve history",
    )
    await ctx.fake.fire.tool("execute.before", shell("wt merge develop --no-squash --no-ff"))
    await ctx.fake.fire.tool("execute.before", shell("wt merge main"))
    await ctx.fake.fire.tool("execute.before", { tool: "read", sessionID: "ses_1", input: { command: "wt merge x" } })
  })

  test("the gate probes the session's directory joined with workdir", async () => {
    const seen: string[] = []
    const ctx = fakeContext({}, [{ id: "ses_1", location: { directory: "/wt/worker" } }])
    await createPlugin({ probes: probes(seen) }).setup(ctx.fake.context)
    await ctx.fake.fire.tool("execute.before", shell("wt merge develop --no-squash --no-ff", { workdir: "pkg" }))
    expect(seen).toContain("/wt/worker/pkg")
  })

  test("the gate falls back to the plugin location when the session is unknown", async () => {
    const seen: string[] = []
    const ctx = fakeContext()
    await createPlugin({ probes: probes(seen) }).setup(ctx.fake.context)
    await ctx.fake.fire.tool("execute.before", shell("wt merge develop --no-squash --no-ff"))
    expect(seen).toContain("/fake/project")
  })

  test("a failing registration disposes the earlier ones", async () => {
    const ctx = fakeContext()
    const failing = createPlugin({ probes: probes(), skillsDirectory: "/nonexistent" })
    await expect(failing.setup(ctx.fake.context)).rejects.toThrow()
    expect(ctx.active()).toBe(0)
  })
})
