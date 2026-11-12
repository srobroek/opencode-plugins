import { describe, expect, test } from "bun:test"
import { END, type Entry, firstSentence, parseEntry, renderBlock, replaceBlock, START } from "./build-plugin-table.ts"

const manifest = (config: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  description: "Does a thing. Then more.",
  "opencode-plugins": config,
  ...extra,
})

describe("parseEntry", () => {
  test("reads a project plugin with signals and requires", () => {
    expect(parseEntry("speckit", manifest({ scope: "project", signals: [".specify/"], requires: ["beads"] }))).toEqual({
      name: "speckit",
      description: "Does a thing. Then more.",
      scope: "project",
      signals: [".specify/"],
      requires: ["beads"],
    })
  })

  test("uses the package description, which describes the OpenCode plugin", () => {
    const entry = parseEntry("a", manifest({ scope: "global", description: "Skills only." }))
    expect(entry.description).toBe("Does a thing. Then more.")
  })

  test("falls back to the opencode-plugins description without a package description", () => {
    const entry = parseEntry("a", { "opencode-plugins": { scope: "global", description: "Skills only." } })
    expect(entry.description).toBe("Skills only.")
  })

  test("rejects a plugin without scope", () => {
    expect(() => parseEntry("a", { description: "x" })).toThrow("plugins/a/package.json")
  })

  test("rejects a project plugin without signals", () => {
    expect(() => parseEntry("a", manifest({ scope: "project" }))).toThrow("needs")
  })

  test("rejects signals on a global plugin", () => {
    expect(() => parseEntry("a", manifest({ scope: "global", signals: ["x"] }))).toThrow("project plugins only")
  })

  test("rejects an unknown scope", () => {
    expect(() => parseEntry("a", manifest({ scope: "local" }))).toThrow("scope")
  })
})

describe("firstSentence", () => {
  test.each([
    ["One. Two.", "One"],
    ["No period here", "No period here"],
    ["Runs v1.2 checks. More.", "Runs v1.2 checks"],
    ["Line one\nwraps. Two.", "Line one wraps"],
  ])("%j -> %j", (input, expected) => {
    expect(firstSentence(input)).toBe(expected)
  })
})

describe("renderBlock", () => {
  const entries: Entry[] = [
    { name: "zeta", description: "Last one. Extra.", scope: "global", signals: [], requires: [] },
    { name: "alpha", description: "First one.", scope: "global", signals: [], requires: [] },
    { name: "lib", description: "Helpers.", scope: "internal", signals: [], requires: [] },
    { name: "beads", description: "Issues.", scope: "project", signals: [".beads/", "every repository"], requires: [] },
    { name: "speckit", description: "Specs.", scope: "project", signals: ["specs/*/tasks.md"], requires: ["beads"] },
  ]

  test("renders sorted tables between markers and omits internal plugins", () => {
    const block = renderBlock(entries)
    expect(block.startsWith(START)).toBe(true)
    expect(block.endsWith(END)).toBe(true)
    expect(block).toContain("| alpha | First one |\n| zeta | Last one |")
    expect(block).toContain("| beads | .beads/; every repository | none |")
    expect(block).toContain("| speckit | specs/*/tasks.md | beads |")
    expect(block).not.toContain("lib")
  })

  test("escapes pipes in cells", () => {
    const block = renderBlock([{ name: "a", description: "x | y.", scope: "global", signals: [], requires: [] }])
    expect(block).toContain("x \\| y")
  })
})

describe("replaceBlock", () => {
  test("replaces only the marked region", () => {
    const doc = `before\n${START}\nold\n${END}\nafter\n`
    expect(replaceBlock(doc, `${START}\nnew\n${END}`)).toBe(`before\n${START}\nnew\n${END}\nafter\n`)
  })

  test("throws when markers are missing", () => {
    expect(() => replaceBlock("no markers", "x")).toThrow("needs")
  })
})
