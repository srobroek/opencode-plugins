import { describe, expect, test } from "bun:test"
import { chmodSync, closeSync, existsSync, fchownSync, fsyncSync, lstatSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync, writeSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { parse } from "jsonc-parser"
import { BACKUP_SUFFIX, effectiveConfig, findPluginEntry, globalConfigDir, pickConfigFile, projectConfigPaths, readAgents, readTiers, setAgentTier, setTier, writeAgentTier, writeFileAtomic, writeTier } from "./config-edit.ts"

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

describe("setAgentTier", () => {
  test("a bare entry gains options.agents, keeping the entry's package", () => {
    const next = setAgentTier(`{ "plugins": ["${SPEC}"] }`, "build", "strong") as string
    expect(parse(next).plugins[0]).toEqual({ package: SPEC, options: { agents: { build: "strong" } } })
    expect(readAgents(next)).toEqual({ build: "strong" })
  })

  test("sets, replaces and removes one agent; tiers and other agents stay", () => {
    const text = `{ "plugins": [{ "package": "${SPEC}", "options": { "tiers": { "docs": { "purpose": "d" } }, "agents": { "a": "cheap", "b": "strong" } } }] }`
    const replaced = setAgentTier(text, "a", "docs") as string
    expect(readAgents(replaced)).toEqual({ a: "docs", b: "strong" })
    const removed = setAgentTier(replaced, "b", undefined) as string
    expect(readAgents(removed)).toEqual({ a: "docs" })
    expect(readTiers(removed)).toEqual({ docs: { purpose: "d" } })
  })

  test("removing from a bare entry changes nothing; no entry gives undefined", () => {
    const text = `{ "plugins": ["${SPEC}"] }`
    expect(setAgentTier(text, "build", undefined)).toBe(text)
    expect(setAgentTier("{}", "build", "cheap")).toBeUndefined()
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
      expect(result).toEqual({ path: file, tiers: { cheap: { effort: "none" } }, warnings: [] })
      const written = readFileSync(file, "utf8")
      expect(written).toContain("// keep me")
      expect(written.endsWith("\n")).toBe(true)
      expect(() => writeTier(path.join(dir, "missing"), "cheap", {})).toThrow(/No model-roles plugin entry/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("writeAgentTier", () => {
  test("writes the override in place and keeps comments; removing it deletes the key", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "model-roles-config-"))
    try {
      const file = path.join(dir, "opencode.jsonc")
      writeFileSync(file, `{\n  // keep me\n  "plugins": ["${SPEC}"]\n}\n`)
      expect(writeAgentTier(dir, "build", "strong")).toEqual({ path: file, agents: { build: "strong" }, warnings: [] })
      expect(readFileSync(file, "utf8")).toContain("// keep me")
      expect(writeAgentTier(dir, "build", undefined)).toEqual({ path: file, agents: {}, warnings: [] })
      expect(() => writeAgentTier(path.join(dir, "missing"), "build", "cheap")).toThrow(/No model-roles plugin entry/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("projectConfigPaths", () => {
  test("direct files farthest first, then .opencode files farthest first; the global dir's files are skipped", () => {
    expect(projectConfigPaths("/r/p", "/g")).toEqual([
      "/opencode.json",
      "/opencode.jsonc",
      "/r/opencode.json",
      "/r/opencode.jsonc",
      "/r/p/opencode.json",
      "/r/p/opencode.jsonc",
      "/.opencode/opencode.json",
      "/.opencode/opencode.jsonc",
      "/r/.opencode/opencode.json",
      "/r/.opencode/opencode.jsonc",
      "/r/p/.opencode/opencode.json",
      "/r/p/.opencode/opencode.jsonc",
    ])
    expect(projectConfigPaths("/g/sub", "/g")).not.toContain("/g/opencode.json")
  })
})

describe("effectiveConfig", () => {
  const entry = (agents?: Record<string, string>) =>
    `{ "plugins": [{ "package": "${SPEC}"${agents === undefined ? "" : `, "options": { "agents": ${JSON.stringify(agents)} }`} }] }`
  const global = { path: "/g/opencode.json", text: entry({ a: "cheap" }) }

  test("no project entry: the global one", () => {
    expect(effectiveConfig([], global)).toEqual({ origin: "global", path: "/g/opencode.json", tiers: {}, agents: { a: "cheap" } })
    expect(effectiveConfig([{ path: "/p/opencode.json", text: '{ "plugins": ["other"] }' }], global).origin).toBe("global")
    expect(effectiveConfig([], undefined)).toEqual({ origin: "global", tiers: {}, agents: {} })
  })

  test("a project entry replaces the global one, even with the same value or without agents", () => {
    expect(effectiveConfig([{ path: "/p/opencode.json", text: entry({ a: "cheap" }) }], global)).toEqual({
      origin: "project",
      path: "/p/opencode.json",
      tiers: {},
      agents: { a: "cheap" },
    })
    expect(effectiveConfig([{ path: "/p/opencode.json", text: entry() }], global)).toEqual({ origin: "project", path: "/p/opencode.json", tiers: {}, agents: {} })
  })

  test("a project entry under another package string is a second instance: it never shadows, and is reported", () => {
    const other = { path: "/p/opencode.json", text: `{ "plugins": [{ "package": "/x/plugins/model-roles", "options": { "agents": { "a": "strong" } } }] }` }
    expect(effectiveConfig([other], global)).toEqual({ origin: "global", path: "/g/opencode.json", tiers: {}, agents: { a: "cheap" }, alsoLoads: "/p/opencode.json" })
    // The host's own target decides when it is known: the global entry under another string is then not ours.
    expect(effectiveConfig([other], { path: "/g/opencode.json", text: entry({ a: "cheap" }) }, "/x/plugins/model-roles")).toMatchObject({
      origin: "project",
      path: "/p/opencode.json",
      agents: { a: "strong" },
    })
  })

  test("only entries with the exact string are read and written when the spec is known", () => {
    const text = `{ "plugins": ["${SPEC}", { "package": "/x/plugins/model-roles", "options": { "agents": { "z": "cheap" } } }] }`
    expect(readAgents(text, "/x/plugins/model-roles")).toEqual({ z: "cheap" })
    expect(readAgents(text, SPEC)).toEqual({})
    expect(parse(setAgentTier(text, "b", "strong", "/x/plugins/model-roles") as string).plugins[1].options.agents).toEqual({ z: "cheap", b: "strong" })
    expect(setAgentTier(text, "b", "strong", "other")).toBeUndefined()
    expect(pickConfigFile([{ path: "/d/opencode.json", text }], "other")).toBeUndefined()
  })

  test("tiers follow the same entry as agents: a project entry's tiers replace the global ones whole", () => {
    const withTiers = (tiers: Record<string, unknown>) => `{ "plugins": [{ "package": "${SPEC}", "options": { "tiers": ${JSON.stringify(tiers)} } }] }`
    const g = { path: "/g/opencode.json", text: withTiers({ cheap: { effort: "low" } }) }
    expect(effectiveConfig([], g)).toMatchObject({ origin: "global", tiers: { cheap: { effort: "low" } } })
    expect(effectiveConfig([{ path: "/p/opencode.json", text: withTiers({ docs: { purpose: "d" } }) }], g)).toMatchObject({ origin: "project", tiers: { docs: { purpose: "d" } } })
    expect(effectiveConfig([{ path: "/p/opencode.json", text: entry() }], g)).toMatchObject({ origin: "project", tiers: {} })
  })

  test("the highest-precedence project entry wins", () => {
    const files = [
      { path: "/p/opencode.json", text: entry({ a: "strong" }) },
      { path: "/p/.opencode/opencode.json", text: entry({ b: "cheap" }) },
      { path: "/p/.opencode/opencode.jsonc", text: '{ "plugins": [] }' },
    ]
    expect(effectiveConfig(files, global)).toMatchObject({ origin: "project", path: "/p/.opencode/opencode.json", agents: { b: "cheap" } })
  })
})

describe("atomic config writes", () => {
  const fixture = (mode?: number) => {
    const dir = mkdtempSync(path.join(tmpdir(), "model-roles-atomic-"))
    const file = path.join(dir, "opencode.json")
    writeFileSync(file, `{ "plugins": ["${SPEC}"] }\n`)
    if (mode !== undefined) chmodSync(file, mode)
    return { dir, file, done: () => rmSync(dir, { recursive: true, force: true }) }
  }

  const REAL = { writeSync, renameSync, fchownSync, openSync, fsyncSync, closeSync }

  test("the original survives a failure while writing, and no temp file is left", () => {
    const { dir, file, done } = fixture()
    try {
      const before = readFileSync(file, "utf8")
      const torn = {
        ...REAL,
        writeSync: (fd: number, buf: Uint8Array, off: number) => {
          writeSync(fd, buf, off, 5) // a partial write, then the disk fails
          throw new Error("ENOSPC")
        },
      }
      expect(() => writeFileAtomic(file, "{ new }\n", torn)).toThrow("ENOSPC")
      expect(readFileSync(file, "utf8")).toBe(before)
      expect(readdirSync(dir)).toEqual(["opencode.json"])
    } finally {
      done()
    }
  })

  test("a short write is completed, multibyte text included", () => {
    const { file, done } = fixture()
    try {
      const calls: number[] = []
      const short = {
        ...REAL,
        writeSync: (fd: number, buf: Uint8Array, off: number, len: number) => {
          calls.push(len)
          return writeSync(fd, buf, off, Math.min(len, 3)) // never more than 3 bytes, no error
        },
      }
      const text = '{ "plugins": ["é→x"] }\n'
      writeFileAtomic(file, text, short)
      expect(readFileSync(file, "utf8")).toBe(text)
      expect(calls.length).toBeGreaterThan(2)
    } finally {
      done()
    }
  })

  test("a write that takes no bytes fails and leaves the original", () => {
    const { dir, file, done } = fixture()
    try {
      const before = readFileSync(file, "utf8")
      expect(() => writeFileAtomic(file, "{ new }\n", { ...REAL, writeSync: () => 0 })).toThrow("Short write")
      expect(readFileSync(file, "utf8")).toBe(before)
      expect(readdirSync(dir)).toEqual(["opencode.json"])
    } finally {
      done()
    }
  })

  test("the original survives a failed rename", () => {
    const { dir, file, done } = fixture()
    try {
      const before = readFileSync(file, "utf8")
      const io = {
        ...REAL,
        renameSync: () => {
          throw new Error("EXDEV")
        },
      }
      expect(() => writeFileAtomic(file, "{ new }\n", io)).toThrow("EXDEV")
      expect(readFileSync(file, "utf8")).toBe(before)
      expect(readdirSync(dir).filter((n) => n.includes("tmp"))).toEqual([])
    } finally {
      done()
    }
  })

  test("the temp file takes the original's owner and group; EPERM refuses the save", () => {
    const { dir, file, done } = fixture()
    try {
      const { uid, gid } = statSync(file)
      const owners: Array<[number, number]> = []
      writeFileAtomic(file, "{ a }\n", { ...REAL, fchownSync: (_fd, u, g) => owners.push([u, g]) })
      expect(owners).toEqual([[uid, gid]])
      const before = readFileSync(file, "utf8")
      const denied = {
        ...REAL,
        fchownSync: () => {
          throw Object.assign(new Error("operation not permitted"), { code: "EPERM" })
        },
      }
      expect(() => writeFileAtomic(file, "{ b }\n", denied)).toThrow(/belongs to another user.*will not change its ownership/)
      expect(readFileSync(file, "utf8")).toBe(before)
      expect(readdirSync(dir).filter((n) => n.includes("tmp"))).toEqual([])
    } finally {
      done()
    }
  })

  test("the backup and the directory are synced; a directory that rejects fsync does not fail the save", () => {
    const { dir, file, done } = fixture()
    try {
      const real = realpathSync(dir)
      const opened = new Map<number, string>()
      const synced: string[] = []
      const watching = {
        ...REAL,
        openSync: ((p: string, ...rest: [string, number?]) => {
          const fd = openSync(p, ...(rest as [string, number?]))
          opened.set(fd, p)
          return fd
        }) as typeof openSync,
        fsyncSync: (fd: number) => {
          synced.push(opened.get(fd) ?? "temp")
          const p = opened.get(fd)
          if (p === real) throw Object.assign(new Error("invalid"), { code: "EINVAL" })
          fsyncSync(fd)
        },
      }
      writeFileAtomic(file, "{ a }\n", watching)
      expect(synced).toContain(path.join(real, `opencode.json${BACKUP_SUFFIX}`))
      expect(synced.at(-1)).toBe(real) // the directory comes last, after the rename
      expect(readFileSync(file, "utf8")).toBe("{ a }\n")
    } finally {
      done()
    }
  })

  const failingDirSync = (code: string) => {
    const dirs = new Set<number>()
    return {
      ...REAL,
      openSync: ((p: string, ...rest: [string, number?]) => {
        const fd = openSync(p, ...(rest as [string, number?]))
        if (statSync(p).isDirectory()) dirs.add(fd)
        return fd
      }) as typeof openSync,
      fsyncSync: (fd: number) => {
        if (dirs.has(fd)) throw Object.assign(new Error(code), { code })
        fsyncSync(fd)
      },
    }
  }

  test.each(["EINVAL", "ENOTSUP", "EOPNOTSUPP", "EISDIR", "EPERM", "EACCES"])("a directory that cannot be synced (%s) is ignored", (code) => {
    const { file, done } = fixture()
    try {
      expect(writeFileAtomic(file, "{ a }\n", failingDirSync(code))).toBeUndefined()
      expect(readFileSync(file, "utf8")).toBe("{ a }\n")
    } finally {
      done()
    }
  })

  test("a real directory sync failure (EIO) is a warning; the new content is written", () => {
    const { file, done } = fixture()
    try {
      expect(writeFileAtomic(file, "{ a }\n", failingDirSync("EIO"))).toBe("written; durability unconfirmed (EIO)")
      expect(readFileSync(file, "utf8")).toBe("{ a }\n")
    } finally {
      done()
    }
  })

  test("the file mode is kept", () => {
    const { file, done } = fixture(0o600)
    try {
      writeTier(path.dirname(file), "cheap", { effort: "low" }, SPEC)
      expect(statSync(file).mode & 0o777).toBe(0o600)
      expect(readTiers(readFileSync(file, "utf8"))).toEqual({ cheap: { effort: "low" } })
    } finally {
      done()
    }
  })

  test("one rolling backup holds the content before the latest save", () => {
    const { file, done } = fixture()
    try {
      const original = readFileSync(file, "utf8")
      writeTier(path.dirname(file), "cheap", { effort: "low" }, SPEC)
      const first = readFileSync(file, "utf8")
      expect(readFileSync(file + BACKUP_SUFFIX, "utf8")).toBe(original)
      writeAgentTier(path.dirname(file), "worker", "cheap", SPEC)
      expect(readFileSync(file + BACKUP_SUFFIX, "utf8")).toBe(first)
      expect(readdirSync(path.dirname(file)).sort()).toEqual(["opencode.json", `opencode.json${BACKUP_SUFFIX}`])
    } finally {
      done()
    }
  })

  test("an unchanged save touches nothing and leaves no backup", () => {
    const { file, done } = fixture()
    try {
      writeTier(path.dirname(file), "cheap", undefined, SPEC)
      expect(existsSync(file + BACKUP_SUFFIX)).toBe(false)
    } finally {
      done()
    }
  })

  test("a symlinked config is written through, not replaced", () => {
    const { dir, file, done } = fixture()
    try {
      const real = path.join(dir, "real")
      renameSync(file, real)
      symlinkSync(real, file)
      writeTier(dir, "cheap", { effort: "low" }, SPEC)
      expect(readTiers(readFileSync(real, "utf8"))).toEqual({ cheap: { effort: "low" } })
      expect(lstatSync(file).isSymbolicLink()).toBe(true)
    } finally {
      done()
    }
  })
})
