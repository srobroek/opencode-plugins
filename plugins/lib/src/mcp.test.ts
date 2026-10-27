// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the tests feed .mcp.json ${VAR} syntax
import { describe, expect, test } from "bun:test"
import {
  applyMcp,
  type ClaudeMcpServer,
  expandVars,
  locationDirectories,
  type McpConfig,
  parseMcpJson,
  parseMcpOptions,
  planMcp,
  registerMcp,
  toOpenCode,
} from "./mcp.ts"
import { createFakeContext } from "./testing.ts"

const SERVERS = parseMcpJson(
  JSON.stringify({
    mcpServers: {
      local: { command: "uvx", args: ["pkg@1.0.0", "--flag"], env: { REGION: "${REGION:-us-east-1}" } },
      remote: { type: "http", url: "https://example.com/mcp", headers: { KEY: "${API_KEY}" } },
    },
  }),
)

describe("parseMcpJson", () => {
  test("infers stdio and http types", () => {
    const servers = parseMcpJson('{"mcpServers":{"a":{"command":"x"},"b":{"url":"https://b"}}}')
    expect(servers.a?.type).toBe("stdio")
    expect(servers.b?.type).toBe("http")
  })

  test("accepts an empty document", () => {
    expect(parseMcpJson("{}")).toEqual({})
  })

  test("rejects malformed servers", () => {
    expect(() => parseMcpJson('{"mcpServers":{"a":{}}}')).toThrow("a: command is required")
    expect(() => parseMcpJson('{"mcpServers":{"a":{"type":"http"}}}')).toThrow("a: url is required")
    expect(() => parseMcpJson('{"mcpServers":{"a":{"command":"x","args":[1]}}}')).toThrow("args must be strings")
    expect(() => parseMcpJson('{"mcpServers":{"a":{"type":"ws","url":"x"}}}')).toThrow("unknown type ws")
  })
})

describe("expandVars", () => {
  test("expands set variables and defaults, and records unset ones", () => {
    const missing = new Set<string>()
    expect(expandVars("${A}-${B:-b}-${C}", { A: "a" }, missing)).toBe("a-b-")
    expect([...missing]).toEqual(["C"])
  })

  test("uses the default for an empty variable", () => {
    const missing = new Set<string>()
    expect(expandVars("${A:-x}", { A: "" }, missing)).toBe("x")
    expect(expandVars("${A}", { A: "" }, missing)).toBe("")
    expect(missing.size).toBe(0)
  })
})

describe("toOpenCode", () => {
  test("turns stdio into a local command array with environment", () => {
    expect(toOpenCode((SERVERS.local as ClaudeMcpServer), {})).toEqual({
      config: {
        type: "local",
        command: ["uvx", "pkg@1.0.0", "--flag"],
        environment: { REGION: "us-east-1" },
        codemode: true,
      } as McpConfig,
    })
  })

  test("turns http into remote and reports unset variables", () => {
    expect(toOpenCode((SERVERS.remote as ClaudeMcpServer), {})).toEqual({ missing: ["API_KEY"] })
    expect(toOpenCode((SERVERS.remote as ClaudeMcpServer), { API_KEY: "k" })).toEqual({
      config: { type: "remote", url: "https://example.com/mcp", headers: { KEY: "k" }, codemode: true } as McpConfig,
    })
  })
})

describe("parseMcpOptions", () => {
  test("defaults to auto with no switches", () => {
    expect(parseMcpOptions(undefined)).toEqual({ mode: "auto", servers: {} })
    expect(parseMcpOptions({ mcp: "sometimes" })).toEqual({ mode: "auto", servers: {} })
  })

  test("reads the mode and boolean switches", () => {
    expect(parseMcpOptions({ mcp: "off", mcpServers: { a: false, b: true, c: "yes" } })).toEqual({
      mode: "off",
      servers: { a: false, b: true },
    })
  })
})

describe("planMcp", () => {
  const env = { API_KEY: "k" }

  test("off adds nothing and auto follows relevance", () => {
    expect(planMcp(SERVERS, { mode: "off", servers: {} }, { env }).add).toEqual([])
    expect(planMcp(SERVERS, { mode: "auto", servers: {} }, { env, relevant: () => false }).add).toEqual([])
    expect(planMcp(SERVERS, { mode: "auto", servers: {} }, { env, relevant: () => true }).add).toHaveLength(2)
  })

  test("always skips the relevance check", () => {
    let called = false
    const relevant = () => {
      called = true
      return false
    }
    expect(planMcp(SERVERS, { mode: "always", servers: {} }, { env, relevant }).add).toHaveLength(2)
    expect(called).toBe(false)
  })

  test("default-off servers need a switch; switches turn servers off", () => {
    const plan = planMcp(SERVERS, { mode: "always", servers: { local: false } }, { env, off: ["remote"] })
    expect(plan.add).toEqual([])
    expect(plan.skipped.map((s) => s.reason)).toEqual(["turned off", "turned off"])
    const on = planMcp(SERVERS, { mode: "always", servers: { remote: true } }, { env, off: ["remote"] })
    expect(on.add.map(([name]) => name)).toEqual(["local", "remote"])
  })

  test("skips a server with an unset variable and merges extras", () => {
    const plan = planMcp(SERVERS, { mode: "always", servers: {} }, { env: {}, extra: { local: { codemode: false } } })
    expect(plan.skipped).toEqual([{ name: "remote", reason: "unset API_KEY" }])
    expect(plan.add[0]?.[1]).toMatchObject({ type: "local", codemode: false })
  })
})

describe("applyMcp", () => {
  test("leaves configured servers alone", () => {
    const store = new Map<string, unknown>([["local", { type: "local", command: ["mine"] }]])
    const editor = {
      get: (name: string) => store.get(name) as never,
      set: (name: string, config: McpConfig) => void store.set(name, config),
    }
    applyMcp(editor, planMcp(SERVERS, { mode: "always", servers: {} }, { env: { API_KEY: "k" } }).add)
    expect(store.get("local")).toEqual({ type: "local", command: ["mine"] })
    expect(store.get("remote")).toMatchObject({ type: "remote" })
  })
})

describe("registerMcp", () => {
  test("adds servers, keeps user config and disposes", async () => {
    const fake = createFakeContext({ mcp: { remote: { type: "remote", url: "https://mine" } } })
    const { registration } = await registerMcp(fake.context, SERVERS, { mode: "always", servers: {} }, { env: {} })
    expect(fake.mcp.get("remote")).toEqual({ type: "remote", url: "https://mine" })
    expect(fake.mcp.get("local")).toMatchObject({ type: "local" })
    await registration.dispose()
    expect([...fake.mcp.keys()]).toEqual(["remote"])
    expect(fake.active()).toBe(0)
  })

  test("registers no transform when nothing is added", async () => {
    const fake = createFakeContext()
    await registerMcp(fake.context, SERVERS, { mode: "off", servers: {} })
    expect(fake.active()).toBe(0)
  })
})

test("locationDirectories adds a distinct project root", () => {
  expect(locationDirectories({ location: { directory: "/a/b", project: { directory: "/a" } } } as never)).toEqual([
    "/a/b",
    "/a",
  ])
  expect(locationDirectories({ location: { directory: "/a" } } as never)).toEqual(["/a"])
})
