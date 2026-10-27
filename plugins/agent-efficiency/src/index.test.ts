import { describe, expect, test } from "bun:test"
import { createFakeContext } from "@srobroek/opencode-lib/testing"
import plugin, { routeShellAlias } from "./index.ts"

const none = () => false

describe("routeShellAlias", () => {
  test("routes bash and Bash to shell with shell's input shape", () => {
    expect(routeShellAlias("bash", { command: "echo hi", description: "greet" }, none)).toEqual({
      tool: "shell",
      input: { command: "echo hi" },
    })
    expect(routeShellAlias("Bash", { command: "make", run_in_background: true, timeout: 1000 }, none)).toEqual({
      tool: "shell",
      input: { command: "make", background: true, timeout: 1000 },
    })
  })

  test("leaves other tools and a registered bash tool alone", () => {
    expect(routeShellAlias("shell", { command: "ls" }, none)).toBeUndefined()
    expect(routeShellAlias("read", { path: "a" }, none)).toBeUndefined()
    expect(routeShellAlias("bash", { command: "ls" }, (id) => id === "bash")).toBeUndefined()
  })
})

describe("plugin", () => {
  const call = (tool: string, input: unknown) => ({
    tool,
    input,
    sessionID: "ses_1",
    agent: "build",
    messageID: "msg_1",
    id: "call_1",
  })

  test("renames a bash call to shell before the host looks the tool up", async () => {
    const fake = createFakeContext({ tools: [{ name: "shell" }] })
    const cleanup = await plugin.setup(fake.context)
    const event = await fake.fire.tool("execute.before", call("bash", { command: "echo hi", cwd: "/w" }))
    expect(event.tool).toBe("shell")
    expect(event.input).toEqual({ command: "echo hi", workdir: "/w" })
    const read = await fake.fire.tool("execute.before", call("read", { path: "a" }))
    expect(read).toEqual(call("read", { path: "a" }))
    await cleanup?.()
    expect(fake.active()).toBe(0)
  })

  test("defers to a plugin that registered a real bash tool", async () => {
    const fake = createFakeContext({ tools: [{ name: "shell" }, { name: "bash" }] })
    await plugin.setup(fake.context)
    const event = await fake.fire.tool("execute.before", call("bash", { command: "ls" }))
    expect(event.tool).toBe("bash")
  })

  test("bashAlias: false registers nothing", async () => {
    const fake = createFakeContext({ options: { bashAlias: false } })
    await plugin.setup(fake.context)
    expect(fake.hooks("tool")).toEqual([])
    const event = await fake.fire.tool("execute.before", call("bash", { command: "ls" }))
    expect(event.tool).toBe("bash")
  })
})
