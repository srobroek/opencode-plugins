import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { providerSetting, providersOfType, readProviderTypes } from "./fnox-config.ts"
import { VALUE_STORE_TYPES } from "./op-guard.ts"

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

  test("definitions that disagree resolve to the non-store type", () => {
    const { home, cwd } = tree({
      "proj/fnox.toml": provider("host", "age"),
      "proj/sub/fnox.local.toml": provider("host", "1password"),
    })
    expect(readProviderTypes(cwd, home)("host")).toBe("1password")
  })

  test("a config that does not parse resolves everything to unknown", () => {
    const { home, cwd } = tree({ "proj/fnox.toml": provider("a", "age"), "proj/sub/fnox.toml": "[providers\n" })
    expect(readProviderTypes(cwd, home)("a")).toBeUndefined()
  })

  test("reads configs above a root = true file, which does not end the search", () => {
    const { home, cwd } = tree({
      "proj/fnox.toml": provider("host", "1password"),
      "proj/sub/fnox.toml": `root = true\n${provider("host", "age")}`,
    })
    expect(readProviderTypes(cwd, home)("host")).not.toBe("age")
  })

  test("reads the whole path to the filesystem root", () => {
    const { home, cwd } = tree({ "fnox.toml": provider("host", "1password"), "proj/sub/fnox.toml": provider("host", "age") })
    expect(readProviderTypes(cwd, home)("host")).toBe("1password")
  })

  test("a non-store definition in any profile makes the provider not a store", () => {
    const { home, cwd } = tree({
      "proj/fnox.toml": provider("host", "age"),
      "proj/sub/fnox.prod.toml": provider("host", "1password"),
    })
    expect(readProviderTypes(cwd, home)("host")).toBe("1password")
  })

  test("a provider defined as two store types is still a store", () => {
    const { home, cwd } = tree({
      "proj/fnox.toml": provider("host", "age"),
      "proj/sub/fnox.local.toml": provider("host", "keychain"),
    })
    expect(VALUE_STORE_TYPES.has(readProviderTypes(cwd, home)("host") ?? "")).toBe(true)
  })

  test("a config with an import resolves everything to unknown", () => {
    const { home, cwd } = tree({ "proj/sub/fnox.toml": `import = ["other.toml"]\n${provider("a", "age")}` })
    expect(readProviderTypes(cwd, home)("a")).toBeUndefined()
  })

  test("a definition without a type is not a store", () => {
    const { home, cwd } = tree({ "proj/fnox.toml": '[providers.a]\nvault = "x"\n' })
    expect(readProviderTypes(cwd, home)("a")).toBeUndefined()
  })

  describe("an explicit config file", () => {
    test("reads that file and the global config only", () => {
      const { home, cwd } = tree({
        "proj/sub/other.toml": provider("host", "age"),
        "proj/fnox.toml": provider("host", "1password"),
        "home/.config/fnox/config.toml": provider("g", "keychain"),
      })
      const types = readProviderTypes(cwd, home)
      expect([types("host", "other.toml"), types("g", "other.toml")]).toEqual(["age", "keychain"])
    })

    test("a global definition of the same name must also be a store", () => {
      const { home, cwd } = tree({
        "proj/sub/other.toml": provider("host", "age"),
        "home/.config/fnox/config.toml": provider("host", "1password"),
      })
      expect(readProviderTypes(cwd, home)("host", "other.toml")).toBe("1password")
    })

    test("a missing file resolves to unknown", () => {
      const { home, cwd } = tree({})
      expect(readProviderTypes(cwd, home)("host", "nope.toml")).toBeUndefined()
    })

    test("an unparsable file or one with an import resolves to unknown", () => {
      const { home, cwd } = tree({ "proj/sub/bad.toml": "[providers\n", "proj/sub/imp.toml": `import = ["x"]\n${provider("host", "age")}` })
      const types = readProviderTypes(cwd, home)
      expect([types("host", "bad.toml"), types("host", "imp.toml")]).toEqual([undefined, undefined])
    })

    test("an absolute path is read as given", () => {
      const { home, cwd } = tree({ "elsewhere/c.toml": provider("host", "age") })
      expect(readProviderTypes(cwd, home)("host", join(cwd, "../../elsewhere/c.toml"))).toBe("age")
    })
  })
})

describe("providersOfType", () => {
  test("lists the providers every definition of which has the type, across the path and the global config", () => {
    const { home, cwd } = tree({
      "proj/fnox.toml": provider("proj", "1password") + provider("keys", "age"),
      "home/.config/fnox/config.toml": provider("shared", "1password"),
    })
    expect(providersOfType("1password", cwd, undefined, home)?.sort()).toEqual(["proj", "shared"])
  })

  test("leaves out a provider whose definitions disagree", () => {
    const { home, cwd } = tree({
      "proj/fnox.toml": provider("op", "1password"),
      "proj/sub/fnox.local.toml": provider("op", "age"),
    })
    expect(providersOfType("1password", cwd, undefined, home)).toEqual([])
  })

  test("reads an explicit config with the global config only", () => {
    const { home, cwd } = tree({ "proj/sub/other.toml": provider("a", "1password"), "proj/fnox.toml": provider("b", "1password") })
    expect(providersOfType("1password", cwd, "other.toml", home)).toEqual(["a"])
  })

  test("is unknown when a config does not parse or has an import", () => {
    const { home, cwd } = tree({ "proj/sub/fnox.toml": "[providers\n", "proj/sub/imp.toml": `import = ["x"]\n` })
    expect([providersOfType("1password", cwd, undefined, home), providersOfType("1password", cwd, "imp.toml", home)]).toEqual([
      undefined,
      undefined,
    ])
  })
})

describe("providerSetting", () => {
  test("gives a setting every definition agrees on, and nothing when one differs or lacks it", () => {
    const { home, cwd } = tree({
      "proj/fnox.toml": '[providers.a]\ntype = "1password"\nvault = "dev"\n[providers.b]\ntype = "1password"\nvault = "x"\n[providers.c]\ntype = "1password"\n',
      "proj/sub/fnox.local.toml": '[providers.a]\ntype = "1password"\nvault = "dev"\n[providers.b]\ntype = "1password"\nvault = "y"\n',
    })
    expect(["a", "b", "c"].map((name) => providerSetting(name, "vault", cwd, undefined, home))).toEqual(["dev", undefined, undefined])
  })
})
