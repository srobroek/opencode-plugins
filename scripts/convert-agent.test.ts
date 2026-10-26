import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  buildPermissions,
  convertAgent,
  mapRole,
  mapTools,
  parseArgs,
  parseFrontmatter,
  parseRole,
  type RolesConfig,
  renderAgent,
  reportFormat,
  resolveModel,
  rewriteReferences,
  rolesFragment,
} from "./convert-agent.ts"

const fixture = (name: string) => readFileSync(join(import.meta.dir, "fixtures/omp", `${name}.md`), "utf8")

const roles: RolesConfig = {
  task: { model: "anthropic/claude-sonnet-5-5", variants: ["low", "medium", "high"] },
  slow: ["@missing", "anthropic/claude-opus-5-5#max"],
  plan: "@slow",
  reviewer: "openai/gpt-6.1-sol",
  designer: { model: "anthropic/claude-sonnet-5-5", variants: ["high", "max"] },
}

describe("parseRole", () => {
  test("reads a role and an inline level", () => {
    const warnings: string[] = []
    expect(parseRole("@task", warnings)).toEqual({ role: "task", level: undefined })
    expect(parseRole("@slow:high", warnings)).toEqual({ role: "slow", level: "high" })
    expect(warnings).toEqual([])
  })

  test("keeps the first of several entries and refuses raw selectors", () => {
    const warnings: string[] = []
    expect(parseRole("@task, @slow", warnings)).toEqual({ role: "task", level: undefined })
    expect(parseRole("anthropic/x", warnings)).toEqual({})
    expect(warnings).toHaveLength(2)
  })
})

describe("resolveModel", () => {
  test("appends the thinking level when the model has that variant", () => {
    const warnings: string[] = []
    expect(resolveModel(roles, "task", "high", warnings)).toBe("anthropic/claude-sonnet-5-5#high")
    expect(warnings).toEqual([])
  })

  test("drops an unknown variant with a warning", () => {
    const warnings: string[] = []
    expect(resolveModel(roles, "task", "xhigh", warnings)).toBe("anthropic/claude-sonnet-5-5")
    expect(warnings[0]).toContain("no variant xhigh")
  })

  test("maps xhigh to max when only max exists", () => {
    expect(resolveModel(roles, "designer", "xhigh", [])).toBe("anthropic/claude-sonnet-5-5#max")
  })

  test("drops the level when the roles file lists no variants", () => {
    const warnings: string[] = []
    expect(resolveModel(roles, "reviewer", "high", warnings)).toBe("openai/gpt-6.1-sol")
    expect(warnings[0]).toContain("lists no variants")
  })

  test("follows @role chains and keeps a pinned variant", () => {
    const warnings: string[] = []
    expect(resolveModel(roles, "plan", "high", warnings)).toBe("anthropic/claude-opus-5-5#max")
    expect(warnings[0]).toContain("pins variant #max")
  })

  test("omits the model for an unknown or cyclic role", () => {
    const warnings: string[] = []
    expect(resolveModel({ a: "@b", b: "@a" }, "a", undefined, warnings)).toBeUndefined()
    expect(resolveModel(roles, "nope", undefined, warnings)).toBeUndefined()
    expect(warnings).toHaveLength(2)
  })
})

describe("mapTools", () => {
  test("maps omp names onto V2 actions and drops the rest", () => {
    const warnings: string[] = []
    const actions = mapTools("read, grep, find, bash, write, ast_edit, task, lsp, delivery_land", warnings)
    expect([...actions].sort()).toEqual(["edit", "glob", "grep", "read", "shell", "subagent"])
    expect(warnings).toEqual([
      "tools: lsp has no V2 tool; dropped",
      "tools: delivery_land is not a known omp builtin; left to its plugin's permission",
    ])
  })

  test("read plus web_search grants webfetch; web_search alone does not", () => {
    expect(mapTools("read, web_search", []).has("webfetch")).toBe(true)
    expect(mapTools("web_search", []).has("webfetch")).toBe(false)
  })
})

describe("buildPermissions", () => {
  test("denies unlisted managed actions and inherits listed ones", () => {
    expect(buildPermissions("read, grep, glob, bash", undefined, [])).toEqual([
      { action: "edit", resource: "*", effect: "deny" },
      { action: "webfetch", resource: "*", effect: "deny" },
      { action: "websearch", resource: "*", effect: "deny" },
      { action: "subagent", resource: "*", effect: "deny" },
    ])
  })

  test("allowListed emits explicit allows in action order", () => {
    const rules = buildPermissions("read, edit", undefined, [], true)
    expect(rules.slice(0, 2)).toEqual([
      { action: "read", resource: "*", effect: "allow" },
      { action: "glob", resource: "*", effect: "deny" },
    ])
  })

  test("spawns deny every subagent then allow each mapped id", () => {
    const warnings: string[] = []
    const rules = buildPermissions("read", "scout, operator, scout", warnings)
    expect(rules.filter((rule) => rule.action === "subagent")).toEqual([
      { action: "subagent", resource: "*", effect: "deny" },
      { action: "subagent", resource: "explore", effect: "allow" },
      { action: "subagent", resource: "operator", effect: "allow" },
    ])
    expect(warnings[0]).toContain("subagent_depth")
  })

  test("an agent without tools only gets subagent rules", () => {
    expect(buildPermissions(undefined, "scout", [])).toEqual([
      { action: "subagent", resource: "*", effect: "deny" },
      { action: "subagent", resource: "explore", effect: "allow" },
    ])
  })
})

describe("reportFormat", () => {
  test("renders the VERDICT line, a JSON skeleton and the field list", () => {
    const output = {
      properties: { verdict: { enum: ["DONE", "BLOCKED"] }, answer: { type: "string" } },
      optionalProperties: {
        tags: { metadata: { description: "Labels" }, elements: { type: "string" } },
        count: { type: "uint32" },
      },
    }
    const text = reportFormat(output, []) ?? ""
    expect(text).toContain("```text\nVERDICT: DONE|BLOCKED\n```")
    const json = /```json\n([\s\S]*?)\n```/.exec(text)?.[1] ?? ""
    expect(JSON.parse(json)).toEqual({ verdict: "DONE | BLOCKED", answer: "string", tags: ["string"], count: 0 })
    expect(text).toContain("- `answer` (required, string)")
    expect(text).toContain("- `tags` (optional, array of string): Labels")
    expect(text).toContain("- `count` (optional, number)")
  })

  test("warns when there is no verdict enum and skips without a schema", () => {
    const warnings: string[] = []
    expect(reportFormat({ properties: { x: { type: "string" } } }, warnings)).not.toContain("VERDICT:")
    expect(warnings).toHaveLength(1)
    expect(reportFormat(undefined, warnings)).toBeUndefined()
  })
})

describe("rewriteReferences", () => {
  test("turns omp URIs into plain names and flags the rest", () => {
    const warnings: string[] = []
    const out = rewriteReferences(
      "Load `skill://ui-review` and `skill://ui-review`, apply rule://no-slop, write agent://<leadId>, read `pr://1/diff` and https://x.dev/a.",
      warnings,
    )
    expect(out).toBe(
      "Load `ui-review` and `ui-review`, apply no-slop, write <leadId>, read `pr://1/diff` and https://x.dev/a.",
    )
    expect(warnings).toEqual([
      "body: skill://ui-review rewritten to a plain name (2x)",
      "body: rule://no-slop rewritten to a plain name",
      "body: agent://<leadId> rewritten to a plain name",
      "body: pr://1/diff is an omp-only URI with no V2 resolver; left as is",
    ])
  })

  test("keeps the scheme word for a bare scheme", () => {
    expect(rewriteReferences("a `skill://` b", [])).toBe("a `skill` b")
  })
})

describe("convertAgent", () => {
  test("implementer: role model, spawns, report format, roles fragment", () => {
    const agent = convertAgent(fixture("implementer"), { roles })
    expect(agent.id).toBe("implementer")
    expect(agent.role).toBe("task")
    expect(agent.frontmatter.model).toBe("anthropic/claude-sonnet-5-5#medium")
    expect(agent.frontmatter.mode).toBe("subagent")
    expect(agent.frontmatter.permissions.map((rule) => `${rule.action}:${rule.resource}:${rule.effect}`)).toEqual([
      "webfetch:*:deny",
      "websearch:*:deny",
      "subagent:*:deny",
      "subagent:explore:allow",
      "subagent:operator:allow",
      "subagent:researcher:allow",
    ])
    expect(agent.body).toContain("## Report format")
    expect(agent.body).toContain("VERDICT: DONE|BLOCKED|SPLIT")
    expect(agent.body).not.toContain("rule://")
    expect(agent.body).not.toContain("agent://")
    expect(rolesFragment([agent])).toEqual({ agents: { implementer: "task" } })
  })

  test("pr-reviewer: read-only, no variant, no report section", () => {
    const agent = convertAgent(fixture("pr-reviewer"), { roles })
    expect(agent.frontmatter.model).toBe("openai/gpt-6.1-sol")
    const denied = agent.frontmatter.permissions.filter((rule) => rule.effect === "deny").map((rule) => rule.action)
    expect(denied).toEqual(["glob", "grep", "edit", "shell", "webfetch", "websearch", "subagent"])
    expect(agent.body).not.toContain("## Report format")
  })

  test("ui-ux-specialist: warns about dropped keys and tools", () => {
    const agent = convertAgent(fixture("ui-ux-specialist"), { roles, mode: "all" })
    expect(agent.frontmatter.model).toBe("anthropic/claude-sonnet-5-5#high")
    expect(agent.frontmatter.mode).toBe("all")
    expect(agent.warnings).toContain(
      "autoloadSkills: dropped (no V2 equivalent; load the skills from the prompt instead): design-system-audit, ui-review, design-prototype",
    )
    expect(agent.warnings).toContain("tools: eval has no V2 tool; dropped")
    const subagents = agent.frontmatter.permissions.filter((rule) => rule.action === "subagent")
    expect(subagents.map((rule) => rule.resource)).toEqual([
      "*",
      "design-critic",
      "a11y-auditor",
      "explore",
      "researcher",
      "operator",
    ])
  })

  test("rendered frontmatter only uses V2-native keys and round-trips", () => {
    for (const name of ["architect", "implementer", "pr-reviewer", "ui-ux-specialist"]) {
      const agent = convertAgent(fixture(name), { roles })
      const { data, body } = parseFrontmatter(renderAgent(agent))
      expect(Object.keys(data).every((key) => ["description", "mode", "model", "request", "permissions"].includes(key))).toBe(
        true,
      )
      expect(data).toEqual({ ...agent.frontmatter })
      expect(body.trim()).toBe(agent.body.trim())
    }
  })

  test("writes the role header and, without a roles file, no model", () => {
    const agent = convertAgent(fixture("implementer"), {})
    expect(agent.frontmatter.model).toBeUndefined()
    expect(agent.frontmatter.request).toEqual({ headers: { "x-opencode-model-role": "task" } })
    expect(agent.warnings).toContain("thinking-level: medium dropped; the task role picks the variant")
    const rendered = renderAgent(agent)
    expect(rendered).toContain("request:\n  headers:\n    x-opencode-model-role: task\n")
    expect(rendered).not.toContain("model:")
  })

  test("renames roles through the role map and refuses unknown roles", () => {
    const architect = convertAgent(fixture("architect"), { roleMap: { plan: "architect" } })
    expect(architect.role).toBe("architect")
    expect(architect.frontmatter.request?.headers["x-opencode-model-role"]).toBe("architect")
    const warnings: string[] = []
    expect(mapRole("scout", undefined, warnings)).toBeUndefined()
    expect(mapRole("task", { task: "nope" }, warnings)).toBeUndefined()
    expect(warnings).toHaveLength(2)
    const unknown = convertAgent(fixture("implementer"), { roleMap: { task: "worker" } })
    expect(unknown.frontmatter.request).toBeUndefined()
    expect(rolesFragment([unknown])).toEqual({ agents: {} })
  })

  test("requires a name or an id", () => {
    expect(() => convertAgent("---\ndescription: x\n---\nbody", { roles })).toThrow()
    expect(convertAgent("---\ndescription: x\n---\nbody", { roles, id: "x" }).id).toBe("x")
  })
})

describe("parseArgs", () => {
  test("parses flags and files", () => {
    expect(parseArgs(["--roles", "r.json", "--out", "o", "--allow-listed", "a.md", "b.md"])).toEqual({
      roles: "r.json",
      out: "o",
      mode: "subagent",
      allowListed: true,
      files: ["a.md", "b.md"],
    })
  })

  test("rejects missing arguments and unknown flags", () => {
    expect(parseArgs(["--roles", "r", "--out", "o", "--fragment", "f.json", "a.md"]).fragment).toBe("f.json")
    expect(() => parseArgs(["a.md"])).toThrow("usage")
    expect(parseArgs(["--out", "o", "--role-map", "m.json", "a.md"])).toMatchObject({ roleMap: "m.json", out: "o" })
    expect(() => parseArgs(["--roles", "r", "--out", "o", "--nope", "a.md"])).toThrow("unknown flag")
    expect(() => parseArgs(["--roles", "r", "--out", "o", "--mode", "x", "a.md"])).toThrow("bad --mode")
  })
})
