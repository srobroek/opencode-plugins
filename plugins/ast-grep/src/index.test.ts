import { beforeEach, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { createFakeContext } from "@srobroek/opencode-lib/testing"
import { astGrepAvailable, createPlugin, onPath, resetWarning } from "./index.ts"

beforeEach(() => resetWarning())

function setup(available: boolean) {
  const warnings: string[] = []
  const plugin = createPlugin({ available: () => available, warn: (text) => warnings.push(text) })
  const fake = createFakeContext({})
  return { fake, warnings, run: () => plugin.setup(fake.context) }
}

test("registers the skill and no MCP server, and removes the skill on cleanup", async () => {
  const { fake, warnings, run } = setup(true)
  const cleanup = await run()
  expect([...fake.skills.keys()]).toEqual(["ast-grep-search"])
  expect(fake.mcp.size).toBe(0)
  expect(warnings).toEqual([])
  await cleanup?.()
  expect(fake.active()).toBe(0)
})

test("without ast-grep it keeps the skill and warns once", async () => {
  const first = setup(false)
  await first.run()
  expect([...first.fake.skills.keys()]).toEqual(["ast-grep-search"])
  expect(first.warnings).toHaveLength(1)
  expect(first.warnings[0]).toContain("ast-grep is not on PATH")
  const second = setup(false)
  await second.run()
  expect(second.warnings).toEqual([])
})

test("ships no .mcp.json", () => {
  expect(existsSync(new URL("../.mcp.json", import.meta.url))).toBe(false)
})

test("onPath looks in each PATH directory, with PATHEXT on Windows", () => {
  const seen: string[] = []
  const executable = (path: string) => {
    seen.push(path)
    return path === "/b/ast-grep" || path === "C:\\x/ast-grep.EXE"
  }
  expect(onPath("ast-grep", { PATH: "/a:/b" }, executable, "darwin")).toBe(true)
  expect(seen).toEqual(["/a/ast-grep", "/b/ast-grep"])
  expect(onPath("ast-grep", { PATH: "/a::" }, executable, "linux")).toBe(false)
  expect(onPath("ast-grep", {}, executable, "linux")).toBe(false)
})

test("astGrepAvailable accepts ast-grep or AST_GREP_PATH, not sg alone", () => {
  const has = (names: string[]) => (path: string) => names.some((name) => path.endsWith(`/${name}`))
  expect(astGrepAvailable({ PATH: "/bin" }, has(["ast-grep"]), "linux")).toBe(true)
  expect(astGrepAvailable({ PATH: "/bin" }, has(["sg"]), "linux")).toBe(false)
  expect(astGrepAvailable({ PATH: "/bin", AST_GREP_PATH: "sg" }, has([]), "linux")).toBe(true)
  expect(astGrepAvailable({ PATH: "/bin", AST_GREP_PATH: " " }, has([]), "linux")).toBe(false)
})
