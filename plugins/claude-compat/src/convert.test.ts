// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Fixtures exercise literal Claude placeholders.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { permissionEffect } from "@srobroek/opencode-lib/agent-files"
import {
  commandText,
  contentDiagnostics,
  convertAgent,
  convertCommand,
  convertSkill,
  intersectPermissions,
  mapTool,
  markdown,
  modelTier,
  overlap,
  parseClaudeMcp,
  restrictedEffect,
  rewriteRoot,
  sensitiveAsks,
  TOOL_NOTE,
  toolPermissions,
} from "./convert.ts"

const FIXTURE = join(import.meta.dir, "..", "fixtures", "marketplace", "plugins", "demo")
const fixture = (path: string) => readFileSync(join(FIXTURE, path), "utf8")
const settings = { untypedAgents: "inherit" as const, toolNote: true }
const scope = { plugin: "demo" }

describe("Claude tools to OpenCode permissions", () => {
  test("maps every documented tool and refuses unknown names", () => {
    const expected: Record<string, string> = {
      Bash: "shell",
      Read: "read",
      Edit: "edit",
      Write: "edit",
      MultiEdit: "edit",
      Grep: "grep",
      Glob: "glob",
      Task: "subagent",
      WebFetch: "webfetch",
      WebSearch: "websearch",
    }
    for (const [tool, action] of Object.entries(expected)) expect(mapTool(tool, scope)).toEqual({ rules: [{ action, resource: "*", effect: "allow" }] })
    expect(mapTool("TodoWrite", scope)).toEqual({ error: "Unknown Claude tool: TodoWrite; dropped" })
    expect(mapTool("Bashful", scope)).toHaveProperty("error")
  })

  test("maps MCP names, including the plugin namespace, and allows Code Mode execute", () => {
    expect(mapTool("mcp__github__create_issue", scope)).toEqual({
      rules: [
        { action: "github_create_issue", resource: "*", effect: "allow" },
        { action: "execute", resource: "*", effect: "allow" },
      ],
    })
    expect((mapTool("mcp__plugin_demo_echo__*", scope) as { rules: { action: string }[] }).rules[0]?.action).toBe("echo_*")
    expect((mapTool("mcp__plugin_demo_awslabs.docs__*", scope) as { rules: { action: string }[] }).rules[0]?.action).toBe("awslabs_docs_*")
    expect((mapTool("mcp__awslabs.echo__say.hello", scope) as { rules: { action: string }[] }).rules[0]?.action).toBe("awslabs_echo_say_hello")
    expect((mapTool("mcp__context7", scope) as { rules: { action: string }[] }).rules[0]?.action).toBe("context7_*")
  })

  test("keeps Claude rule patterns as resources", () => {
    expect(mapTool("Bash(git:*)", scope)).toEqual({ rules: [{ action: "shell", resource: "git *", effect: "allow" }] })
    expect(mapTool("Read(src/**)", scope)).toEqual({ rules: [{ action: "read", resource: "src/**", effect: "allow" }] })
  })

  test("is fail-closed: deny all first, unknown tools dropped with a warning, disallowed denied last", () => {
    const result = toolPermissions(["Read", "Frobnicate", "Bash"], ["Bash(rm:*)"], scope, "inherit", "a")
    expect(result.permissions[0]).toEqual({ action: "*", resource: "*", effect: "deny" })
    expect(permissionEffect(result.permissions, "read")).toBe("allow")
    expect(permissionEffect(result.permissions, "shell", "ls")).toBe("allow")
    expect(permissionEffect(result.permissions, "shell", "rm -rf x")).toBe("deny")
    expect(permissionEffect(result.permissions, "edit")).toBe("deny")
    expect(permissionEffect(result.permissions, "frobnicate")).toBe("deny")
    expect(permissionEffect(result.permissions, "external_directory")).toBe("ask")
    expect(permissionEffect(result.permissions, "read", "/p/.env")).toBe("ask")
    // Over-strict on purpose: `.env.example` asks too, rather than risk reopening a secret.
    expect(permissionEffect(result.permissions, "read", "/p/.env.example")).toBe("ask")
    expect(result.diagnostics).toEqual([{ where: "a", message: "Unknown Claude tool: Frobnicate; dropped" }])
  })

  test("agents without tools inherit by default or deny everything when configured", () => {
    expect(toolPermissions(undefined, undefined, scope, "inherit", "a").permissions).toEqual([])
    const denied = toolPermissions(undefined, undefined, scope, "deny", "a")
    expect(permissionEffect(denied.permissions, "read")).toBe("deny")
    expect(denied.diagnostics[0]?.message).toContain("deny-all")
    // An empty list is an explicit "no tools", not an untyped agent.
    expect(permissionEffect(toolPermissions([], undefined, scope, "inherit", "a").permissions, "read")).toBe("deny")
  })
})

describe("sensitive files (S3)", () => {
  test("every read or edit grant, scoped or not, gets the .env asks inside it", () => {
    for (const spec of ["Read", "Read(**)", "Read(/repo/**)", "Edit", "Write(src/**)"]) {
      const { permissions } = toolPermissions([spec], undefined, scope, "inherit", "a")
      const action = spec.startsWith("Read") ? "read" : "edit"
      const inside = spec.includes("src/") ? "src/conf/.env" : spec.includes("/repo/") ? "/repo/app/.env.local" : "/any/.env"
      expect(permissionEffect(permissions, action, inside)).toBe("ask")
    }
    const scoped = toolPermissions(["Read(src/**)"], undefined, scope, "inherit", "a").permissions
    // The asks never reach outside the grant: a .env elsewhere stays denied.
    expect(permissionEffect(scoped, "read", "/other/.env")).toBe("deny")
    expect(permissionEffect(scoped, "read", "src/a.ts")).toBe("allow")
    expect(sensitiveAsks([{ action: "read", resource: "/etc/app.env", effect: "allow" }])).toEqual([{ action: "read", resource: "/etc/app.env", effect: "ask" }])
    expect(sensitiveAsks([{ action: "read", resource: "/etc/app.ts", effect: "allow" }])).toEqual([])
    expect(sensitiveAsks([{ action: "shell", resource: "*", effect: "allow" }])).toEqual([])
  })

  test("overlap stays inside the grant and is exact only when it can be", () => {
    expect(overlap("src/**", "*.env")).toEqual({ pattern: "src/**.env", exact: true })
    expect(overlap("*", "*.env")).toEqual({ pattern: "*.env", exact: true })
    expect(overlap("a.en*", "*.env")).toEqual({ pattern: "a.en*", exact: false })
    expect(overlap("echo_*", "lsp_*")).toBeUndefined()
    expect(overlap("echo_*", "echo_shout")).toEqual({ pattern: "echo_shout", exact: true })
    expect(overlap("git *", "*push*")).toEqual({ pattern: "git *push*", exact: true })
    expect(overlap("src/*.ts", "*gen*")).toEqual({ pattern: "src/*.ts", exact: false })
  })
})

describe("user policy wins over imported grants (S2)", () => {
  const imported = toolPermissions(["Read", "Bash", "Grep"], undefined, scope, "inherit", "a").permissions
  const host = [
    { action: "*", resource: "*", effect: "allow" as const },
    { action: "read", resource: "*.env", effect: "ask" as const },
  ]
  test("a user deny or ask is never overridden by an imported allow", () => {
    const user = [...host, { action: "shell", resource: "*", effect: "ask" as const }, { action: "grep", resource: "*", effect: "deny" as const }, { action: "read", resource: "/secret/*", effect: "deny" as const }]
    const merged = intersectPermissions(user, imported)
    expect(permissionEffect(merged, "shell", "ls")).toBe("ask")
    expect(permissionEffect(merged, "grep")).toBe("deny")
    expect(permissionEffect(merged, "read", "/secret/key")).toBe("deny")
    expect(permissionEffect(merged, "read", "/p/.env")).toBe("ask")
    expect(permissionEffect(merged, "read", "/p/a.ts")).toBe("allow")
    // The import's boundary holds: nothing outside its grants reopens.
    expect(permissionEffect(merged, "edit")).toBe("deny")
    expect(permissionEffect(merged, "webfetch")).toBe("deny")
  })

  test("the user's own carve-outs keep their order inside a grant", () => {
    const user = [...host, { action: "shell", resource: "*", effect: "deny" as const }, { action: "shell", resource: "git *", effect: "allow" as const }]
    const merged = intersectPermissions(user, imported)
    expect(permissionEffect(merged, "shell", "git status")).toBe("allow")
    expect(permissionEffect(merged, "shell", "rm -rf /")).toBe("deny")
  })

  test("a user ask outside the imported grants does not reopen a denied tool", () => {
    const merged = intersectPermissions([...host, { action: "edit", resource: "*", effect: "ask" as const }], imported)
    expect(permissionEffect(merged, "edit")).toBe("deny")
  })

  test("a user allow that cannot be projected exactly is not restated; a deny is, wider (stricter)", () => {
    const grant = toolPermissions(["Read(src/*.ts)"], undefined, scope, "inherit", "a").permissions
    const user = [...host, { action: "read", resource: "*gen*", effect: "deny" as const }, { action: "read", resource: "*/gen/keep*", effect: "allow" as const }]
    const merged = intersectPermissions(user, grant)
    expect(permissionEffect(merged, "read", "src/gen.ts")).toBe("deny")
    // The user allows it, but restating that allow over the whole grant would reopen src/gen.ts.
    expect(permissionEffect(merged, "read", "src/gen/keep.ts")).toBe("deny")
  })

  test("an inheriting agent keeps the user's rules as they are", () => {
    const user = [...host, { action: "shell", resource: "*", effect: "deny" as const }, { action: "shell", resource: "git *", effect: "allow" as const }]
    expect(intersectPermissions(user, [])).toEqual(user)
  })

  test("runtime intersection never weakens session policy, user asks/denies, or imported disallowedTools", () => {
    const agent = toolPermissions(["Read", "Bash"], ["Read(/secret/*)"], scope, "inherit", "a").permissions
    const user = [...host, { action: "shell", resource: "*", effect: "ask" as const }, { action: "read", resource: "private/*", effect: "deny" as const }]
    expect(restrictedEffect("allow", user, agent, "shell", ["ls"])).toBe("ask")
    expect(restrictedEffect("allow", user, agent, "read", ["private/key"])).toBe("deny")
    expect(restrictedEffect("allow", user, agent, "read", ["/secret/key"])).toBe("deny")
    expect(restrictedEffect("deny", user, agent, "read", ["ok.txt"])).toBe("deny")
    expect(restrictedEffect("allow", user, agent, "edit", ["ok.txt"])).toBe("deny")
    const merged = intersectPermissions(user, agent)
    expect(permissionEffect(merged, "read", "/secret/key")).toBe("deny")
  })
})

describe("model aliases", () => {
  test("map to model-roles tiers without pinning", () => {
    expect(modelTier("haiku", "a")).toEqual({ tier: "cheap" })
    expect(modelTier("sonnet", "a")).toEqual({ tier: "standard" })
    expect(modelTier("opus", "a")).toEqual({ tier: "strong" })
    expect(modelTier("inherit", "a")).toEqual({})
    expect(modelTier(undefined, "a")).toEqual({})
    expect(modelTier("global.anthropic.claude-opus-5-5[1m]", "a").tier).toBe("strong")
    expect(modelTier("gpt-9", "a")).toEqual({ diagnostic: { where: "a", message: "Unsupported model gpt-9; inherits session model" } })
  })
})

describe("agents", () => {
  test("the fixture reader agent: namespaced, deny-first, MCP mapped, tier header, tool note, root expanded", () => {
    const { agent, diagnostics } = convertAgent(fixture("agents/reader.md"), { plugin: "demo", name: "reader", root: "/r" }, settings)
    expect(agent.id).toBe("demo:reader")
    expect(agent.mode).toBe("subagent")
    expect(agent.request).toEqual({ headers: { "x-opencode-model-role": "cheap" } })
    expect(agent).not.toHaveProperty("model")
    expect(agent.system).toStartWith("You are a read-only fixture agent. Use Read and Grep. Plugin root: /r.")
    expect(agent.system).toEndWith(TOOL_NOTE)
    for (const action of ["read", "grep", "glob", "echo_shout", "execute"]) expect(permissionEffect(agent.permissions, action)).toBe("allow")
    for (const action of ["shell", "edit", "subagent", "webfetch", "docs_search"]) expect(permissionEffect(agent.permissions, action)).toBe("deny")
    expect(diagnostics.map((issue) => issue.message)).toEqual(["Unknown Claude tool: TodoWrite; dropped"])
  })

  test("an agent without tools inherits; a YAML list, rule patterns, disallowedTools and pinned models convert", () => {
    const open = convertAgent(fixture("agents/open.md"), { plugin: "demo", name: "open", root: "/r" }, settings)
    expect(open.agent.permissions).toEqual([])
    expect(open.agent.request).toBeUndefined()
    const pinned = convertAgent(fixture("agents/pinned.md"), { plugin: "demo", name: "pinned", root: "/r" }, { ...settings, toolNote: false })
    expect(pinned.agent.system).toBe("Run git only.")
    expect(pinned.agent.request?.headers["x-opencode-model-role"]).toBe("strong")
    expect(permissionEffect(pinned.agent.permissions, "shell", "git status")).toBe("allow")
    expect(permissionEffect(pinned.agent.permissions, "shell", "rm x")).toBe("deny")
    expect(permissionEffect(pinned.agent.permissions, "subagent")).toBe("allow")
    expect(permissionEffect(pinned.agent.permissions, "webfetch")).toBe("deny")
    expect(pinned.diagnostics.map((issue) => issue.message)).toEqual(["Pinned model global.anthropic.claude-opus-5-5[1m] mapped to tier strong; no model pinned"])
  })

  test("reports unsupported frontmatter and uses the file name without a name field", () => {
    const result = convertAgent("---\npermissionMode: bypassPermissions\n---\nBody", { plugin: "p", name: "file", root: "/r" }, settings)
    expect(result.agent.id).toBe("p:file")
    expect(result.diagnostics.map((issue) => issue.message)).toEqual(["Unsupported frontmatter: permissionMode"])
  })
})

describe("commands", () => {
  test("expand $ARGUMENTS, positions and indexes literally, and append arguments without a placeholder", () => {
    expect(commandText("Run $ARGUMENTS twice: $ARGUMENTS", "$&; $(touch /bad)")).toBe("Run $&; $(touch /bad) twice: $&; $(touch /bad)")
    expect(commandText("First $1, second $2, third $3.", 'one "two words"')).toBe("First one, second two words, third .")
    expect(commandText("Index $ARGUMENTS[1]", "a b")).toBe("Index b")
    expect(commandText("No placeholder", "arguments")).toBe("No placeholder\n\nARGUMENTS: arguments")
    expect(commandText("No placeholder", "")).toBe("No placeholder")
    expect(commandText("Cost $10", "x")).toBe("Cost $10\n\nARGUMENTS: x")
  })

  test("the fixture command converts with its root and reports allowed-tools", () => {
    const greet = convertCommand(fixture("commands/greet.md"), "demo:greet", "/r")
    expect(greet.command).toEqual({ name: "demo:greet", description: "Fixture command that greets its first argument.", template: "Greet $1 warmly. All arguments: $ARGUMENTS. Plugin root: /r\n" })
    expect(greet.diagnostics).toEqual([])
    expect(convertCommand(fixture("commands/sub/deep.md"), "demo:sub:deep", "/r").diagnostics).toEqual([{ where: "demo:sub:deep", message: "Unsupported frontmatter: allowed-tools" }])
  })
})

describe("skills, MCP and content", () => {
  test("skills keep their path and expand the plugin root in the body", () => {
    const path = join(FIXTURE, "skills/demo-helper/SKILL.md")
    const { skill, diagnostics } = convertSkill(path, "/r")
    expect(String(skill.id)).toBe("demo-helper")
    expect(String(skill.path)).toBe(path)
    expect(skill.description).toBe("Fixture skill: answers with the claude-compat fixture codeword.")
    expect(skill.content).toContain("/r/mcp/echo.mjs")
    expect(diagnostics).toEqual([])
  })

  test("parses stdio and Claude's url type as http", () => {
    const servers = parseClaudeMcp(JSON.parse(fixture(".mcp.json")), ".mcp.json")
    expect(servers.echo).toEqual({ type: "stdio", command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/mcp/echo.mjs"] })
    expect(servers.docs).toEqual({ type: "http", url: "https://example.invalid/mcp" })
    expect(() => parseClaudeMcp({ mcpServers: { bad: { type: "ws", url: "x" } } }, "f")).toThrow("unknown type ws")
  })

  test("reports Claude-only references and inline shell; parses block YAML; rejects non-map frontmatter", () => {
    expect(contentDiagnostics("~/.claude/plugins/x TodoWrite skill://foo !`git diff` ${CLAUDE_SKILL_DIR}", "a")).toHaveLength(5)
    expect(rewriteRoot("${CLAUDE_PLUGIN_ROOT}/x ${OTHER}", "/a b")).toBe("/a b/x ${OTHER}")
    expect(markdown("---\ndescription: |\n  First\n  Second\n---\nBody").fields.description).toBe("First\nSecond\n")
    expect(() => markdown("---\n- nope\n---\nBody")).toThrow("frontmatter must be a map")
  })
})
