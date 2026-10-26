import { describe, expect, test } from "bun:test"
import { diagnosticKey, errorLines, formatReport, newErrors, toolText, touchedFiles, within } from "./diagnostics.ts"

const cwd = "/repo"
const E1 = "error[typescript] (2322) at 3:6: Type 'string' is not assignable to type 'number'."
const E2 = "error[typescript] (2304) at 9:1: Cannot find name 'foo'."

describe("touchedFiles", () => {
  test("edit and write name one file, resolved against cwd", () => {
    expect(touchedFiles("edit", { path: "src/a.ts", oldString: "a", newString: "b" }, cwd)).toEqual(["/repo/src/a.ts"])
    expect(touchedFiles("write", { path: "/abs/b.ts", content: "" }, cwd)).toEqual(["/abs/b.ts"])
  })

  test("patch keeps adds, updates and move targets; drops deletes and move sources", () => {
    const patchText = [
      "*** Begin Patch",
      "*** Add File: new.ts",
      "+x",
      "*** Update File: kept.ts",
      "@@",
      "*** Update File: old.ts",
      "*** Move to: moved.ts",
      "*** Delete File: gone.ts",
      "*** End Patch",
    ].join("\n")
    expect(touchedFiles("patch", { patchText }, cwd)).toEqual(["/repo/new.ts", "/repo/kept.ts", "/repo/moved.ts"])
  })

  test("shell, read and malformed input touch nothing", () => {
    expect(touchedFiles("shell", { command: "echo > a.ts" }, cwd)).toEqual([])
    expect(touchedFiles("read", { path: "a.ts" }, cwd)).toEqual([])
    expect(touchedFiles("patch", {}, cwd)).toEqual([])
    expect(touchedFiles("edit", null, cwd)).toEqual([])
  })
})

describe("errorLines", () => {
  test("keeps lsp-tools-mcp error lines only", () => {
    const text = [
      "Found 300 diagnostics (showing first 200):",
      E1,
      "warning[typescript] (6133) at 1:7: 'x' is declared but its value is never read.",
      "error at 2:0: no source or code",
      "No diagnostics found",
    ].join("\n")
    expect(errorLines(text)).toEqual([E1, "error at 2:0: no source or code"])
    expect(errorLines("No diagnostics found")).toEqual([])
    expect(errorLines("error: No LSP server configured")).toEqual([])
  })
})

describe("newErrors", () => {
  test("without a baseline every error is new", () => {
    expect(newErrors(undefined, [E1, E2])).toEqual([E1, E2])
  })

  test("known errors that only moved are not new", () => {
    const moved = E1.replace("at 3:6", "at 4:6")
    expect(diagnosticKey(moved)).toBe(diagnosticKey(E1))
    expect(newErrors([E1], [moved, E2])).toEqual([E2])
  })

  test("counts duplicates as a multiset", () => {
    expect(newErrors([E1], [E1, E1.replace("3:6", "7:2")])).toEqual([E1.replace("3:6", "7:2")])
  })
})

describe("formatReport", () => {
  test("empty without new errors", () => {
    expect(formatReport([{ path: "/repo/a.ts", errors: [] }], cwd, 20)).toBe("")
  })

  test("groups by file relative to cwd and caps lines", () => {
    const many = Array.from({ length: 5 }, (_, i) => `error at ${i + 1}:0: e${i}`)
    const text = formatReport(
      [
        { path: "/repo/src/a.ts", errors: [E1] },
        { path: "/elsewhere/b.ts", errors: many },
      ],
      cwd,
      3,
    )
    expect(text).toBe(
      [
        "LSP: 6 new errors after this edit",
        "src/a.ts",
        `  ${E1}`,
        "/elsewhere/b.ts",
        "  error at 1:0: e0",
        "  error at 2:0: e1",
        "  ... and 3 more",
      ].join("\n"),
    )
  })

  test("singular header", () => {
    expect(formatReport([{ path: "/repo/a.ts", errors: [E1] }], cwd, 20).split("\n")[0]).toBe(
      "LSP: 1 new error after this edit",
    )
  })
})

describe("toolText", () => {
  test("reads string content, text parts and string output", () => {
    expect(toolText({ content: "x" })).toBe("x")
    expect(toolText({ content: [{ type: "text", text: "a" }, { type: "file" }, { type: "text", text: "b" }] })).toBe(
      "a\nb",
    )
    expect(toolText({ output: "o" })).toBe("o")
    expect(toolText(undefined)).toBe("")
  })
})

describe("within", () => {
  test("returns the value in time", async () => {
    expect(await within(1000, new AbortController(), Promise.resolve(3))).toBe(3)
  })

  test("times out to undefined and aborts", async () => {
    const controller = new AbortController()
    expect(await within(10, controller, new Promise(() => {}))).toBeUndefined()
    expect(controller.signal.aborted).toBe(true)
  })

  test("a rejection is undefined", async () => {
    expect(await within(1000, new AbortController(), Promise.reject(new Error("x")))).toBeUndefined()
  })
})
