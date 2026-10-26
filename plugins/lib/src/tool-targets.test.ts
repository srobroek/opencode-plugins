import { describe, expect, test } from "bun:test"
import { homedir } from "node:os"

import {
  patchPaths,
  patchTargets,
  READ_TOOLS,
  readTargets,
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
    expect(shellCall("bash", { command: "ls" })).toBeUndefined()
    expect(shellCall("shell", {})).toBeUndefined()
    expect(shellCommand("shell", { command: "ls" })).toBe("ls")
    expect(shellCommand("read", { command: "ls" })).toBeUndefined()
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
