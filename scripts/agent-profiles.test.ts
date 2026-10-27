import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { DEFAULT_LEAN_AGENTS } from "../plugins/agent-efficiency/src/lean.ts"
import { type AgentPermission, permissionEffect } from "../plugins/lib/src/agent-files.ts"

const PLUGINS = path.join(import.meta.dir, "..", "plugins")
const ROUTER_ROW = /^\|.*\|\s*`([\w-]+)`\s*\|\s*$/
const UPSTREAM_ROW = /^\|\s*(`[^|]*)\|/

type Profile = {
  hidden: boolean
  /** The Code Mode tools the prompt calls, which are the only reason to allow `execute`. */
  codeMode: readonly string[]
  web: boolean
}

/** The lean profile of every shipped agent, by id. A new agent must be added here. */
const PROFILES: Readonly<Record<string, Profile>> = {
  coder: { hidden: false, codeMode: ["dep_scan", "dep_apply", "version_gap_scan"], web: true },
  mechanic: { hidden: false, codeMode: [], web: false },
  researcher: { hidden: false, codeMode: ["repomix_pack"], web: true },
  "adversarial-challenger": { hidden: false, codeMode: [], web: true },
  "code-reviewer": { hidden: false, codeMode: [], web: false },
  "pr-reviewer": { hidden: true, codeMode: [], web: false },
  "security-reviewer": { hidden: false, codeMode: [], web: false },
  seance: { hidden: false, codeMode: ["seance_read"], web: false },
  architect: { hidden: false, codeMode: [], web: true },
  "external-repo-worker": { hidden: false, codeMode: ["repomix_pack"], web: true },
  implementer: { hidden: true, codeMode: [], web: false },
  "implementer-high": { hidden: true, codeMode: [], web: false },
  operator: { hidden: true, codeMode: [], web: false },
  shepherd: { hidden: true, codeMode: ["delivery_land", "delivery_cleanup"], web: false },
  "a11y-auditor": { hidden: false, codeMode: ["browser", "design_impeccable_scan"], web: true },
  "design-critic": { hidden: false, codeMode: ["browser", "design_impeccable_scan"], web: true },
  "ui-implementer": { hidden: false, codeMode: ["browser", "design_impeccable_scan"], web: false },
  "ui-ux-specialist": { hidden: false, codeMode: ["browser", "design_impeccable_scan"], web: true },
  "journey-scribe": { hidden: true, codeMode: ["journeys_index"], web: false },
  "journey-validator": { hidden: true, codeMode: ["browser"], web: false },
  "speckit-sync": { hidden: true, codeMode: [], web: false },
  "speckit-verify": { hidden: true, codeMode: [], web: false },
}

/** Agents that keep a denylist: journey-validator drives the product through MCP tools named per project. */
const DENYLIST = new Set(["journey-validator"])

/** Agents that change state without the edit tool. */
const WRITERS = new Set(["shepherd"])

type Agent = { plugin: string; id: string; hidden: boolean; rules: AgentPermission[] }

function agents(): Agent[] {
  return [...new Bun.Glob("*/agents/*.md").scanSync(PLUGINS)].sort().map((file) => {
    const text = readFileSync(path.join(PLUGINS, file), "utf8")
    const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? ""
    const data = (Bun.YAML.parse(front) ?? {}) as { hidden?: boolean; permissions?: AgentPermission[] }
    const [plugin = "", , name = ""] = file.split("/")
    return { plugin, id: name.replace(/\.md$/, ""), hidden: data.hidden === true, rules: data.permissions ?? [] }
  })
}

const skillFiles = () => [...new Bun.Glob("*/skills/*/SKILL.md").scanSync(PLUGINS)]
const shipped = new Set(skillFiles().map((file) => file.split("/")[2] as string))

/** Upstream skills the design-upstream-preflight table routes to; design agents may allow them. */
const upstream = new Set(
  readFileSync(path.join(PLUGINS, "design/skills/design-upstream-preflight/SKILL.md"), "utf8")
    .split("\n")
    .flatMap((line) => [...(UPSTREAM_ROW.exec(line)?.[1] ?? "").matchAll(/`([\w-]+)`/g)].map((match) => match[1] as string)),
)
const known = [...shipped, ...upstream]

const routerOf = new Map<string, string>()
for (const file of skillFiles()) {
  const text = readFileSync(path.join(PLUGINS, file), "utf8")
  if (!text.includes("| Load skill |")) continue
  for (const line of text.split("\n")) {
    const member = ROUTER_ROW.exec(line)?.[1]
    if (member !== undefined) routerOf.set(member, file.split("/")[2] as string)
  }
}

const allows = (agent: Agent, action: string, resource = "*") => permissionEffect(agent.rules, action, resource) === "allow"

test("the upstream table and the routers parse", () => {
  expect(upstream.has("impeccable")).toBe(true)
  expect(upstream.has("accessibility")).toBe(true)
  expect(routerOf.get("lang-rust-quality")).toBe("lang-rust")
})

test("every shipped agent has a profile", () => {
  for (const agent of agents()) expect({ id: agent.id, profiled: agent.id in PROFILES }).toEqual({ id: agent.id, profiled: true })
})

test("an agent's skill rules are family patterns or ids that exist, never a blanket allow", () => {
  for (const agent of agents()) {
    for (const rule of agent.rules.filter((rule) => rule.action === "skill" && rule.effect === "allow")) {
      const { resource } = rule
      const pattern = resource.endsWith("*")
      const prefix = pattern ? resource.slice(0, -1) : resource
      const valid = prefix.length > 0 && !prefix.includes("*")
      const matches = pattern ? known.some((id) => id.startsWith(prefix)) : known.includes(resource)
      expect({ agent: agent.id, resource, valid, matches }).toEqual({ agent: agent.id, resource, valid: true, matches: true })
    }
    expect({ agent: agent.id, unknown: permissionEffect(agent.rules, "skill", "not-a-shipped-skill") }).toEqual({
      agent: agent.id,
      unknown: "deny",
    })
  }
})

test("an agent that may load a router member may load its router", () => {
  for (const agent of agents()) {
    for (const [member, router] of routerOf) {
      if (!allows(agent, "skill", member)) continue
      expect({ agent: agent.id, member, router, allowed: allows(agent, "skill", router) }).toEqual({
        agent: agent.id,
        member,
        router,
        allowed: true,
      })
    }
  }
})

test("execute, web access and hidden match each agent's profile", () => {
  for (const agent of agents()) {
    const profile = PROFILES[agent.id] as Profile
    expect({ id: agent.id, hidden: agent.hidden }).toEqual({ id: agent.id, hidden: profile.hidden })
    if (DENYLIST.has(agent.id)) {
      for (const action of ["webfetch", "websearch", "skill"]) expect(permissionEffect(agent.rules, action)).toBe("deny")
      continue
    }
    expect({ id: agent.id, first: agent.rules[0] }).toEqual({ id: agent.id, first: { action: "*", resource: "*", effect: "deny" } })
    expect({ id: agent.id, execute: allows(agent, "execute") }).toEqual({ id: agent.id, execute: profile.codeMode.length > 0 })
    for (const tool of profile.codeMode) expect({ id: agent.id, tool, allowed: allows(agent, tool) }).toEqual({ id: agent.id, tool, allowed: true })
    const web = allows(agent, "webfetch") || allows(agent, "websearch")
    expect({ id: agent.id, web }).toEqual({ id: agent.id, web: profile.web })
  }
})

test("read-only agents get the lean subagent prompt by default", () => {
  for (const agent of agents()) {
    if (DENYLIST.has(agent.id) || WRITERS.has(agent.id) || allows(agent, "edit")) continue
    expect({ id: agent.id, lean: DEFAULT_LEAN_AGENTS.includes(agent.id) }).toEqual({ id: agent.id, lean: true })
  }
})

test("a fallback copy of an agent keeps its owner's profile", () => {
  const byId = Map.groupBy(agents(), (agent) => agent.id)
  for (const [id, copies] of byId) {
    const [owner, ...rest] = copies
    for (const copy of rest)
      expect({ id, plugin: copy.plugin, hidden: copy.hidden, rules: copy.rules }).toEqual({
        id,
        plugin: copy.plugin,
        hidden: owner?.hidden ?? false,
        rules: owner?.rules ?? [],
      })
  }
})
