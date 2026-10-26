import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createFakeContext, type FakeContextOptions } from "@srobroek/opencode-lib/testing"
import plugin, { confirmBump, formatScan, SKILL_PATH } from "./index.ts"
import { SCANNER_ADVISORY } from "./scanner-install.ts"

type Result = { content: string; metadata: Record<string, unknown> }
type Execute = (input: unknown, context: unknown) => Promise<Result>

const call = { sessionID: "ses_1", agent: "build", messageID: "msg_1", id: "call_1" }

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "dep-update-"))
}

async function load(options: FakeContextOptions = {}) {
  const fake = createFakeContext(options)
  const cleanup = await plugin.setup(fake.context)
  const tool = (name: string) => fake.tools.get(name)?.execute as Execute
  return { fake, cleanup, tool }
}

describe("setup", () => {
  test("registers both tools, the confirm gate, the advisory and the skill, and disposes them all", async () => {
    const { fake, cleanup } = await load()
    expect([...fake.tools.keys()]).toEqual(["dep_scan", "dep_apply"])
    expect(fake.hooks("permission")).toEqual(["evaluate"])
    expect(fake.hooks("tool")).toEqual(["execute.after"])
    expect(fake.skills.get("dep-update")).toMatchObject({ id: "dep-update", path: SKILL_PATH })
    expect(String(fake.skills.get("dep-update")?.content)).not.toMatch(/skill:\/\/|rule:\/\//)
    await cleanup?.()
    expect(fake.active()).toBe(0)
    expect(fake.tools.size).toBe(0)
    expect(fake.skills.size).toBe(0)
  })

  test("the confirm option turns the gate off", async () => {
    const { fake } = await load({ options: { confirm: false } })
    expect(fake.hooks("permission")).toEqual([])
  })

  test("tool inputs are JSON Schema; the fixture seam is not a parameter", async () => {
    const { fake } = await load()
    expect(fake.tools.get("dep_scan")?.input).toMatchObject({ type: "object", properties: { path: {} } })
    expect(Object.keys((fake.tools.get("dep_scan")?.input as { properties?: object })?.properties ?? {})).toEqual(["path"])
    expect(fake.tools.get("dep_apply")?.input).toMatchObject({ required: ["ecosystem", "name", "version"] })
  })
})

describe("dep_scan", () => {
  test("offline fixture classifies left-pad and resolves a relative path against the location", async () => {
    const project = tmp()
    const fixtures = tmp()
    writeFileSync(join(project, "package.json"), JSON.stringify({ dependencies: { "left-pad": "1.3.0" } }))
    writeFileSync(
      join(fixtures, "npm_left-pad.json"),
      JSON.stringify({ "dist-tags": { latest: "1.3.0" }, versions: { "1.3.0": {} } }),
    )
    const previous = process.env.DEP_UPDATE_FIXTURE_DIR
    process.env.DEP_UPDATE_FIXTURE_DIR = fixtures
    try {
      const { tool } = await load({ directory: join(project, "..") })
      const result = await tool("dep_scan")(
        { path: project.slice(project.lastIndexOf("/") + 1) },
        { ...call, signal: new AbortController().signal },
      )
      const records = result.metadata.records as Array<{ name: string; class?: string }>
      expect(records[0]).toMatchObject({ name: "left-pad", class: "CURRENT" })
      expect(result.content).toContain("upgradable")
      expect(result.metadata.complete).toBe(true)
    } finally {
      if (previous === undefined) delete process.env.DEP_UPDATE_FIXTURE_DIR
      else process.env.DEP_UPDATE_FIXTURE_DIR = previous
      rmSync(project, { recursive: true, force: true })
      rmSync(fixtures, { recursive: true, force: true })
    }
  })

  test("a missing directory reports the failure", async () => {
    const { tool } = await load()
    const result = await tool("dep_scan")({ path: "/nonexistent-dep-scan" }, { signal: new AbortController().signal })
    expect(result.content).toContain("dep_scan failed (exit 2)")
  })
})

describe("formatScan", () => {
  test("orders upgradable bumps by class then name, then lists unclassified records", () => {
    const { text, summary } = formatScan(
      [
        { ecosystem: "npm", name: "b", installed: "1.0.0", latest: "2.0.0", class: "MAJOR-ADVISORY", status: "OK" },
        { ecosystem: "npm", name: "z", installed: "1.0.0", latest: "1.0.1", class: "PATCH-SAFE", status: "OK" },
        { ecosystem: "npm", name: "a", installed: "1.0.0", latest: "1.0.1", class: "PATCH-SAFE", status: "OK" },
        { ecosystem: "npm", name: "c", installed: "^1", status: "UNRESOLVABLE", reason: "range" },
        { ecosystem: "npm", name: "d", installed: "1.0.0", status: "UNCHECKED" },
        { ecosystem: "npm", name: "e", installed: "1.0.0", latest: "1.0.0", class: "CURRENT", status: "CURRENT" },
      ],
      "notes",
    )
    expect(text.split("\n").map((line) => line.split(/\s+/).slice(0, 2).join(" "))).toEqual([
      "PATCH-SAFE a",
      "PATCH-SAFE z",
      "MAJOR-ADVISORY b",
      "UNRESOLVABLE c",
      "UNCHECKED d",
      "-- 3",
      "notes",
    ])
    expect(summary).toEqual({ upgradable: 3, skipped: 2, unchecked: 1 })
  })
})

describe("dep_apply", () => {
  test("asserts one permission naming the exact bump, then applies it", async () => {
    const project = tmp()
    try {
      const { fake, tool } = await load()
      const result = await tool("dep_apply")(
        { ecosystem: "cargo", name: "serde", version: "1.0.200", path: project },
        { ...call, signal: new AbortController().signal },
      )
      expect(fake.asserts).toEqual([
        {
          sessionID: "ses_1",
          agent: "build",
          source: { type: "tool", messageID: "msg_1", id: "call_1" },
          action: "dep_apply",
          resources: ["serde@1.0.200"],
          save: ["serde@1.0.200"],
          metadata: { ecosystem: "cargo", name: "serde", version: "1.0.200", project },
        },
      ])
      expect(result.metadata.exit).toBe(0)
      expect(result.content).toContain("ADVISORY-ONLY")
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  test("a rejection propagates and nothing runs", async () => {
    const { tool } = await load({
      assert: () => {
        throw new Error("rejected by user")
      },
    })
    await expect(
      tool("dep_apply")(
        { ecosystem: "cargo", name: "serde", version: "1.0.200", path: "/nonexistent-dep-apply" },
        { ...call, signal: new AbortController().signal },
      ),
    ).rejects.toThrow("rejected by user")
  })

  test("invalid operands and a cancelled call never prompt", async () => {
    const { fake, tool } = await load()
    const invalid = await tool("dep_apply")(
      { ecosystem: "npm", name: "--help", version: "1.0.0" },
      { ...call, signal: new AbortController().signal },
    )
    expect(invalid.metadata.exit).toBe(2)
    const controller = new AbortController()
    controller.abort(new Error("stopped"))
    await expect(
      tool("dep_apply")({ ecosystem: "npm", name: "x", version: "1.0.0" }, { ...call, signal: controller.signal }),
    ).rejects.toThrow("stopped")
    expect(fake.asserts).toEqual([])
  })
})

describe("confirmBump", () => {
  test("escalates an allowed dep_apply to a prompt naming the bump", () => {
    const evaluation = { action: "dep_apply", resources: ["x@1.0.0"], effect: "allow" }
    confirmBump(evaluation)
    expect(evaluation).toMatchObject({ effect: "ask" })
    expect((evaluation as { message?: string }).message).toContain("x@1.0.0")
  })

  test("leaves asks and other actions alone", () => {
    for (const evaluation of [
      { action: "dep_apply", resources: ["x@1.0.0"], effect: "ask" },
      { action: "shell", resources: ["ls"], effect: "allow" },
    ]) {
      const before = { ...evaluation }
      confirmBump(evaluation)
      expect(evaluation).toEqual(before)
    }
  })

  test("fires through the registered hook", async () => {
    const { fake } = await load()
    const evaluation = await fake.fire.permission("evaluate", {
      action: "dep_apply",
      resources: ["x@1.0.0"],
      effect: "allow",
    })
    expect(evaluation.effect).toBe("ask")
  })
})

describe("scanner-install advisory", () => {
  const after = (command: string, status = "completed") => ({
    tool: "shell",
    status,
    input: { command },
    result: { content: "installed", output: { exit: 0, output: "installed" } },
  })

  test("appends to a completed persistent scanner install", async () => {
    const { fake } = await load()
    const event = await fake.fire.tool("execute.after", after("pipx install pip-audit"))
    expect(event.result.content).toBe(`installed\n${SCANNER_ADVISORY}`)
  })

  test("leaves other commands, tools and errors alone", async () => {
    const { fake } = await load()
    for (const event of [
      after("uvx pip-audit"),
      { ...after("pipx install pip-audit"), tool: "read" },
      after("pipx install pip-audit", "error"),
    ]) {
      const fired = await fake.fire.tool("execute.after", event)
      expect(fired.result.content).toBe("installed")
    }
  })
})

describe("bundle", () => {
  test("the built entry resolves the shipped SKILL.md from the package root", async () => {
    const built = (await import(join(import.meta.dir, "..", "index.js"))) as { SKILL_PATH: string }
    expect(built.SKILL_PATH).toBe(join(import.meta.dir, "..", "skills", "dep-update", "SKILL.md"))
    expect(existsSync(built.SKILL_PATH)).toBe(true)
  })
})
