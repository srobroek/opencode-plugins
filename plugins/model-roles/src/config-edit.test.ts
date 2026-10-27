import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { parse } from "jsonc-parser"
import { findPluginEntry, globalConfigDir, pickConfigFile, readTiers, setTier, writeTier } from "./config-edit.ts"

const SPEC = "github:srobroek/opencode-plugins#main::path:plugins/model-roles"

describe("globalConfigDir", () => {
  test("OPENCODE_CONFIG_DIR, then XDG_CONFIG_HOME, then ~/.config", () => {
    expect(globalConfigDir({ OPENCODE_CONFIG_DIR: "/c" }, "/h")).toBe("/c")
    expect(globalConfigDir({ XDG_CONFIG_HOME: "/x" }, "/h")).toBe("/x/opencode")
    expect(globalConfigDir({ XDG_CONFIG_HOME: "" }, "/h")).toBe("/h/.config/opencode")
  })
})

describe("findPluginEntry", () => {
  test("finds a bare or object entry by spec, and nothing else", () => {
    expect(findPluginEntry(`{ "plugins": ["a", "${SPEC}"] }`)).toEqual({ index: 1, spec: SPEC, bare: true })
    expect(findPluginEntry(`{ "plugins": [{ "package": "@srobroek/opencode-model-roles" }] }`)?.bare).toBe(false)
    expect(findPluginEntry(`{ "plugins": ["/x/plugins/model-roles"] }`)?.index).toBe(0)
    expect(findPluginEntry(`{ "plugins": ["other"] }`)).toBeUndefined()
    expect(findPluginEntry(`{}`)).toBeUndefined()
    expect(findPluginEntry(`not json`)).toBeUndefined()
  })
})

describe("setTier", () => {
  test("a bare string entry becomes the object form", () => {
    const text = `{\n  "plugins": ["other", "${SPEC}"]\n}\n`
    const next = setTier(text, "strong", { model: ["a/b#high"], effort: "high" }) as string
    expect(parse(next)).toEqual({
      plugins: ["other", { package: SPEC, options: { tiers: { strong: { model: ["a/b#high"], effort: "high" } } } }],
    })
    expect(readTiers(next)).toEqual({ strong: { model: ["a/b#high"], effort: "high" } })
    expect(setTier(text, "strong", undefined)).toBe(text)
  })

  test("existing options and other tiers are kept; a tier is replaced or removed", () => {
    const text = `{\n  "plugins": [\n    {\n      "package": "${SPEC}",\n      "options": { "guard": true, "tiers": { "cheap": { "effort": "low" }, "docs": { "purpose": "docs" } } }\n    }\n  ]\n}\n`
    const replaced = setTier(text, "docs", { model: "auto", purpose: "writing docs" }) as string
    expect(parse(replaced).plugins[0].options).toEqual({
      guard: true,
      tiers: { cheap: { effort: "low" }, docs: { model: "auto", purpose: "writing docs" } },
    })
    const removed = setTier(replaced, "cheap", undefined) as string
    expect(parse(removed).plugins[0].options).toEqual({ guard: true, tiers: { docs: { model: "auto", purpose: "writing docs" } } })
  })

  test("options and tiers are created when missing", () => {
    const text = `{ "plugins": [{ "package": "${SPEC}" }] }`
    expect(parse(setTier(text, "cheap", { effort: "none" }) as string).plugins[0]).toEqual({
      package: SPEC,
      options: { tiers: { cheap: { effort: "none" } } },
    })
  })

  test("comments, trailing commas and unrelated formatting survive", () => {
    const text = [
      "// my config",
      "{",
      '  "model": "a/b", // default model',
      "  /* plugins below */",
      '  "plugins": [',
      `    { "package": "${SPEC}", "options": { "tiers": {}, }, }, // model-roles`,
      "  ],",
      "}",
      "",
    ].join("\n")
    const next = setTier(text, "reviewer", { distinctVendor: false }) as string
    expect(next).toContain("// my config")
    expect(next).toContain('"model": "a/b", // default model')
    expect(next).toContain("/* plugins below */")
    expect(next).toContain("// model-roles")
    expect(readTiers(next)).toEqual({ reviewer: { distinctVendor: false } })
  })

  test("no model-roles entry, no edit", () => {
    expect(setTier(`{ "plugins": [] }`, "cheap", {})).toBeUndefined()
  })
})

describe("pickConfigFile and writeTier", () => {
  test("opencode.jsonc wins over opencode.json when both have the entry; else the one that has it", () => {
    const json = { path: "/d/opencode.json", text: `{ "plugins": ["${SPEC}"] }` }
    const jsonc = { path: "/d/opencode.jsonc", text: `{ "plugins": ["${SPEC}"] }` }
    expect(pickConfigFile([json, jsonc])?.path).toBe("/d/opencode.jsonc")
    expect(pickConfigFile([json, { ...jsonc, text: "{}" }])?.path).toBe("/d/opencode.json")
    expect(pickConfigFile([{ ...json, text: "{}" }])).toBeUndefined()
  })

  test("writes the jsonc file in place", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "model-roles-config-"))
    try {
      const file = path.join(dir, "opencode.jsonc")
      writeFileSync(file, `{\n  // keep me\n  "plugins": ["${SPEC}"]\n}\n`)
      const result = writeTier(dir, "cheap", { effort: "none" })
      expect(result).toEqual({ path: file, tiers: { cheap: { effort: "none" } } })
      const written = readFileSync(file, "utf8")
      expect(written).toContain("// keep me")
      expect(written.endsWith("\n")).toBe(true)
      expect(() => writeTier(path.join(dir, "missing"), "cheap", {})).toThrow(/No model-roles plugin entry/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
