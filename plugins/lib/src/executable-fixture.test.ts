import { afterAll, describe, expect, test } from "bun:test"
import { lstatSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TRAMPOLINE, writeExecutable } from "./executable-fixture.ts"

const root = mkdtempSync(join(tmpdir(), "executable-fixture-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const run = (path: string, ...args: string[]) => {
  const result = Bun.spawnSync([path, ...args], { stdout: "pipe", stderr: "pipe" })
  return { exitCode: result.exitCode, stdout: result.stdout.toString(), pid: result.pid }
}

describe("writeExecutable", () => {
  test("runs the script as its own process, with its own path, arguments and exit status", () => {
    const path = join(root, "stub")
    writeExecutable(path, '#!/bin/sh\nprintf "%s|%s|%s\\n" "$0" "$*" "$$"\nexit 3\n')
    const result = run(path, "one", "two")
    expect(result.exitCode).toBe(3)
    expect(result.stdout).toBe(`${path}|one two|${result.pid}\n`)
  })

  test("is a symlink to the trampoline and replaces whatever was at the path", () => {
    const path = join(root, "replaced")
    writeFileSync(path, "old")
    writeExecutable(path, "exit 0\n")
    expect(lstatSync(path).isSymbolicLink()).toBe(true)
    expect(readlinkSync(path)).toBe(TRAMPOLINE)
    writeExecutable(path, "exit 4\n")
    expect(run(path).exitCode).toBe(4)
  })

  test("refuses a script for another interpreter", () => {
    expect(() => writeExecutable(join(root, "node"), "#!/usr/bin/env node\n")).toThrow("/bin/sh script")
  })
})
