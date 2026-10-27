import { beforeEach, expect, test } from "bun:test"
import { createFakeContext } from "@srobroek/opencode-lib/testing"
import { astGrepAvailable, createPlugin, onPath, resetWarning } from "./index.ts"

const PIN = "git+https://github.com/ast-grep/ast-grep-mcp@149e20d47bb7125fb0c1451feea2f48a98742034"

beforeEach(() => resetWarning())

function setup(available: boolean, options: Record<string, unknown> = {}, mcp: Record<string, unknown> = {}) {
  const warnings: string[] = []
  const plugin = createPlugin({ available: () => available, warn: (text) => warnings.push(text) })
  const fake = createFakeContext({ options, mcp: mcp as never })
  return { fake, warnings, run: () => plugin.setup(fake.context) }
}

test("adds the pinned server in Code Mode when ast-grep is available, and removes it on cleanup", async () => {
  const { fake, warnings, run } = setup(true)
  const cleanup = await run()
  expect([...fake.skills.keys()]).toEqual(["ast-grep-search"])
  expect(fake.mcp.get("ast-grep")).toEqual({
    type: "local",
    command: ["uvx", "--python", "3.13", "--from", PIN, "ast-grep-server"],
    codemode: true,
    timeout: { startup: 120000 },
  })
  expect(warnings).toEqual([])
  await cleanup?.()
  expect(fake.mcp.size).toBe(0)
  expect(fake.active()).toBe(0)
})

test("skips the server without ast-grep, keeps the skill, and warns once", async () => {
  const first = setup(false)
  await first.run()
  expect(first.fake.mcp.size).toBe(0)
  expect([...first.fake.skills.keys()]).toEqual(["ast-grep-search"])
  expect(first.warnings).toHaveLength(1)
  expect(first.warnings[0]).toContain("ast-grep is not on PATH")
  const second = setup(false)
  await second.run()
  expect(second.warnings).toEqual([])
})

test("mcp always adds the server without the binary; off adds nothing and does not warn", async () => {
  const always = setup(false, { mcp: "always" })
  await always.run()
  expect([...always.fake.mcp.keys()]).toEqual(["ast-grep"])
  const off = setup(true, { mcp: "off" })
  await off.run()
  expect(off.fake.mcp.size).toBe(0)
  expect(off.warnings).toEqual([])
})

test("a server the user configured under the same name wins", async () => {
  const mine = { type: "local", command: ["ast-grep-server"], codemode: false }
  const { fake, run } = setup(true, {}, { "ast-grep": mine })
  await run()
  expect(fake.mcp.get("ast-grep")).toEqual(mine)
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

test("the shipped server is pinned to a full commit", async () => {
  const text = await Bun.file(new URL("../.mcp.json", import.meta.url)).text()
  expect(text).toMatch(/ast-grep-mcp@[0-9a-f]{40}"/)
})
