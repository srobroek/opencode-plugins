import { describe, expect, test } from "bun:test"
import type { Json, PluginSnapshot, SourceFile } from "./model.ts"
import { checkPractices } from "./practices.ts"
import { OPTIONAL_PEER, plugin } from "./test-fixtures.ts"

/** A manifest that passes every packaging rule for a global plugin. */
const CONFORMING: Json = { ...OPTIONAL_PEER, "opencode-plugins": { scope: "global" } }

const CLEAN_SRC: SourceFile[] = [
  {
    path: "plugins/demo/src/index.ts",
    text: 'export default Plugin.define({\n  id: "srobroek.demo",\n  async setup(ctx) {\n    editor.add({ name: "demo_run" })\n  },\n})',
  },
]

/** A conforming plugin named demo, with the given manifest and snapshot overrides. */
function demo(manifest: Json = {}, extra: Partial<PluginSnapshot> = {}): PluginSnapshot {
  return plugin("demo", { ...CONFORMING, ...manifest }, { src: CLEAN_SRC, ...extra })
}

function codes(snapshot: PluginSnapshot): string[] {
  return checkPractices(snapshot).map((finding) => finding.code)
}

describe("checkPractices", () => {
  test("a conforming shipped plugin has no findings", () => {
    expect(checkPractices(demo())).toEqual([])
  })

  test("internal packages with no dist export are not held to packaging rules", () => {
    const snapshot = plugin("lib", {
      private: undefined,
      exports: { ".": "./src/index.ts" },
      "opencode-plugins": { scope: "internal" },
    })
    expect(checkPractices(snapshot)).toEqual([])
  })

  test("a package that is not private or not a module is an error", () => {
    expect(codes(demo({ private: false }))).toContain("private")
    expect(codes(demo({ type: "commonjs" }))).toContain("type")
  })

  test("exports['.'] must be the bundle entry", () => {
    expect(codes(demo({ exports: { ".": "./src/index.ts" } }))).toContain("exports")
  })

  test("files must include dist and index.js, plus skills and agents when those directories exist", () => {
    expect(checkPractices(demo({ files: ["dist", "index.js"] }, { hasSkillsDir: true }))).toEqual([
      expect.objectContaining({ code: "files", message: expect.stringContaining("skills") }),
    ])
    expect(checkPractices(demo({ files: ["dist", "index.js"] }, { hasAgentsDir: true }))).toEqual([
      expect.objectContaining({ code: "files", message: expect.stringContaining("agents") }),
    ])
  })

  test("@opencode/plugin must be an optional peer", () => {
    expect(codes(demo({ peerDependencies: { "@opencode/plugin": "^2.1.4" }, peerDependenciesMeta: {} }))).toContain("peer")
    expect(codes(demo())).not.toContain("peer")
  })

  test("prepare and prepack scripts are errors", () => {
    expect(codes(demo({ scripts: { prepare: "x" } }))).toContain("lifecycle")
    expect(codes(demo({ scripts: { prepack: "x" } }))).toContain("lifecycle")
  })

  test("importing the lib without a workspace devDependency is an error", () => {
    const withLib = [
      ...CLEAN_SRC,
      { path: "plugins/demo/src/x.ts", text: 'import { a } from "@srobroek/opencode-lib/testing"' },
    ]
    expect(codes(demo({}, { src: withLib }))).toContain("lib-dep")
    expect(codes(demo({ devDependencies: { "@srobroek/opencode-lib": "workspace:*" } }, { src: withLib }))).not.toContain(
      "lib-dep",
    )
  })

  test("the plugin id must equal srobroek.<dirname>, in either id shape", () => {
    const wrong = [{ path: "plugins/demo/src/index.ts", text: 'Plugin.define({ id: "srobroek.other" })' }]
    expect(codes(demo({}, { src: wrong }))).toContain("plugin-id")
    const nested = [{ path: "plugins/demo/src/index.ts", text: 'createPlugin({ plugin: { id: "srobroek.demo" } })' }]
    expect(codes(demo({}, { src: nested }))).not.toContain("plugin-id")
    const content = [{ path: "plugins/demo/src/index.ts", text: 'export default contentPlugin("srobroek.demo", import.meta.url)' }]
    expect(codes(demo({}, { src: content }))).not.toContain("plugin-id-missing")
    expect(codes(demo({}, { src: [] }))).toContain("plugin-id-missing")
  })

  test("exports and files follow the entries that exist: a TUI-only plugin needs tui.js and no index.js", () => {
    const tuiOnly = plugin(
      "demo",
      { ...CONFORMING, exports: { "./tui": "./dist/tui.js" }, files: ["dist", "tui.js"] },
      { src: CLEAN_SRC },
    )
    expect(checkPractices(tuiOnly)).toEqual([])
    expect(codes(plugin("demo", { ...CONFORMING, exports: { "./tui": "./dist/tui.js" }, files: ["dist"] }, { src: CLEAN_SRC }))).toContain("files")
  })

  test("a tool name outside the <dirname>_ prefix is a warning; dashes become underscores", () => {
    const src = [
      {
        path: "plugins/demo-tools/src/index.ts",
        text: 'editor.add({\n  name: "demo_tools_run",\n})\neditor.add({ name: "other_run" })',
      },
    ]
    const findings = checkPractices(plugin("demo-tools", CONFORMING, { src }))
    expect(findings.filter((f) => f.code === "tool-name")).toEqual([
      expect.objectContaining({ severity: "warn", message: expect.stringContaining("other_run") }),
    ])
  })

  test("an exact version pin in a skill is a warning, except for the vendored cad plugin", () => {
    const skills = [{ path: "plugins/demo/skills/s/SKILL.md", text: "run `pip install ruff==0.6.1`" }]
    expect(codes(demo({}, { skills }))).toContain("exact-pin")
    expect(codes(plugin("cad", CONFORMING, { src: CLEAN_SRC, skills }))).not.toContain("exact-pin")
  })

  test("a shipped agent on an older model generation is a warning", () => {
    const agents = [
      { path: "plugins/demo/agents/a.md", text: 'model: "amazon-bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0"\n' },
      { path: "plugins/demo/agents/b.md", text: 'model: "amazon-bedrock/global.anthropic.claude-sonnet-5-5#medium"\n' },
    ]
    expect(checkPractices(demo({}, { agents }))).toEqual([
      expect.objectContaining({ code: "stale-model", file: "plugins/demo/agents/a.md" }),
    ])
  })
})
