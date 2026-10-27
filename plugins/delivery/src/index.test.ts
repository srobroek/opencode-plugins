import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createFakeContext, type FakeContextOptions } from "@srobroek/opencode-lib/testing"
import { AGENT_IDS, hasModelRoles, loadAgents } from "./agents.ts"
import plugin, {
  CLEANUP_ACTION,
  confirmDelivery,
  FAN_OUT_PATH,
  FAN_OUT_SKILL_PATH,
  LAND_ACTION,
  parseOptions,
  SKILL_PATH,
} from "./index.ts"

type Result = { output?: Record<string, unknown>; content: string; metadata: Record<string, unknown> }
type Execute = (input: unknown, context: unknown) => Promise<Result>

const call = { sessionID: "ses_1", agent: "build", messageID: "msg_1", id: "call_1" }

async function load(options: FakeContextOptions = {}) {
  const fake = createFakeContext(options)
  const cleanup = await plugin.setup(fake.context)
  const tool = (name: string) => fake.tools.get(name)?.execute as Execute
  return { fake, cleanup, tool }
}

describe("setup", () => {
  test("registers both tools, the gate, the agents, the verdict hook, fan-out and the skill, and disposes them all", async () => {
    const { fake, cleanup } = await load()
    expect([...fake.tools.keys()]).toEqual([LAND_ACTION, CLEANUP_ACTION])
    expect(fake.hooks("permission")).toEqual(["evaluate"])
    expect(fake.hooks("tool")).toEqual(["execute.after"])
    expect(fake.hooks("session")).toEqual(["context"])
    expect([...fake.agents.keys()].sort()).toEqual([...AGENT_IDS].sort())
    expect(fake.skills.get("delivery-git-workflow")).toMatchObject({ path: SKILL_PATH })
    expect(fake.skills.get("delivery-fan-out")).toMatchObject({ path: FAN_OUT_SKILL_PATH, autoinvoke: false })
    await cleanup?.()
    expect(fake.active()).toBe(0)
    expect(fake.tools.size).toBe(0)
  })

  test("options turn each part off", async () => {
    const { fake } = await load({ options: { confirm: false, agents: false, verdicts: false, fanOut: false } })
    expect(fake.hooks("permission")).toEqual([])
    expect(fake.hooks("tool")).toEqual([])
    expect(fake.hooks("session")).toEqual([])
    expect(fake.agents.size).toBe(0)
  })

  test("tools declare JSON Schema input and output", async () => {
    const { fake } = await load()
    const land = fake.tools.get(LAND_ACTION)
    expect(land?.input).toMatchObject({ type: "object", required: ["pr"] })
    expect(Object.keys((land?.input as { properties: object } | undefined)?.properties ?? {})).toContain("requireApproval")
    expect(land?.output).toMatchObject({ type: "object", required: ["ok"] })
    expect(fake.tools.get(CLEANUP_ACTION)?.output).toMatchObject({ type: "object", required: ["ok"] })
  })

  test("parseOptions defaults", () => {
    expect(parseOptions(undefined)).toEqual({
      confirm: true,
      receiptsDirectory: undefined,
      agents: true,
      models: {},
      fanOut: true,
      verdicts: true,
    })
    expect(parseOptions({ models: { implementer: "a/b#high", operator: false, bad: 1 } }).models).toEqual({
      implementer: "a/b#high",
      operator: false,
    })
  })
})

describe("tools", () => {
  test("delivery_land forwards the abort signal and mirrors the refusal into output and metadata", async () => {
    const dir = mkdtempSync(join(tmpdir(), "delivery-index-"))
    try {
      const { tool, fake } = await load({ directory: dir })
      const controller = new AbortController()
      controller.abort()
      const result = await tool(LAND_ACTION)({ pr: 1 }, { ...call, signal: controller.signal })
      expect(result.output).toMatchObject({ ok: false })
      expect(String(result.output?.reason)).toContain("abort")
      expect(result.metadata).toEqual(result.output as Record<string, unknown>)
      expect(result.content).toStartWith("delivery_land refused:")
      expect(fake.asserts).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("delivery_cleanup refuses outside a repository without asking", async () => {
    const dir = mkdtempSync(join(tmpdir(), "delivery-index-"))
    try {
      const { tool, fake } = await load({ directory: dir })
      const result = await tool(CLEANUP_ACTION)({}, { ...call, signal: new AbortController().signal })
      expect(result.output).toMatchObject({ ok: false })
      expect(String(result.output?.reason)).toContain("repo.key")
      expect(fake.asserts).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("confirmDelivery", () => {
  test("turns an allowed land or cleanup into a prompt and leaves everything else", () => {
    const land = { action: LAND_ACTION, resources: ["o/r#1"], effect: "allow" } as {
      action: string
      resources: string[]
      effect: string
      message?: string
    }
    confirmDelivery(land)
    expect(land.effect).toBe("ask")
    expect(land.message).toContain("o/r#1")
    const cleanup = { action: CLEANUP_ACTION, resources: ["/w"], effect: "allow" }
    confirmDelivery(cleanup)
    expect(cleanup.effect).toBe("ask")
    const denied = { action: LAND_ACTION, resources: [], effect: "deny" }
    confirmDelivery(denied)
    expect(denied.effect).toBe("deny")
    const other = { action: "shell", resources: [], effect: "allow" }
    confirmDelivery(other)
    expect(other.effect).toBe("allow")
  })
})

describe("agents", () => {
  test("each shipped agent is a subagent with a prompt free of omp references", () => {
    for (const file of loadAgents()) {
      expect(file.mode).toBe("subagent")
      expect(file.description).toBeTruthy()
      expect(file.system).not.toMatch(/skill:\/\/|rule:\/\/|agent:\/\/|pr:\/\/|\byield\b|`task`|write <leadId>/)
    }
  })

  test("a created agent takes the file's fields; the model is set only when available", async () => {
    const { fake } = await load()
    const implementer = fake.agents.get("implementer") as Record<string, unknown>
    expect(implementer.mode).toBe("subagent")
    expect(String(implementer.system)).toContain("VERDICT: DONE|BLOCKED|SPLIT")
    expect(implementer.model).toBeUndefined()
    expect(implementer.request).toEqual({ headers: { "x-opencode-model-role": "standard" } })
    expect(implementer.permissions).toContainEqual({ action: "subagent", resource: "researcher", effect: "allow" })
  })

  const withHost = (fake: ReturnType<typeof createFakeContext>, plugins: unknown[]) => {
    const context = fake.context as unknown as Record<string, unknown>
    context.model = {
      list: async () => ({
        data: [{ providerID: "amazon-bedrock", id: "global.anthropic.claude-sonnet-5-5", variants: [{ id: "medium" }] }],
      }),
    }
    context.plugin = { list: async () => ({ data: plugins }) }
    return fake
  }

  test("without model-roles an agent falls back to its file model when available", async () => {
    const fake = withHost(createFakeContext(), [{ id: "srobroek.delivery" }])
    await plugin.setup(fake.context)
    expect(fake.agents.get("implementer")?.model).toEqual({
      providerID: "amazon-bedrock",
      id: "global.anthropic.claude-sonnet-5-5",
      variant: "medium",
    })
  })

  test("with model-roles installed an agent pins no model and keeps only its role header", async () => {
    const fake = withHost(createFakeContext(), [{ id: "srobroek.model-roles" }])
    await plugin.setup(fake.context)
    const implementer = fake.agents.get("implementer") as Record<string, unknown>
    expect(implementer.model).toBeUndefined()
    expect(implementer.request).toEqual({ headers: { "x-opencode-model-role": "standard" } })
  })

  test("an explicit models option still applies with model-roles installed", async () => {
    const fake = withHost(
      createFakeContext({ options: { models: { implementer: "amazon-bedrock/global.anthropic.claude-sonnet-5-5" } } }),
      [{ source: { type: "package", target: "github:srobroek/opencode-plugins#main::path:plugins/model-roles" } }],
    )
    await plugin.setup(fake.context)
    expect(fake.agents.get("implementer")?.model).toEqual({
      providerID: "amazon-bedrock",
      id: "global.anthropic.claude-sonnet-5-5",
    })
  })

  test("hasModelRoles matches the plugin id or its package target", () => {
    expect(hasModelRoles({ data: [{ id: "srobroek.model-roles" }] })).toBe(true)
    expect(hasModelRoles([{ source: { target: "@srobroek/opencode-model-roles" } }])).toBe(true)
    expect(hasModelRoles({ data: [{ id: "srobroek.delivery", source: { target: "x/delivery" } }] })).toBe(false)
    expect(hasModelRoles(undefined)).toBe(false)
  })

  test("an existing agent keeps its own fields and gains the delivery permissions after its own", async () => {
    const own = { action: "shell", resource: "*", effect: "ask" }
    const { fake } = await load({ agents: [{ id: "operator", description: "mine", mode: "all", permissions: [own] }] })
    const operator = fake.agents.get("operator") as Record<string, unknown>
    expect(operator.description).toBe("mine")
    expect(operator.mode).toBe("all")
    expect((operator.permissions as unknown[])[0]).toEqual(own)
  })
})

describe("verdict hook", () => {
  const fire = async (fake: ReturnType<typeof createFakeContext>, agent: string, text: string) =>
    fake.fire.tool("execute.after", {
      tool: "subagent",
      ...call,
      input: { agent, prompt: "x" },
      status: "completed",
      result: {
        output: { sessionID: "ses_child", status: "completed", output: text },
        content: text,
        metadata: { sessionID: "ses_child" } as Record<string, unknown>,
      },
    })

  test("a delivery verdict lands in metadata.delivery", async () => {
    const { fake } = await load()
    const event = await fire(
      fake,
      "shepherd",
      'VERDICT: COMPLETE\n```json\n{"verdict":"COMPLETE","merge_sha":"abc"}\n```',
    )
    expect(event.result.metadata).toEqual({
      sessionID: "ses_child",
      delivery: { verdict: "COMPLETE", agent: "shepherd", fields: { verdict: "COMPLETE", merge_sha: "abc" } },
    })
  })

  test("a malformed delivery reply is marked and noted for the lead", async () => {
    const { fake } = await load()
    const event = await fire(fake, "implementer", "all done")
    expect(event.result.metadata.delivery).toMatchObject({ verdict: "MALFORMED" })
    expect(String(event.result.content)).toContain("Continue sessionID ses_child")
  })

  test("other agents' results are untouched", async () => {
    const { fake } = await load()
    const event = await fire(fake, "explore", "found it")
    expect(event.result.metadata).toEqual({ sessionID: "ses_child" })
  })
})

describe("fan-out instructions", () => {
  const fire = async (
    fake: ReturnType<typeof createFakeContext>,
    sessionID: string,
    agent = "build",
    tools: Record<string, unknown> = { subagent: {} },
  ) =>
    fake.fire.session("context", {
      sessionID,
      agent,
      system: [] as Array<{ type: string; text: string }>,
      messages: [],
      tools,
    })

  test("a primary session gets the static text; a child session and delivery agents do not", async () => {
    const { fake } = await load({ sessions: [{ id: "ses_root" }, { id: "ses_child", parentID: "ses_root" }] })
    const text = readFileSync(FAN_OUT_PATH, "utf8").trim()
    expect((await fire(fake, "ses_root")).system).toEqual([{ type: "text", text }])
    expect((await fire(fake, "ses_root")).system).toEqual([{ type: "text", text }])
    expect((await fire(fake, "ses_child")).system).toEqual([])
    expect((await fire(fake, "ses_root", "implementer")).system).toEqual([])
    expect(text).not.toMatch(/skill:\/\/|rule:\/\/|agent:\/\/|`task`/)
  })

  test("an agent without the subagent tool gets no fan-out text", async () => {
    const { fake } = await load({ sessions: [{ id: "ses_root" }] })
    expect((await fire(fake, "ses_root", "plan", {})).system).toEqual([])
  })

  test("the always-on text stays short and points at the full rules", () => {
    const text = readFileSync(FAN_OUT_PATH, "utf8").trim()
    expect(text.length).toBeLessThanOrEqual(1000)
    expect(text).toContain("`delivery-fan-out` skill")
    expect(readFileSync(FAN_OUT_SKILL_PATH, "utf8")).toContain("FO-7")
  })
})
