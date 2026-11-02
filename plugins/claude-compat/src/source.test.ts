import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { configGroups, discoverPlugins, expandHome, PROJECT_FILE, parseSources, within } from "./source.ts"

function scratch() {
  const base = join(tmpdir(), "opencode")
  mkdirSync(base, { recursive: true })
  const root = realpathSync(mkdtempSync(join(base, "claude-compat-source-")))
  const put = (path: string, content: string) => {
    mkdirSync(join(root, path, ".."), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  return { root, put, done: () => rmSync(root, { recursive: true, force: true }) }
}

describe("configuration", () => {
  test("sources need a path, or git and ref", () => {
    expect(parseSources([{ path: "./marketplace" }, { git: "ssh://example/repo", ref: "abc123" }])).toHaveLength(2)
    expect(() => parseSources([{ git: "ssh://example/repo" }])).toThrow()
    expect(() => parseSources([{ path: "a", git: "b", ref: "c" }])).toThrow()
  })

  test("groups come from options, matching projects entries and the project file", () => {
    const files: Record<string, string> = { [join("/work/app", PROJECT_FILE)]: '{"sources":[{"path":"./claude"}],"plugins":["x"]}' }
    const options = {
      projectFile: true,
      sources: [{ path: "/global/market" }],
      projects: { "/work": { sources: [{ path: "./shared" }] }, "/other": { sources: [{ path: "/nope" }] } },
    }
    const { groups, diagnostics } = configGroups(options, "/work/app", (path) => files[path])
    expect(groups).toEqual([
      { origin: "options", sources: [{ path: "/global/market" }] },
      { origin: "projects./work", sources: [{ path: "./shared" }] },
      {
        origin: PROJECT_FILE,
        sources: [{ path: "./claude" }],
        plugins: ["x"],
        projectFile: { path: join("/work/app", PROJECT_FILE), text: files[join("/work/app", PROJECT_FILE)] as string },
      },
    ])
    expect(diagnostics).toEqual([])
    // S1: the project file is ignored unless projectFile is true.
    expect(configGroups({}, "/work/app", (path) => files[path]).groups).toEqual([])
    expect(configGroups({ projectFile: false }, "/work/app", (path) => files[path]).groups).toEqual([])
  })

  test("a malformed project file is reported, not fatal; malformed options throw", () => {
    const { groups, diagnostics } = configGroups({ projectFile: true }, "/p", () => "{nope")
    expect(groups).toEqual([])
    expect(diagnostics[0]?.where).toBe(join("/p", PROJECT_FILE))
    expect(() => configGroups({ projects: [] }, "/p", () => undefined)).toThrow("projects must map")
    expect(() => configGroups({ plugins: "demo" }, "/p", () => undefined)).toThrow("plugins must be a list")
  })

  test("paths", () => {
    expect(expandHome("~/x", "/home/me")).toBe("/home/me/x")
    expect(within("/a/b", "/a/b/c")).toBe(true)
    expect(within("/a/b", "/a/bc")).toBe(false)
    expect(within("/a/b", "/a")).toBe(false)
  })
})

describe("discovery", () => {
  test("marketplace path traversal and escaping symlinks are rejected", () => {
    const { root, put, done } = scratch()
    try {
      put(".claude-plugin/marketplace.json", '{"plugins":[{"name":"bad","source":"./../"}]}')
      expect(() => discoverPlugins(root)).toThrow("path escapes source")
      symlinkSync(join(root, ".."), join(root, "escape"))
      put(".claude-plugin/marketplace.json", '{"plugins":[{"name":"bad","source":"./escape"}]}')
      expect(() => discoverPlugins(root)).toThrow("path escapes source")
    } finally {
      done()
    }
  })

  test("unsupported entries are reported without dropping others; entries without plugin.json use the entry", () => {
    const { root, put, done } = scratch()
    try {
      put(
        ".claude-plugin/marketplace.json",
        JSON.stringify({
          plugins: [
            { name: "remote", source: { source: "github", repo: "demo/repo" } },
            { name: "demo", source: "./plugins/demo" },
            { name: "inline", source: "plugins/inline", strict: false },
            { name: "missing", source: "./plugins/missing" },
          ],
        }),
      )
      put("plugins/demo/.claude-plugin/plugin.json", '{"name":"demo"}')
      put("plugins/inline/skills/x/SKILL.md", "---\nname: x\n---\n")
      const issues: string[] = []
      const found = discoverPlugins(root, (where) => issues.push(where))
      expect(found.map((plugin) => plugin.name)).toEqual(["demo", "inline"])
      expect(found[1]?.manifest).toMatchObject({ name: "inline", strict: false })
      expect(issues).toEqual(["remote", "missing"])
    } finally {
      done()
    }
  })

  test("a single plugin directory is one plugin", () => {
    const { root, put, done } = scratch()
    try {
      put(".claude-plugin/plugin.json", '{"name":"solo"}')
      expect(discoverPlugins(root)).toEqual([{ name: "solo", root, manifest: { name: "solo" } }])
    } finally {
      done()
    }
  })

  test("a marketplace reached through a symlinked parent (like /home → /local/home) still resolves", () => {
    const { root, put, done } = scratch()
    try {
      put("real/.claude-plugin/marketplace.json", '{"plugins":[{"name":"demo","source":"./plugins/demo"}]}')
      put("real/plugins/demo/.claude-plugin/plugin.json", '{"name":"demo"}')
      symlinkSync(join(root, "real"), join(root, "link"))
      expect(discoverPlugins(join(root, "link")).map((plugin) => plugin.root)).toEqual([join(root, "real/plugins/demo")])
    } finally {
      done()
    }
  })
})
