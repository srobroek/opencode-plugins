import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { createFakeContext } from "@srobroek/opencode-lib/testing"
import type { BdRun } from "./gate-admission.ts"
import {
  agentMatches,
  beadIdsIn,
  decideRouting,
  ledgerPrefix,
  readRouting,
  registerAgentRouting,
  spawnInput,
} from "./subagent-routing.ts"

describe("beadIdsIn", () => {
  test("prefers ids with the ledger prefix", () => {
    expect(beadIdsIn("Work opencode-plugins-4p3.11 (parent opencode-plugins-4p3), see read-only notes", "opencode-plugins")).toEqual([
      "opencode-plugins-4p3.11",
      "opencode-plugins-4p3",
    ])
  })

  test("without a prefix match, keeps tokens whose hash has a digit or a child suffix", () => {
    expect(beadIdsIn("fan-out the read-only proj-a1b and proj-abc.2, not x-opencode-model-role")).toEqual([
      "proj-a1b",
      "proj-abc.2",
    ])
    expect(beadIdsIn("implement proj-a1b", "other")).toEqual(["proj-a1b"])
  })

  test("dedupes, lowercases and caps the lookups", () => {
    expect(beadIdsIn("PROJ-A1B proj-a1b")).toEqual(["proj-a1b"])
    const many = Array.from({ length: 20 }, (_, i) => `proj-${i}aa`).join(" ")
    expect(beadIdsIn(many)).toHaveLength(8)
  })
})

describe("ledgerPrefix", () => {
  test("is the store's repository directory name", () => {
    expect(ledgerPrefix("/x/opencode-plugins/.beads")).toBe("opencode-plugins")
    expect(ledgerPrefix("/x/My Repo/.beads")).toBeUndefined()
    expect(ledgerPrefix(undefined)).toBeUndefined()
  })
})

describe("readRouting", () => {
  test("reads enveloped and bare bd show output", () => {
    const bead = { id: "p-1aa", metadata: { execution_agent_type: "researcher", execution_reasoning_effort: "high" } }
    expect(readRouting(JSON.stringify({ schema_version: 1, data: [bead, { id: "p-2aa" }] }))).toEqual([
      { id: "p-1aa", agentType: "researcher", effort: "high" },
      { id: "p-2aa" },
    ])
    expect(readRouting(JSON.stringify(bead))).toEqual([{ id: "p-1aa", agentType: "researcher", effort: "high" }])
    expect(readRouting("not json")).toEqual([])
  })
})

describe("decideRouting", () => {
  const typed = { id: "p-1aa", agentType: "implementer" }

  test("allows the agent the bead names, with a namespace", () => {
    expect(agentMatches("delivery:implementer", "implementer")).toBe(true)
    expect(agentMatches("implementer-high", "implementer")).toBe(false)
    expect(decideRouting("implementer", [typed])).toEqual({ kind: "allow" })
  })

  test("refuses another agent and names the bead's agent and effort", () => {
    const decision = decideRouting("implementer-high", [{ ...typed, effort: "medium" }])
    expect(decision.kind).toBe("block")
    if (decision.kind !== "block") return
    expect(decision.cause).toContain("p-1aa (execution_agent_type=implementer, execution_reasoning_effort=medium)")
    expect(decideRouting("general", [{ id: "p-2aa", agentType: "researcher" }]).kind).toBe("block")
  })

  test("any named bead's agent satisfies the rule", () => {
    expect(decideRouting("researcher", [typed, { id: "p-2aa", agentType: "researcher" }]).kind).toBe("allow")
  })

  test("implementer-high without a bead saying so is advised, not refused", () => {
    expect(decideRouting("implementer-high", []).kind).toBe("advise")
    expect(decideRouting("implementer-high", [{ id: "p-1aa" }]).kind).toBe("advise")
    expect(decideRouting("implementer-high", [{ id: "p-1aa", agentType: "implementer-high" }]).kind).toBe("allow")
    expect(decideRouting("general", [{ id: "p-1aa" }]).kind).toBe("allow")
  })

  test("spawnInput skips resumed and malformed calls", () => {
    expect(spawnInput({ agent: "a", prompt: "p" })).toEqual({ agent: "a", prompt: "p" })
    expect(spawnInput({ agent: "a", prompt: "p", sessionID: "ses_1" })).toBeUndefined()
    expect(spawnInput({ prompt: "p" })).toBeUndefined()
  })
})

describe("registerAgentRouting", () => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  const project = (withStore = true): string => {
    const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "routing-"))
    roots.push(root)
    const directory = join(root, "proj")
    mkdirSync(withStore ? join(directory, ".beads") : directory, { recursive: true })
    return directory
  }

  const env = () => ({ PATH: process.env.PATH, HOME: process.env.HOME }) as NodeJS.ProcessEnv

  const shown =
    (beads: unknown[], calls: string[][] = []): BdRun =>
    async (_cwd, args) => {
      calls.push(args)
      return { output: JSON.stringify({ schema_version: 1, data: beads }) }
    }

  const spawn = (agent: string, prompt: string, id = "call_1") => ({
    tool: "subagent",
    sessionID: "ses_root",
    agent: "build",
    messageID: "msg_1",
    id,
    input: { agent, prompt, description: "d" },
  })

  const start = async (directory: string, run: BdRun, options: Record<string, unknown> = {}) => {
    const fake = createFakeContext({ directory, options })
    const cleanup = await registerAgentRouting(fake.context, { run, env })
    return { fake, cleanup }
  }

  test("refuses a spawn to an agent the bead does not name, reading only the prefixed ids", async () => {
    const calls: string[][] = []
    const { fake, cleanup } = await start(
      project(),
      shown([{ id: "proj-a1b", metadata: { execution_agent_type: "implementer" } }], calls),
    )
    await expect(fake.fire.tool("execute.before", spawn("general", "Implement proj-a1b; read-only first"))).rejects.toThrow(
      /FO-5.*proj-a1b \(execution_agent_type=implementer\).*gates\.bead-agent-routing\.enabled=false/s,
    )
    expect(calls).toEqual([["show", "proj-a1b", "--json"]])
    await fake.fire.tool("execute.before", spawn("implementer", "Implement proj-a1b"))
    await cleanup()
    expect(fake.active()).toBe(0)
  })

  test("appends the implementer-high advisory after a completed spawn", async () => {
    const { fake, cleanup } = await start(project(), shown([{ id: "proj-a1b" }]))
    await fake.fire.tool("execute.before", spawn("implementer-high", "Implement proj-a1b"))
    const after = await fake.fire.tool("execute.after", {
      ...spawn("implementer-high", ""),
      status: "completed",
      result: { content: [{ type: "text", text: "done" }] },
    })
    expect(JSON.stringify(after.result)).toContain("FO-5 advisory")
    await cleanup()
  })

  test("fails open when bd fails or takes no ids", async () => {
    const calls: string[][] = []
    const failing: BdRun = async (_cwd, args) => {
      calls.push(args)
      return { failure: "bd command timed out" }
    }
    const { fake, cleanup } = await start(project(), failing)
    await fake.fire.tool("execute.before", spawn("general", "Implement proj-a1b"))
    await fake.fire.tool("execute.before", spawn("general", "no bead here"))
    expect(calls).toHaveLength(1)
    await cleanup()
  })

  test("registers nothing when disabled or without a store", async () => {
    const off = await start(project(), shown([]), { gates: { "bead-agent-routing": { enabled: false } } })
    expect(off.fake.hooks("tool")).toEqual([])
    await off.cleanup()
    const bare = await start(project(false), shown([]))
    expect(bare.fake.hooks("tool")).toEqual([])
    await bare.cleanup()
  })
})
