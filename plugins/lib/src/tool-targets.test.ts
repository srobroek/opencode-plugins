import { describe, expect, test } from "bun:test"
import { homedir } from "node:os"

import {
  isShellTool,
  patchPaths,
  patchTargets,
  READ_TOOLS,
  readTargets,
  SHELL_ALIASES,
  shellAliasInput,
  shellCall,
  shellCommand,
  WRITE_TOOLS,
  writeTargets,
  writtenPaths,
} from "./tool-targets.ts"

const PATCH = [
  "*** Begin Patch",
  "*** Update File: a.ts",
  "*** Move to: b.ts",
  "@@",
  "-x",
  "+*** Add File: body.ts",
  "*** Add File: 'c d.ts'",
  "+z",
  "*** Delete File: e.ts\r",
  "*** End Patch",
].join("\n")

describe("patchTargets", () => {
  test("reads add, update, delete and move headers in order", () => {
    expect(patchTargets(PATCH)).toEqual([
      { operation: "update", path: "a.ts" },
      { operation: "move", path: "b.ts" },
      { operation: "add", path: "c d.ts" },
      { operation: "delete", path: "e.ts" },
    ])
  })

  test("ignores a header quoted in a body row and an empty one", () => {
    expect(patchTargets("*** Begin Patch\n+*** Update File: x.ts\n*** Add File: ''\n*** End Patch")).toEqual([])
  })

  test("patchPaths lists each path once", () => {
    expect(patchPaths("*** Update File: a.ts\n*** Move to: a.ts")).toEqual(["a.ts"])
  })
})

describe("writeTargets", () => {
  test("reads edit, write and patch inputs", () => {
    expect(writeTargets("edit", { path: "a.ts", oldString: "x", newString: "y" })).toEqual(["a.ts"])
    expect(writeTargets("write", { path: "b.ts", content: "" })).toEqual(["b.ts"])
    expect(writeTargets("patch", { patchText: PATCH })).toEqual(["a.ts", "b.ts", "c d.ts", "e.ts"])
  })

  test("returns nothing for other tools and malformed input", () => {
    expect(writeTargets("read", { path: "a.ts" })).toEqual([])
    expect(writeTargets("edit", { path: "" })).toEqual([])
    expect(writeTargets("edit", null)).toEqual([])
    expect(writeTargets("patch", { patchText: 1 })).toEqual([])
  })

  test("WRITE_TOOLS names the built-in write tools", () => {
    expect([...WRITE_TOOLS].sort()).toEqual(["edit", "patch", "write"])
  })
})

describe("readTargets", () => {
  test("reads the read tool's path", () => {
    expect(readTargets("read", { path: "a.ts" })).toEqual(["a.ts"])
    expect(readTargets("write", { path: "a.ts" })).toEqual([])
    expect([...READ_TOOLS]).toEqual(["read"])
  })
})

describe("shellCall", () => {
  test("reads command, workdir, timeout and background", () => {
    expect(shellCall("shell", { command: "ls", workdir: "/tmp", timeout: 5, background: true })).toEqual({
      command: "ls",
      workdir: "/tmp",
      timeout: 5,
      background: true,
    })
    expect(shellCall("shell", { command: "ls", workdir: "", timeout: "5" })).toEqual({ command: "ls" })
  })

  test("returns undefined for other tools or a missing command", () => {
    expect(shellCall("read", { command: "ls" })).toBeUndefined()
    expect(shellCall("shell", {})).toBeUndefined()
    expect(shellCall("bash", {})).toBeUndefined()
    expect(shellCommand("shell", { command: "ls" })).toBe("ls")
    expect(shellCommand("read", { command: "ls" })).toBeUndefined()
  })

  test("reads a shell-alias call as the shell call it routes to", () => {
    expect(shellCall("bash", { command: "ls", cwd: "/tmp", run_in_background: true, description: "x" })).toEqual({
      command: "ls",
      workdir: "/tmp",
      background: true,
    })
    expect(shellCommand("Bash", { cmd: ["bash", "-lc", "git push"] })).toBe("git push")
  })
})

describe("shell aliases", () => {
  test("isShellTool accepts shell and its aliases only", () => {
    expect(isShellTool("shell")).toBe(true)
    expect(isShellTool("bash")).toBe(true)
    expect(isShellTool("Bash")).toBe(true)
    expect(isShellTool("read")).toBe(false)
    expect([...SHELL_ALIASES].sort()).toEqual(["Bash", "bash"])
  })

  test("shellAliasInput maps Claude Code and Codex spellings to shell's input", () => {
    expect(
      shellAliasInput({ command: "make", description: "build", timeout: 60000, run_in_background: false }),
    ).toEqual({ command: "make", timeout: 60000, background: false })
    expect(shellAliasInput({ cmd: "ls", working_directory: "/w", timeout_ms: "500", background: "true" })).toEqual({
      command: "ls",
      workdir: "/w",
      timeout: 500,
      background: true,
    })
    expect(shellAliasInput({ command: "ls", workdir: "/a", cwd: "/b", timeout: -1 })).toEqual({
      command: "ls",
      workdir: "/a",
    })
  })

  test("shellAliasInput joins an argv array, unwrapping a shell -c script", () => {
    expect(shellAliasInput({ command: ["sh", "-c", "echo hi | wc"] })).toEqual({ command: "echo hi | wc" })
    expect(shellAliasInput({ command: ["/bin/zsh", "-lc", "ls"] })).toEqual({ command: "ls" })
    expect(shellAliasInput({ command: ["git", "commit", "-m", "it's done"] })).toEqual({
      command: "git commit -m 'it'\\''s done'",
    })
  })

  test("shellAliasInput parses a JSON string and leaves input without a command alone", () => {
    expect(shellAliasInput('{"command":"pwd"}')).toEqual({ command: "pwd" })
    expect(shellAliasInput("not json")).toBe("not json")
    const input = { description: "no command" }
    expect(shellAliasInput(input)).toBe(input)
    expect(shellAliasInput({ command: [1, 2] })).toEqual({ command: [1, 2] })
  })
})

describe("writtenPaths", () => {
  test("resolves file tool targets against cwd", () => {
    expect(writtenPaths("edit", { path: "src/../a.ts" }, "/repo")).toEqual(["/repo/a.ts"])
    expect(writtenPaths("write", { path: "~/x" }, "/repo")).toEqual([`${homedir()}/x`])
    expect(writtenPaths("patch", { patchText: "*** Add File: /abs/f\n*** Update File: g" }, "/repo")).toEqual([
      "/abs/f",
      "/repo/g",
    ])
  })

  test("resolves shell write targets against workdir", () => {
    expect(writtenPaths("shell", { command: "echo x > out", workdir: "sub" }, "/repo")).toEqual(["/repo/sub/out"])
    expect(writtenPaths("shell", { command: "echo x | tee a b" }, "/repo")).toEqual(["/repo/a", "/repo/b"])
    expect(writtenPaths("read", { path: "a" }, "/repo")).toEqual([])
  })
})
