import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readProviderTypes } from "./fnox-config.ts"

const base = join(realpathSync(tmpdir()), "opencode")
let root: string
let n = 0

beforeAll(() => {
  mkdirSync(base, { recursive: true })
  root = mkdtempSync(join(base, "fnox-config-"))
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

/** A fresh tree with a home directory and a project directory; `files` maps relative paths to TOML. */
function tree(files: Record<string, string>): { home: string; cwd: string } {
  const dir = join(root, String(n++))
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
  mkdirSync(join(dir, "home"), { recursive: true })
  mkdirSync(join(dir, "proj/sub"), { recursive: true })
  return { home: join(dir, "home"), cwd: join(dir, "proj/sub") }
}

const provider = (name: string, type: string) => `[providers.${name}]\ntype = "${type}"\n`

describe("readProviderTypes", () => {
  test("reads a provider's type from fnox.toml in the directory", () => {
    const { home, cwd } = tree({ "proj/sub/fnox.toml": provider("host", "1password") })
    expect(readProviderTypes(cwd, home)("host")).toBe("1password")
  })

  test("finds the config in a parent directory", () => {
    const { home, cwd } = tree({ "proj/fnox.toml": provider("keys", "age") })
    expect(readProviderTypes(cwd, home)("keys")).toBe("age")
  })

  test("reads the global config", () => {
    const { home, cwd } = tree({ "home/.config/fnox/config.toml": provider("op", "1password") })
    expect(readProviderTypes(cwd, home)("op")).toBe("1password")
  })

  test("reads .fnox.toml, fnox.local.toml and profile files", () => {
    const { home, cwd } = tree({
      "proj/sub/.fnox.toml": provider("a", "age"),
      "proj/sub/fnox.local.toml": provider("b", "keychain"),
      "proj/sub/fnox.staging.toml": provider("c", "1password"),
    })
    const types = readProviderTypes(cwd, home)
    expect([types("a"), types("b"), types("c")]).toEqual(["age", "keychain", "1password"])
  })

  test("reads providers declared under a profile", () => {
    const { home, cwd } = tree({ "proj/fnox.toml": '[profiles.prod.providers.vault]\ntype = "1password"\n' })
    expect(readProviderTypes(cwd, home)("vault")).toBe("1password")
  })

  test("a provider with no definition is unknown", () => {
    const { home, cwd } = tree({ "proj/fnox.toml": provider("a", "age") })
    expect(readProviderTypes(cwd, home)("missing")).toBeUndefined()
  })

  test("definitions that disagree resolve to unknown", () => {
    const { home, cwd } = tree({
      "proj/fnox.toml": provider("host", "age"),
      "proj/sub/fnox.local.toml": provider("host", "1password"),
    })
    expect(readProviderTypes(cwd, home)("host")).toBeUndefined()
  })

  test("a config that does not parse resolves everything to unknown", () => {
    const { home, cwd } = tree({ "proj/fnox.toml": provider("a", "age"), "proj/sub/fnox.toml": "[providers\n" })
    expect(readProviderTypes(cwd, home)("a")).toBeUndefined()
  })

  test("stops climbing at a config that sets root = true", () => {
    const { home, cwd } = tree({
      "proj/fnox.toml": provider("above", "age"),
      "proj/sub/fnox.toml": `root = true\n${provider("below", "keychain")}`,
    })
    const types = readProviderTypes(cwd, home)
    expect([types("above"), types("below")]).toEqual([undefined, "keychain"])
  })
})
