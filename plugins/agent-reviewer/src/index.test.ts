import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { type AgentFile, type AgentPermission, permissionEffect, readAgentFile } from "@srobroek/opencode-lib/agent-files"
import { fragmentParts, readFragment } from "@srobroek/opencode-lib/fragments"
import { createFakeContext } from "@srobroek/opencode-lib/testing"
import { loadAgents } from "../../delivery/src/agents.ts"
import delivery from "../../delivery/src/index.ts"
import { parseVerdict } from "../../delivery/src/verdict.ts"
import quality from "../../quality/src/index.ts"
import plugin, { AGENTS_DIR, REVIEWERS } from "./index.ts"

const files = new Map<string, AgentFile>(REVIEWERS.map((id) => [id, readAgentFile(join(AGENTS_DIR, `${id}.md`))]))
const file = (id: string) => files.get(id) as AgentFile
const core = [...fragmentParts("review-core", readFragment("review-core")).values()]

type Fake = ReturnType<typeof createFakeContext>
const withPlugins = (fake: Fake, plugins: unknown[]) => {
  ;(fake.context as unknown as Record<string, unknown>).plugin = { list: async () => ({ data: plugins }) }
  return fake
}
const rules = (fake: Fake, id: string) => fake.agents.get(id)?.permissions as AgentPermission[]

describe("agent-reviewer", () => {
  test("registers the four reviewers on the reviewer tier and the hidden skill, and disposes them", async () => {
    const fake = createFakeContext()
    const cleanup = await plugin.setup(fake.context)
    expect([...fake.agents.keys()].sort()).toEqual([...REVIEWERS])
    for (const id of REVIEWERS) {
      expect(fake.agents.get(id)).toMatchObject({ mode: "subagent", request: { headers: { "x-opencode-model-role": "reviewer" } } })
      expect(fake.agents.get(id)?.model).toBeUndefined()
    }
    expect(fake.skills.get("review-security")).toMatchObject({ autoinvoke: false })
    await cleanup?.()
    expect(fake.active()).toBe(0)
  })

  test("only pr-reviewer is hidden; the others stay in the subagent catalog", async () => {
    const fake = createFakeContext()
    await plugin.setup(fake.context)
    expect(fake.agents.get("pr-reviewer")?.hidden).toBe(true)
    for (const id of ["code-reviewer", "security-reviewer", "adversarial-challenger"]) expect(fake.agents.get(id)?.hidden).toBeUndefined()
  })

  test("every reviewer composes the whole review core and names its verdict line", () => {
    for (const id of REVIEWERS) {
      for (const part of core) expect(file(id).system).toContain(part)
      expect(file(id).system).not.toContain("{{include")
      expect(file(id).system).toMatch(/First line: `VERDICT: [A-Z|-]+ --/)
    }
  })

  test("no reviewer can edit, spawn, ask the user, run Code Mode or load any skill not named", async () => {
    const fake = createFakeContext()
    await plugin.setup(fake.context)
    for (const id of REVIEWERS) {
      for (const action of ["edit", "write", "subagent", "question", "execute", "some_plugin_tool"])
        expect(permissionEffect(rules(fake, id), action)).toBe("deny")
      expect(permissionEffect(rules(fake, id), "skill", "any-skill")).toBe("deny")
    }
  })

  test("pr-reviewer runs only its two gh reads", async () => {
    const fake = createFakeContext()
    await plugin.setup(fake.context)
    const pr = rules(fake, "pr-reviewer")
    expect(permissionEffect(pr, "shell", "gh pr view 7 --repo o/r --json title")).toBe("allow")
    expect(permissionEffect(pr, "shell", "gh pr diff 7 --repo o/r")).toBe("allow")
    for (const command of ["gh api repos/o/r", "git diff", "cat x"]) expect(permissionEffect(pr, "shell", command)).toBe("deny")
    for (const action of ["read", "grep", "webfetch"]) expect(permissionEffect(pr, action)).toBe("deny")
    for (const skill of ["quality-code-design", "review-security"]) expect(permissionEffect(pr, "skill", skill)).toBe("allow")
  })

  test("code-reviewer runs only git diff, log and show, and never writes their output", async () => {
    const fake = createFakeContext()
    await plugin.setup(fake.context)
    const code = rules(fake, "code-reviewer")
    for (const command of ["git diff", "git diff main...HEAD", "git log --oneline -5", "git show HEAD", "git show"])
      expect(permissionEffect(code, "shell", command)).toBe("allow")
    for (const command of [
      "git diff --output=x",
      "git log -p --output x",
      "git status",
      "git commit -m x",
      "rm -rf .",
      "gh pr diff 1",
    ])
      expect(permissionEffect(code, "shell", command)).toBe("deny")
    for (const action of ["read", "grep", "glob", "lsp_diagnostics"]) expect(permissionEffect(code, action)).toBe("allow")
    for (const action of ["webfetch", "websearch"]) expect(permissionEffect(code, action)).toBe("deny")
    expect(permissionEffect(code, "skill", "ast-grep-search")).toBe("allow")
  })

  test("security-reviewer reads code only: no shell, no web", async () => {
    const fake = createFakeContext()
    await plugin.setup(fake.context)
    const security = rules(fake, "security-reviewer")
    for (const action of ["read", "grep", "glob", "lsp_hover"]) expect(permissionEffect(security, action)).toBe("allow")
    for (const action of ["shell", "webfetch", "websearch"]) expect(permissionEffect(security, action)).toBe("deny")
    expect(permissionEffect(security, "skill", "review-security")).toBe("allow")
    expect(permissionEffect(security, "skill", "ast-grep-search")).toBe("allow")
    expect(permissionEffect(security, "read", ".env")).toBe("ask")
    expect(file("security-reviewer").system).toContain("CWE id")
    expect(file("security-reviewer").system).toContain("VERDICT: PASS|MINOR|MAJOR")
  })

  test("adversarial-challenger keeps web reads for cited sources and drops shell", async () => {
    const fake = createFakeContext()
    await plugin.setup(fake.context)
    const challenger = rules(fake, "adversarial-challenger")
    for (const action of ["read", "grep", "glob", "lsp_hover", "webfetch", "websearch"])
      expect(permissionEffect(challenger, action)).toBe("allow")
    expect(permissionEffect(challenger, "shell")).toBe("deny")
  })

  test("delivery parses the pr-reviewer and code-reviewer verdict lines", () => {
    expect(parseVerdict("VERDICT: REQUEST-CHANGES -- a.ts:3 drops the error", "pr-reviewer")).toMatchObject({
      verdict: "REQUEST-CHANGES",
    })
    expect(file("pr-reviewer").system).toContain("`VERDICT: APPROVE|REQUEST-CHANGES|COMMENT --")
    expect(file("code-reviewer").system).toContain("`VERDICT: APPROVE|REQUEST-CHANGES|COMMENT --")
  })
})

type Fallback = { id: string; owner: { setup: typeof delivery.setup }; ownerName: string }
const FALLBACKS: Fallback[] = [
  { id: "pr-reviewer", owner: delivery, ownerName: "srobroek.delivery" },
  { id: "adversarial-challenger", owner: quality, ownerName: "srobroek.quality" },
]

describe.each(FALLBACKS)("$ownerName fallback $id", ({ id, owner, ownerName }) => {
  const expectOne = (fake: Fake) => {
    const agent = fake.agents.get(id) as Record<string, unknown>
    expect(agent.system).toBe(file(id).system)
    expect(agent.permissions).toEqual(file(id).permissions)
    expect(agent.model).toBeUndefined()
    expect(agent.request).toEqual(file(id).request)
    expect(agent.hidden).toBe(file(id).hidden)
  }

  test("the fallback copy alone registers the agent with the same prompt", async () => {
    const fake = createFakeContext()
    await owner.setup(fake.context)
    expect(fake.agents.get(id)?.system).toBe(file(id).system)
    expect(fake.agents.get(id)?.permissions).toEqual(file(id).permissions)
  })

  test("agent-reviewer then the fallback: the fallback leaves the agent alone", async () => {
    const fake = createFakeContext()
    await plugin.setup(fake.context)
    await owner.setup(fake.context)
    expectOne(fake)
    expect(fake.agentUpdates.filter((update) => update === id)).toHaveLength(1)
  })

  test("the fallback then agent-reviewer, reported by plugin.list: the fallback skips its copy", async () => {
    const fake = withPlugins(createFakeContext(), [{ id: ownerName }, { id: "srobroek.agent-reviewer" }])
    await owner.setup(fake.context)
    expect(fake.agents.has(id)).toBe(false)
    await plugin.setup(fake.context)
    expectOne(fake)
  })

  test("the fallback then agent-reviewer, unseen by plugin.list: agent-reviewer replaces the copy", async () => {
    const fake = withPlugins(createFakeContext(), [{ id: ownerName }])
    ;(fake.context as unknown as Record<string, unknown>).model = {
      list: async () => ({
        data: [{ providerID: "amazon-bedrock", id: "global.anthropic.claude-opus-5-5", variants: [{ id: "high" }] }],
      }),
    }
    await owner.setup(fake.context)
    expect(fake.agents.has(id)).toBe(true)
    const copy = fake.agents.get(id) as { request?: { headers?: Record<string, string> } } | undefined
    if (id === "pr-reviewer") expect(copy?.request?.headers?.["x-opencode-model-fallback"]).toBeDefined()
    await plugin.setup(fake.context)
    expectOne(fake)
  })
})

test("delivery's pr-reviewer copy differs from the owner's only by its fallback model", () => {
  const copy = loadAgents(["pr-reviewer"])[0]
  const own = file("pr-reviewer")
  expect(copy?.model).toBe("amazon-bedrock/global.anthropic.claude-opus-5-5#high")
  expect(copy?.description).toBe(own.description)
  expect(copy?.system).toBe(own.system)
  expect(copy?.permissions).toEqual(own.permissions)
  expect(copy?.request).toEqual(own.request)
  expect(copy?.hidden).toBe(true)
})

test("quality's challenger copy is the owner's file", () => {
  const copy = readAgentFile(join(AGENTS_DIR, "../../quality/agents/adversarial-challenger.md"))
  expect(copy).toEqual(file("adversarial-challenger"))
})
