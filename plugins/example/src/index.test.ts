import { describe, expect, test } from "bun:test"
import plugin, { blockReason } from "./index.ts"

describe("blockReason", () => {
  test("blocks a bare force push", () => {
    expect(blockReason("shell", { command: "git push origin main --force" })).toBeDefined()
  })
  test("allows force-with-lease", () => {
    expect(blockReason("shell", { command: "git push --force-with-lease" })).toBeUndefined()
  })
  test("ignores other tools", () => {
    expect(blockReason("read", { command: "git push --force" })).toBeUndefined()
  })
})

describe("setup", () => {
  test("registers the tool and the hook, and cleans both up", async () => {
    const disposed: string[] = []
    const added: string[] = []
    let hook: ((event: { tool: string; input: unknown }) => void) | undefined
    const ctx = {
      tool: {
        transform: async (cb: (editor: { add: (tool: { name: string }) => void }) => void) => {
          cb({ add: (tool) => added.push(tool.name) })
          return { dispose: async () => void disposed.push("tools") }
        },
        hook: async (_name: string, cb: typeof hook) => {
          hook = cb
          return { dispose: async () => void disposed.push("hook") }
        },
      },
    }
    // biome-ignore lint/suspicious/noExplicitAny: minimal fake of the plugin context
    const cleanup = await plugin.setup(ctx as any)
    expect(added).toEqual(["example_echo"])
    expect(() => hook?.({ tool: "shell", input: { command: "git push -u origin x --force" } })).toThrow()
    await (cleanup as () => Promise<void>)()
    expect(disposed.sort()).toEqual(["hook", "tools"])
  })
})
