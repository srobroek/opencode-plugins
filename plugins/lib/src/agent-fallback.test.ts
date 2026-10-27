import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  applyOwnedAgent,
  isCopyOf,
  keepFallback,
  listPlugins,
  listsPlugin,
  ownedElsewhere,
  registerFallbackAgents,
} from "./agent-fallback.ts"
import type { AgentFile } from "./agent-files.ts"
import { createFakeContext } from "./testing.ts"

const file: AgentFile = {
  id: "researcher",
  mode: "subagent",
  request: { headers: { "x-opencode-model-role": "standard" } },
  permissions: [{ action: "read", resource: "*", effect: "allow" }],
  system: "prompt",
}
const owners = { researcher: "agent-researcher" }

describe("listsPlugin", () => {
  test("matches the srobroek id or a package target", () => {
    expect(listsPlugin({ data: [{ id: "srobroek.agent-researcher" }] }, "agent-researcher")).toBe(true)
    expect(listsPlugin([{ source: { target: "github:o/r#main::path:plugins/agent-researcher" } }], "agent-researcher")).toBe(true)
    expect(listsPlugin([{ source: { target: "@srobroek/opencode-agent-researcher" } }], "agent-researcher")).toBe(true)
    expect(listsPlugin([{ source: { target: "@srobroek/opencode-model-roles" } }], "model-roles")).toBe(true)
    expect(listsPlugin([{ source: { type: "local", path: "/x/plugins/agent-researcher/index.js" } }], "agent-researcher")).toBe(true)
    expect(listsPlugin({ data: [{ id: "srobroek.delivery", source: { target: "x/delivery" } }] }, "agent-researcher")).toBe(false)
    expect(listsPlugin(undefined, "agent-researcher")).toBe(false)
  })
})

describe("fallback side", () => {
  test("ownedElsewhere names the fallbacks whose owner is installed", () => {
    expect([...ownedElsewhere({ data: [{ id: "srobroek.agent-researcher" }] }, owners)]).toEqual(["researcher"])
    expect(ownedElsewhere([], owners).size).toBe(0)
  })

  test("keepFallback registers unowned agents always and a fallback only when nothing else did", () => {
    expect(keepFallback("implementer", owners, new Set(["implementer"]), true)).toBe(true)
    expect(keepFallback("researcher", owners, new Set(), false)).toBe(true)
    expect(keepFallback("researcher", owners, new Set(["researcher"]), false)).toBe(false)
    expect(keepFallback("researcher", owners, new Set(), true)).toBe(false)
  })
})

describe("owner side", () => {
  test("a fallback copy is replaced by a fresh registration", () => {
    const draft: Record<string, unknown> = {
      system: "prompt",
      mode: "subagent",
      model: { providerID: "p", id: "m" },
      request: { headers: { "x-opencode-model-role": "standard", "x-opencode-model-fallback": "p/m" } },
      permissions: [{ action: "read", resource: "*", effect: "allow" }],
    }
    expect(isCopyOf(draft as { system: string }, file)).toBe(true)
    applyOwnedAgent(draft, file, { ...(draft as { system: string }) })
    expect(draft.model).toBeUndefined()
    expect(draft.request).toEqual({ headers: { "x-opencode-model-role": "standard" } })
    expect(draft.permissions).toEqual(file.permissions)
  })

  test("another agent keeps its fields and gains the file's permissions after its own", () => {
    const own = { action: "edit", resource: "*", effect: "allow" } as const
    const draft = { system: "mine", permissions: [own] as AgentFile["permissions"] }
    applyOwnedAgent(draft, file, { ...draft })
    expect(draft.system).toBe("mine")
    expect(draft.permissions).toEqual([own, ...file.permissions])
    expect(isCopyOf(undefined, file)).toBe(false)
  })
})

describe("registerFallbackAgents", () => {
  const withAgents = <T>(run: (paths: string[]) => Promise<T>) => {
    const dir = mkdtempSync(join(tmpdir(), "fallback-agents-"))
    const paths = ["researcher", "helper"].map((id) => {
      const path = join(dir, `${id}.md`)
      writeFileSync(path, `---\nmode: subagent\npermissions: []\n---\n${id} prompt`)
      return path
    })
    return run(paths).finally(() => rmSync(dir, { recursive: true, force: true }))
  }
  const listing = (fake: ReturnType<typeof createFakeContext>, list: () => Promise<unknown>) => {
    ;(fake.context as unknown as Record<string, unknown>).plugin = { list }
    return fake
  }

  test("skips a fallback whose owner is installed and keeps the rest", () =>
    withAgents(async (paths) => {
      const fake = listing(createFakeContext(), async () => ({ data: [{ id: "srobroek.agent-researcher" }] }))
      const registration = await registerFallbackAgents(fake.context, paths, owners)
      expect([...fake.agents.keys()]).toEqual(["helper"])
      await registration.dispose()
      expect(fake.active()).toBe(0)
    }))

  test("registers the fallback without its owner, and never over an existing agent", () =>
    withAgents(async (paths) => {
      const fake = listing(createFakeContext(), async () => ({ data: [] }))
      await registerFallbackAgents(fake.context, paths, owners)
      expect(fake.agents.get("researcher")?.system).toBe("researcher prompt")
      const taken = listing(createFakeContext({ agents: [{ id: "researcher", system: "owner" }] }), async () => [])
      await registerFallbackAgents(taken.context, paths, owners)
      expect(taken.agents.get("researcher")?.system).toBe("owner")
    }))

  test("listPlugins treats a failing or slow plugin.list as nothing installed", async () => {
    const fake = createFakeContext()
    expect(await listPlugins(listing(fake, async () => Promise.reject(new Error("x"))).context.plugin)).toBeUndefined()
    expect(await listPlugins(listing(fake, () => new Promise(() => {})).context.plugin, 5)).toBeUndefined()
    expect(await listPlugins(listing(fake, async () => [1]).context.plugin)).toEqual([1])
  })
})
