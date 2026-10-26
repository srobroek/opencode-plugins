import { describe, expect, test } from "bun:test"

import { appendResultText, resultText, shellExit, shellOutput } from "./shell-result.ts"

describe("shellExit", () => {
  test("reads output.exit, then metadata.exit", () => {
    expect(shellExit({ output: { exit: 2, output: "" }, metadata: { exit: 2 } })).toBe(2)
    expect(shellExit({ output: { exit: 0 } })).toBe(0)
    expect(shellExit({ metadata: { exit: 1 } })).toBe(1)
  })

  test("returns undefined without a numeric exit", () => {
    expect(shellExit({ output: { exit: "1" } })).toBeUndefined()
    expect(shellExit({ content: "x" })).toBeUndefined()
    expect(shellExit(undefined)).toBeUndefined()
  })
})

describe("shellOutput", () => {
  test("reads the merged output", () => {
    expect(shellOutput({ output: { exit: 0, output: "out\nerr\n" } })).toBe("out\nerr\n")
    expect(shellOutput({ output: "plain" })).toBeUndefined()
    expect(shellOutput(undefined)).toBeUndefined()
  })
})

describe("resultText", () => {
  test("reads string content or joins text parts", () => {
    expect(resultText({ content: "a" })).toBe("a")
    expect(
      resultText({
        content: [
          { type: "text", text: "a" },
          { type: "file", uri: "file:///x", mime: "text/plain" },
          { type: "text", text: "b" },
        ],
      }),
    ).toBe("a\nb")
    expect(resultText({})).toBe("")
  })
})

describe("appendResultText", () => {
  test("appends to string content on a new line", () => {
    expect(appendResultText({ content: "a" }, "b").content).toBe("a\nb")
    expect(appendResultText({ content: "a\n" }, "b").content).toBe("a\nb")
    expect(appendResultText({ content: "" }, "b").content).toBe("b")
  })

  test("adds a text part to array content", () => {
    expect(appendResultText({ content: [{ type: "text", text: "a" }] }, "b").content).toEqual([
      { type: "text", text: "a" },
      { type: "text", text: "b" },
    ])
  })

  test("starts from the shell output when there is no content", () => {
    expect(appendResultText({ output: { exit: 1, output: "boom" } }, "hint").content).toBe("boom\nhint")
    expect(appendResultText({}, "hint").content).toBe("hint")
  })

  test("leaves the original result and its other fields alone", () => {
    const result = { content: "a", output: { exit: 0 }, metadata: { exit: 0 } }
    const next = appendResultText(result, "b")
    expect(result.content).toBe("a")
    expect(next.output).toBe(result.output)
    expect(next.metadata).toBe(result.metadata)
  })
})
