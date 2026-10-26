import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createFakeContext } from "@srobroek/opencode-lib/testing"
import plugin from "./index.ts"

const E1 = "error[typescript] (2322) at 3:6: Type 'string' is not assignable to type 'number'."
const E2 = "error[typescript] (2304) at 9:1: Cannot find name 'foo'."

type Result = { content: unknown; output?: unknown }
type Seen = { input: { filePath: string; severity: string }; context: Record<string, unknown> }

function project() {
  const dir = mkdtempSync(join(tmpdir(), "lsp-plugin-"))
  writeFileSync(join(dir, "a.ts"), "")
  return dir
}

async function load(opts: { tool?: string; options?: Record<string, unknown>; respond?: (path: string) => unknown }) {
  const directory = project()
  const diagnostics = new Map<string, string>()
  const seen: Seen[] = []
  const respond =
    opts.respond ?? ((path: string) => ({ content: [{ type: "text", text: diagnostics.get(path) ?? "No diagnostics found" }] }))
  const fake = createFakeContext({
    directory,
    options: opts.options,
    tools: [
      {
        name: opts.tool ?? "lsp_diagnostics",
        execute: async (input: Seen["input"], context: Seen["context"]) => {
          seen.push({ input, context })
          return respond(input.filePath)
        },
      },
    ],
  })
  const cleanup = await plugin.setup(fake.context)
  const call = { sessionID: "ses_1", agent: "build", messageID: "msg_1", id: "call_1" }
  const edit = async (path: string, tool = "edit") => {
    const input = tool === "write" ? { path, content: "" } : { path, oldString: "a", newString: "b" }
    await fake.fire.tool("execute.before", { ...call, tool, input })
    if (tool === "write") writeFileSync(join(directory, path), "")
    const event = await fake.fire.tool("execute.after", {
      ...call,
      tool,
      input,
      status: "completed" as const,
      result: { content: "Edited." } as Result,
    })
    return event.result.content
  }
  return { fake, cleanup, directory, diagnostics, seen, edit }
}

describe("setup", () => {
  test("registers before and after hooks and disposes them", async () => {
    const { fake, cleanup } = await load({})
    expect(fake.hooks("tool")).toEqual(["execute.before", "execute.after"])
    await cleanup?.()
    expect(fake.active()).toBe(0)
  })
})

describe("diagnostics after edits", () => {
  test("appends only errors the edit introduced", async () => {
    const { directory, diagnostics, edit, seen } = await load({})
    const file = join(directory, "a.ts")
    diagnostics.set(file, E1)
    expect(await edit("a.ts")).toBe("Edited.")
    diagnostics.set(file, `${E1.replace("3:6", "4:6")}\n${E2}`)
    expect(await edit("a.ts")).toBe(`Edited.\nLSP: 1 new error after this edit\na.ts\n  ${E2}`)
    expect(seen[0]?.input).toEqual({ filePath: file, severity: "error" })
    expect(seen[0]?.context).toMatchObject({ sessionID: "ses_1", agent: "build", messageID: "msg_1", id: "call_1" })
    expect(seen[0]?.context.signal).toBeInstanceOf(AbortSignal)
  })

  test("a new file has an empty baseline", async () => {
    const { directory, diagnostics, edit, seen } = await load({})
    const file = join(directory, "b.ts")
    diagnostics.set(file, E2)
    expect(await edit("b.ts", "write")).toContain(E2)
    // The before hook found no file to check; only the after hook asked.
    expect(seen.length).toBe(1)
  })

  test("without a before baseline every error counts", async () => {
    const { directory, diagnostics, edit } = await load({ options: { baseline: false } })
    diagnostics.set(join(directory, "a.ts"), E1)
    expect(await edit("a.ts")).toContain(E1)
    expect(await edit("a.ts")).toBe("Edited.")
  })

  test("a custom tool name is honoured and a missing tool is a no-op", async () => {
    const custom = await load({ tool: "ide_diagnostics", options: { tool: "ide_diagnostics" } })
    expect(await custom.edit("a.ts")).toBe("Edited.")
    expect(custom.seen.length).toBe(2)
    const missing = await load({ tool: "other_tool" })
    expect(await missing.edit("a.ts")).toBe("Edited.")
    expect(missing.seen.length).toBe(0)
  })

  test("a failing or slow tool leaves the result alone", async () => {
    const failing = await load({
      respond: () => {
        throw new Error("boom")
      },
    })
    expect(await failing.edit("a.ts")).toBe("Edited.")
    const slow = await load({ options: { timeout: 20 }, respond: () => new Promise(() => {}) })
    const started = Date.now()
    expect(await slow.edit("a.ts")).toBe("Edited.")
    expect(Date.now() - started).toBeLessThan(1000)
  })

  test("errored calls and other tools are ignored", async () => {
    const { fake, seen } = await load({})
    await fake.fire.tool("execute.after", {
      sessionID: "ses_1",
      agent: "build",
      messageID: "msg_1",
      id: "call_2",
      tool: "edit",
      input: { path: "a.ts" },
      status: "error",
      error: { message: "no" },
    })
    await fake.fire.tool("execute.after", {
      sessionID: "ses_1",
      agent: "build",
      messageID: "msg_1",
      id: "call_3",
      tool: "read",
      input: { path: "a.ts" },
      status: "completed",
      result: { content: "x" },
    })
    expect(seen.length).toBe(0)
  })
})
