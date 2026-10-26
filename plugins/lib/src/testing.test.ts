import { describe, expect, test } from "bun:test"
import { Plugin } from "@opencode/plugin"

import { createFakeContext } from "./testing.ts"

const plugin = Plugin.define({
  id: "srobroek.lib-test",
  async setup(ctx) {
    const tools = await ctx.tool.transform((editor) => {
      editor.add({
        name: "lib_echo",
        description: "Echo.",
        input: { type: "object" },
        execute: async () => ({ content: "echo" }),
      })
      editor.remove("webfetch")
    })
    const agents = await ctx.agent.transform((editor) => {
      editor.update("lib-agent", (agent) => {
        agent.description = "made by the test"
      })
    })
    const before = await ctx.tool.hook("execute.before", (event) => {
      if (event.tool === "shell") event.input = { command: "echo rewritten" }
    })
    const after = await ctx.tool.hook("execute.after", (event) => {
      if (event.status === "completed") event.result = { ...event.result, content: "after" }
    })
    const shell = await ctx.shell.hook("create.before", (event) => {
      event.env.LIB = "1"
    })
    const permission = await ctx.permission.hook("evaluate", (event) => {
      if (event.resources.includes("rm -rf /")) {
        event.effect = "deny"
        event.message = "no"
      }
    })
    const session = await ctx.session.hook("context", () => {})
    return async () => {
      for (const registration of [tools, agents, before, after, shell, permission, session]) {
        await registration.dispose()
      }
    }
  },
})

describe("createFakeContext", () => {
  test("records transforms and fires hooks the plugin registered", async () => {
    const fake = createFakeContext({ tools: [{ name: "webfetch" }, { name: "read" }] })
    const cleanup = await plugin.setup(fake.context)

    expect([...fake.tools.keys()].sort()).toEqual(["lib_echo", "read"])
    expect(fake.agentUpdates).toEqual(["lib-agent"])
    expect(fake.agents.get("lib-agent")).toEqual({ id: "lib-agent", description: "made by the test" })
    expect(fake.hooks("tool")).toEqual(["execute.before", "execute.after"])

    const call = await fake.fire.tool("execute.before", { tool: "shell", input: { command: "ls" } })
    expect(call.input).toEqual({ command: "echo rewritten" })
    const done = await fake.fire.tool("execute.after", { tool: "shell", status: "completed", result: { content: "x" } })
    expect(done.result.content).toBe("after")
    const spawn = await fake.fire.shell("create.before", { command: "ls", env: {} as Record<string, string> })
    expect(spawn.env.LIB).toBe("1")
    const evaluation = await fake.fire.permission("evaluate", {
      action: "shell",
      resources: ["rm -rf /"],
      effect: "ask",
    })
    expect(evaluation).toMatchObject({ effect: "deny", message: "no" })

    expect(fake.active()).toBe(7)
    await (cleanup as () => Promise<void>)()
    expect(fake.active()).toBe(0)
    expect(fake.hooks("tool")).toEqual([])
    expect(fake.tools.has("lib_echo")).toBe(false)
  })

  test("a throwing hook rejects the fire, as the host surfaces it", async () => {
    const fake = createFakeContext()
    await fake.context.tool.hook("execute.before", () => {
      throw new Error("blocked")
    })
    await expect(fake.fire.tool("execute.before", { tool: "shell" })).rejects.toThrow("blocked")
  })

  test("storage gets, sets, removes and scans by prefix in pages", async () => {
    const fake = createFakeContext({ storage: { "a/1": 1 } })
    const { storage } = fake.context
    await storage.set("a/2", 2)
    await storage.set("a/3", 3)
    await storage.set("b/1", 4)
    expect(await storage.get("a/1")).toBe(1)
    await storage.remove("a/1")
    expect(await storage.get("a/1")).toBeUndefined()
    expect(await storage.scan({ prefix: "a/", limit: 1 })).toEqual({ entries: [{ key: "a/2", value: 2 }], next: "a/2" })
    expect(await storage.scan({ prefix: "a/", after: "a/2" })).toEqual({ entries: [{ key: "a/3", value: 3 }] })
  })

  test("session stubs record calls and keep created sessions", async () => {
    const fake = createFakeContext({ directory: "/repo", sessions: [{ id: "ses_a" }] })
    const { session } = fake.context
    expect((await session.get({ sessionID: "ses_a" })).id).toBe("ses_a")
    const created = await session.create({ title: "child" })
    expect(fake.sessions.get(created.id)).toMatchObject({ title: "child", location: { directory: "/repo" } })
    await session.move({ sessionID: created.id, directory: "/wt" })
    expect(fake.sessions.get(created.id)?.location).toEqual({ directory: "/wt" })
    const message = await session.synthetic({ sessionID: "ses_a", text: "hi" })
    expect(message).toMatchObject({ sessionID: "ses_a", type: "synthetic" })
    expect(fake.calls.map((entry) => entry.method)).toEqual([
      "session.get",
      "session.create",
      "session.move",
      "session.synthetic",
    ])
    await expect(session.get({ sessionID: "ses_missing" })).rejects.toThrow("no session")
  })

  test("command transforms add commands and prompts are recorded", async () => {
    const fake = createFakeContext()
    const ran: string[] = []
    const registration = await fake.context.command.transform((editor) => {
      editor.add({ name: "lib-cmd", execute: async (input) => void ran.push(input.prompt.text) })
    })
    await fake.commands.get("lib-cmd")?.execute({ sessionID: "ses_a", prompt: { text: "args" } } as never)
    expect(ran).toEqual(["args"])
    await fake.context.session.prompt({ sessionID: "ses_a", text: "hello" })
    expect(fake.calls.at(-1)).toEqual({ method: "session.prompt", input: { sessionID: "ses_a", text: "hello" } })
    await registration.dispose()
    expect(fake.commands.size).toBe(0)
  })

  test("session.list filters and pages like the host; context returns stored messages", async () => {
    const fake = createFakeContext({
      sessions: [
        { id: "ses_a", projectID: "p", title: "Alpha work", time: { updated: 3 }, location: { directory: "/r" } },
        { id: "ses_b", projectID: "p", title: "beta", time: { updated: 2 }, location: { directory: "/w" } },
        { id: "ses_c", projectID: "p", parentID: "ses_a", time: { updated: 4 }, location: { directory: "/r" } },
        { id: "ses_d", projectID: "p", time: { updated: 5, archived: 5 }, location: { directory: "/r" } },
        { id: "ses_e", projectID: "q", time: { updated: 6 }, location: { directory: "/x" } },
      ],
      messages: { ses_a: [{ type: "user", text: "hi" }] },
    })
    const { session } = fake.context
    const ids = (page: { data: ReadonlyArray<{ id: string }> }) => page.data.map((entry) => entry.id)
    expect(ids(await session.list({ project: "p" }))).toEqual(["ses_d", "ses_c", "ses_a", "ses_b"])
    const first = await session.list({ project: "p", parentID: null, archived: false, limit: 1 })
    expect(ids(first)).toEqual(["ses_a"])
    const second = await session.list({ cursor: first.cursor.next ?? "" })
    expect(ids(second)).toEqual(["ses_b"])
    expect(second.cursor.next).toBeUndefined()
    expect(ids(await session.list({ search: "ALPHA" }))).toEqual(["ses_a"])
    expect(ids(await session.list({ directory: "/w" }))).toEqual(["ses_b"])
    expect(await session.context({ sessionID: "ses_a" })).toEqual([{ type: "user", text: "hi" }] as never)
  })

  test("skill.transform adds skills and dispose removes them", async () => {
    const fake = createFakeContext()
    const registration = await fake.context.skill.transform((editor) => {
      editor.add({ id: "s", name: "s", path: "/s/SKILL.md", content: "body" } as never)
    })
    expect(fake.skills.get("s")).toMatchObject({ content: "body" })
    await registration.dispose()
    expect(fake.skills.size).toBe(0)
  })

  test("event subscriptions receive emitted events until closed", async () => {
    const fake = createFakeContext()
    const seen: unknown[] = []
    const reader = (async () => {
      for await (const event of fake.context.event.subscribe()) seen.push(event)
    })()
    fake.emit({ type: "one" })
    fake.emit({ type: "two" })
    await Bun.sleep(0)
    fake.closeEvents()
    await reader
    expect(seen).toEqual([{ type: "one" }, { type: "two" }])
    expect(fake.calls).toEqual([{ method: "event.subscribe", input: undefined }])
  })

  test("skill transforms add skills and dispose them; existing skills stay", async () => {
    const fake = createFakeContext({ skills: [{ id: "host", content: "host" }] })
    const registration = await fake.context.skill.transform((editor) => {
      editor.add({ id: "mine", name: "mine", path: "/p/SKILL.md", content: "body" } as never)
      editor.update("host", (skill) => {
        skill.autoinvoke = true
      })
    })
    expect([...fake.skills.keys()]).toEqual(["host", "mine"])
    expect(fake.skills.get("host")).toMatchObject({ autoinvoke: true })
    await registration.dispose()
    expect([...fake.skills.keys()]).toEqual(["host"])
  })

  test("permission.assert records each input and applies the decision", async () => {
    const fake = createFakeContext({
      assert: (input) => {
        if (input.resources.includes("no")) throw new Error("rejected")
      },
    })
    const assert = fake.context.permission.assert
    await assert({ sessionID: "ses_a", action: "deploy", resources: ["yes"] })
    await expect(assert({ sessionID: "ses_a", action: "deploy", resources: ["no"] })).rejects.toThrow("rejected")
    expect(fake.asserts.map((input) => input.resources)).toEqual([["yes"], ["no"]])
  })
})
