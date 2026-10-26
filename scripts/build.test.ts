import { describe, expect, test } from "bun:test"
import path from "node:path"
import { buildPlugin } from "./build.ts"

const example = path.resolve(import.meta.dir, "../plugins/example")
const statusline = path.resolve(import.meta.dir, "../plugins/statusline")

describe("buildPlugin", () => {
  test("inlines the shared lib and keeps host modules external", async () => {
    const outputs = await buildPlugin(example)
    const bundle = outputs.find((output) => output.file === path.join(example, "dist/index.js"))
    expect(bundle?.contents).toContain('from "@opencode/plugin"')
    expect(bundle?.contents).not.toContain("@srobroek/opencode-lib")
    expect(bundle?.contents).toContain("function parsedInvocations(")
  })

  test("writes a root shim for each export", async () => {
    const outputs = await buildPlugin(example)
    const shim = outputs.find((output) => output.file === path.join(example, "index.js"))
    expect(shim?.contents).toContain('export { default } from "./dist/index.js"')
  })

  test("compiles TSX with the OpenTUI Solid transform and keeps the TUI runtime external", async () => {
    const outputs = await buildPlugin(statusline)
    const bundle = outputs.find((output) => output.file === path.join(statusline, "dist/tui.js"))
    expect(bundle?.contents).toContain('from "@opentui/solid"')
    expect(bundle?.contents).toContain("createElement")
    expect(bundle?.contents).toContain('from "solid-js"')
    expect(bundle?.contents).not.toContain("react")
    const shim = outputs.find((output) => output.file === path.join(statusline, "tui.js"))
    expect(shim?.contents).toContain('export { default } from "./dist/tui.js"')
  })

  test("skips packages without dist exports", async () => {
    expect(await buildPlugin(path.resolve(import.meta.dir, "../plugins/lib"))).toEqual([])
  })
})
