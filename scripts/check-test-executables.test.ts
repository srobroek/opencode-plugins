import { describe, expect, test } from "bun:test"
import { checkTree, directExecutables } from "./check-test-executables.ts"

describe("directExecutables", () => {
  test.each([
    ["writeFileSync with 0o755", `writeFileSync(join(bin, "bd"), FAKE_BD, { mode: 0o755 })`],
    ["writeFileSync with 0o700", "writeFileSync(hook, `#!/bin/sh\\ntouch x\\n`, { mode: 0o700 })"],
    ["writeFileSync over several lines", `writeFileSync(\n  path,\n  body,\n  { mode: 0o755 },\n)`],
  ])("finds %s", (_, text) => {
    expect(directExecutables(text)).toEqual([{ line: 1, kind: "write" }])
  })

  test.each([
    ["a plain writeFileSync", `writeFileSync(path, "x")`],
    ["a non-executable mode", `writeFileSync(path, "x", { mode: 0o644 })`],
    ["mkdirSync with an executable mode", `mkdirSync(dir, { recursive: true, mode: 0o700 })`],
    ["writeExecutable", `writeExecutable(join(bin, "bd"), FAKE_BD)`],
  ])("ignores %s", (_, text) => {
    expect(directExecutables(text)).toEqual([])
  })

  test("finds chmodSync to an executable mode, and skips a non-executable one", () => {
    const text = `chmodSync(join(bin, "git"), 0o755)\nchmodSync(target, 0o644)\nchmodSync(dir, 0o555)`
    expect(directExecutables(text)).toEqual([
      { line: 1, kind: "chmod" },
      { line: 3, kind: "chmod" },
    ])
  })

  test("an exemption comment on the line skips it", () => {
    const text = `chmodSync(holds, 0o555) // check-test-executables: a directory, not a script`
    expect(directExecutables(text)).toEqual([])
  })

  test("the reported line is the line the call starts on", () => {
    expect(directExecutables(`const a = 1\n\nwriteFileSync(p, b, { mode: 0o755 })`)).toEqual([{ line: 3, kind: "write" }])
  })
})

describe("checkTree", () => {
  const files = (entries: Record<string, string>) => new Map(Object.entries(entries))

  test("a writeFileSync with an executable mode always fails", () => {
    const findings = checkTree(files({ "a.test.ts": `writeFileSync(p, b, { mode: 0o755 })` }))
    expect(findings).toEqual([
      { file: "a.test.ts", line: 1, reason: "writes an executable directly; use writeExecutable from @srobroek/opencode-lib/executable-fixture" },
    ])
  })

  test("a chmodSync to an executable mode fails, and an exempt one passes", () => {
    const text = `chmodSync(a, 0o755)\nchmodSync(dir, 0o555) // check-test-executables: a directory`
    expect(checkTree(files({ "a.test.ts": text }))).toEqual([
      {
        file: "a.test.ts",
        line: 1,
        reason:
          "chmodSync to an executable mode; use writeExecutable for a script, or mark a non-script with `// check-test-executables: <reason>`",
      },
    ])
  })
})
