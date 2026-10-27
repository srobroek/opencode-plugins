import { describe, expect, test } from "bun:test"
import { applyOwnedAgent, isCopyOf, keepFallback, listsPlugin, ownedElsewhere } from "./agent-fallback.ts"
import type { AgentFile } from "./agent-files.ts"

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
