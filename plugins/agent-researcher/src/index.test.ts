import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { applyOwnedAgent, isCopyOf } from "@srobroek/opencode-lib/agent-fallback"
import { type AgentPermission, permissionEffect, readAgentFile } from "@srobroek/opencode-lib/agent-files"
import { createFakeContext } from "@srobroek/opencode-lib/testing"
import { decideRouting } from "../../beads/src/subagent-routing.ts"
import { loadAgents } from "../../delivery/src/agents.ts"
import delivery from "../../delivery/src/index.ts"
import plugin, { AGENTS_DIR, RESEARCHER } from "./index.ts"

const file = readAgentFile(join(AGENTS_DIR, `${RESEARCHER}.md`))

const withPlugins = (fake: ReturnType<typeof createFakeContext>, plugins: unknown[]) => {
  ;(fake.context as unknown as Record<string, unknown>).plugin = { list: async () => ({ data: plugins }) }
  return fake
}

describe("researcher agent", () => {
  test("registers researcher and disposes it", async () => {
    const fake = createFakeContext()
    const cleanup = await plugin.setup(fake.context)
    expect(fake.skills.size).toBe(0)
    expect(fake.agents.get(RESEARCHER)).toMatchObject({
      mode: "subagent",
      request: { headers: { "x-opencode-model-role": "standard" } },
    })
    expect(fake.agents.get(RESEARCHER)?.model).toBeUndefined()
    await cleanup?.()
    expect(fake.active()).toBe(0)
  })

  test("allows web and code reads and only explore as a child", async () => {
    const fake = createFakeContext()
    await plugin.setup(fake.context)
    const rules = fake.agents.get(RESEARCHER)?.permissions as AgentPermission[]
    for (const action of ["read", "grep", "glob", "execute", "lsp_hover", "webfetch", "websearch", "shell", "skill", "repomix_pack"])
      expect(permissionEffect(rules, action)).toBe("allow")
    for (const action of ["edit", "write", "question", "some_plugin_tool"]) expect(permissionEffect(rules, action)).toBe("deny")
    expect(permissionEffect(rules, "subagent", "explore")).toBe("allow")
    for (const child of ["general", "implementer", "researcher"]) expect(permissionEffect(rules, "subagent", child)).toBe("deny")
    expect(permissionEffect(rules, "external_directory")).toBe("ask")
  })

  test("the prompt is bead-aware but not bead-only", () => {
    expect(file.system).toContain('bd comment ID "FINDING"')
    expect(file.system).toContain("If it names no bead, the brief's question is the scope")
    expect(file.system).toContain("VERDICT: DONE|BLOCKED")
  })

  test("beads routing (FO-5) admits researcher for an execution_agent_type=researcher bead", () => {
    const bead = [{ id: "repo-abc", agentType: RESEARCHER }]
    expect(decideRouting(RESEARCHER, bead).kind).toBe("allow")
    expect(decideRouting(`researcher:${RESEARCHER}`, bead).kind).toBe("allow")
    expect(decideRouting("general", bead).kind).toBe("block")
  })
})

describe("delivery fallback", () => {
  test("delivery's researcher is the same agent apart from its fallback model", () => {
    const copy = loadAgents(["researcher"])[0]
    expect(copy?.description).toBe(file.description)
    expect(copy?.system).toBe(file.system)
    expect(copy?.permissions).toEqual(file.permissions)
    expect(copy?.request).toEqual(file.request)
  })

  test("delivery alone registers researcher", async () => {
    const fake = createFakeContext()
    await delivery.setup(fake.context)
    expect(fake.agents.get(RESEARCHER)?.system).toBe(file.system)
  })

  const expectOne = (fake: ReturnType<typeof createFakeContext>) => {
    const agent = fake.agents.get(RESEARCHER) as Record<string, unknown>
    expect(agent.system).toBe(file.system)
    expect(agent.permissions).toEqual(file.permissions)
    expect(agent.model).toBeUndefined()
    expect(agent.request).toEqual(file.request)
  }

  test("researcher then delivery: delivery leaves the registered agent alone", async () => {
    const fake = createFakeContext()
    await plugin.setup(fake.context)
    await delivery.setup(fake.context)
    expectOne(fake)
    expect(fake.agentUpdates.filter((id) => id === RESEARCHER)).toHaveLength(1)
  })

  test("delivery then researcher, with plugin.list reporting agent-researcher: delivery skips its copy", async () => {
    const fake = withPlugins(createFakeContext(), [{ id: "srobroek.delivery" }, { id: "srobroek.agent-researcher" }])
    await delivery.setup(fake.context)
    expect(fake.agents.has(RESEARCHER)).toBe(false)
    await plugin.setup(fake.context)
    expectOne(fake)
  })

  test("delivery then researcher, unseen by plugin.list: researcher replaces the copy", async () => {
    const fake = withPlugins(createFakeContext(), [{ id: "srobroek.delivery" }])
    const context = fake.context as unknown as Record<string, unknown>
    context.model = {
      list: async () => ({
        data: [{ providerID: "amazon-bedrock", id: "global.anthropic.claude-sonnet-5-5", variants: [{ id: "medium" }] }],
      }),
    }
    await delivery.setup(fake.context)
    expect(fake.agents.get(RESEARCHER)?.model).toBeDefined()
    await plugin.setup(fake.context)
    expectOne(fake)
  })

  test("another plugin's researcher keeps its fields and gains these permissions after its own", () => {
    const own: AgentPermission = { action: "edit", resource: "*", effect: "allow" }
    const draft = { system: "mine", permissions: [own] }
    expect(isCopyOf(draft, file)).toBe(false)
    applyOwnedAgent(draft, file, { ...draft })
    expect(draft.system).toBe("mine")
    expect(draft.permissions[0]).toEqual(own)
    expect(draft.permissions.slice(1)).toEqual(file.permissions)
  })
})
