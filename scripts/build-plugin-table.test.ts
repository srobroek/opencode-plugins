import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  checkTable,
  END,
  type Entry,
  firstSentence,
  parseEntry,
  planTable,
  renderBlock,
  replaceBlock,
  START,
  TABLE_FILE,
  writeTable,
} from "./build-plugin-table.ts"

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

describe("replaceBlock markers", () => {
  const block = `${START}\nnew\n${END}`

  test("leaves an inline or code-span mention before the table alone", () => {
    const doc = `Text with ${START} inline and \`${END}\` in a span.\n\n${START}\nold\n${END}\n`
    expect(replaceBlock(doc, block)).toBe(`Text with ${START} inline and \`${END}\` in a span.\n\n${block}\n`)
  })

  test.each([
    ["duplicate start", `${START}\n${START}\n${END}`, "found 2 and 1"],
    ["duplicate end", `${START}\n${END}\n${END}`, "found 1 and 2"],
    ["missing end", `${START}\n`, "found 1 and 0"],
    ["out of order", `${END}\n${START}`, "before"],
  ])("fails on %s", (_name, doc, message) => {
    expect(() => replaceBlock(doc, block)).toThrow(message)
  })
})

describe("marker text in entries", () => {
  test("rejects an end marker in a description", () => {
    expect(() => parseEntry("a", manifest({ scope: "global" }, { description: `Bad ${END} text.` }))).toThrow("marker")
  })

  test("rejects a start marker in a signal", () => {
    expect(() => parseEntry("a", manifest({ scope: "project", signals: [START] }))).toThrow("marker")
  })
})

describe("planTable", () => {
  let root: string

  function plugin(name: string, config: Record<string, unknown>) {
    const dir = path.join(root, "plugins", name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ description: `${name} does work.`, "opencode-plugins": config }))
  }

  function tableFile(contents: string) {
    const file = path.join(root, TABLE_FILE)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, contents)
    return file
  }

  const read = () => readFileSync(path.join(root, TABLE_FILE), "utf8")
  const skeleton = `# Title\n\n${START}\nold\n${END}\n\nTail\n`

  beforeEach(() => {
    const base = path.join(realpathSync(os.tmpdir()), "opencode")
    mkdirSync(base, { recursive: true })
    root = mkdtempSync(path.join(base, "plugin-table-"))
    plugin("project", { scope: "global" })
    plugin("alpha", { scope: "global" })
    plugin("beads", { scope: "project", signals: [".beads/"] })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  test("a fresh table is not stale and check writes nothing", () => {
    tableFile(skeleton)
    writeTable(root)
    const fresh = read()
    expect(checkTable(root).stale).toBe(false)
    expect(read()).toBe(fresh)
    expect(fresh).toContain("| alpha | alpha does work |")
    expect(fresh).toContain("| beads | .beads/ | none |")
    expect(fresh.endsWith("\nTail\n")).toBe(true)
  })

  test("a stale table is reported and check leaves the file unchanged", () => {
    tableFile(skeleton)
    const plan = checkTable(root)
    expect(plan.stale).toBe(true)
    expect(plan.contents).toContain("### Global plugins")
    expect(read()).toBe(skeleton)
  })

  test("a plugin without scope fails", () => {
    tableFile(skeleton)
    plugin("noscope", {})
    expect(() => planTable(root)).toThrow("plugins/noscope/package.json")
  })

  test("a project plugin without signals fails", () => {
    tableFile(skeleton)
    plugin("nosignals", { scope: "project" })
    expect(() => planTable(root)).toThrow("needs")
  })

  test("requires naming an unknown plugin fails", () => {
    tableFile(skeleton)
    plugin("needy", { scope: "project", signals: ["x/"], requires: ["ghost"] })
    expect(() => planTable(root)).toThrow('requires unknown plugin "ghost"')
  })

  test("bad markers fail before anything is written", () => {
    const bad = `${START}\n${START}\n${END}\n`
    tableFile(bad)
    expect(() => writeTable(root)).toThrow("exactly one")
    expect(read()).toBe(bad)
  })
})
