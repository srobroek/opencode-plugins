import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createFakeContext } from "@srobroek/opencode-lib/testing"
import plugin, { filterLeadRouting, newScratchEntries, runsSleep, scratchEntries, scratchEntry } from "./index.ts"

describe("lead routing", () => {
  test("keeps a reviewer bullet if either reviewer exists, but ignores ids in its description", () => {
    const text = "# Delegation\n- `coder`: code\n- `code-reviewer`, `security-reviewer`: diff\n- `operator`: use `aws logs`\nfooter"
    expect(filterLeadRouting(text, new Set(["security-reviewer", "aws logs"]))).toBe("# Delegation\n- `code-reviewer`, `security-reviewer`: diff\nfooter")
    expect(filterLeadRouting(text, new Set())).toBe("# Delegation\nfooter")
  })

  test("injects stable primary-only text across all three hooks", async () => {
    const fake = createFakeContext({ agents: [{ id: "coder" }], sessions: [{ id: "root" }, { id: "child", parentID: "root" }] })
    const cleanup = await plugin.setup(fake.context)
    const payload = (sessionID: string, tools: object = { subagent: {} }) => ({ sessionID, agent: "build", tools, system: [] as Array<{ type: "text"; text: string }> })
    const first = await fake.fire.session("context", payload("root"))
    expect(first.system[0]?.text).toContain("- `coder`:")
    expect(first.system[0]?.text).not.toContain("- `operator`:")
    fake.agents.clear()
    for (const hook of ["compaction", "generate"]) expect((await fake.fire.session(hook, payload("root"))).system).toEqual(first.system)
    expect((await fake.fire.session("context", payload("child"))).system).toEqual([])
    expect((await fake.fire.session("context", payload("root", {}))).system).toEqual([])
    await cleanup?.()
    expect(fake.active()).toBe(0)
  })
})

describe("sleep guard", () => {
  test("detects command positions and timeout wrappers", () => {
    for (const command of ["sleep 5", "true && sleep 5", "true; sleep 5", "sleep 5 | cat", "while true; do sleep 5; done", "for x in a b; do sleep 5; done", "if true; then sleep 5; fi", "(sleep 5)", "timeout 10 sleep 5", "timeout -k 2 10 sleep 5", "echo $(sleep 5)"]) expect(runsSleep(command)).toBe(true)
  })
  test("does not treat quoted words or arguments as commands", () => {
    for (const command of ['echo "sleep 5"', "grep sleep log", 'git commit -m "sleep"', "echo sleep", "'sleep' 5", "timeout 5 echo sleep"]) expect(runsSleep(command)).toBe(false)
  })
  test("refuses foreground shell and mapped aliases, allows background and disabled guard", async () => {
    const fake = createFakeContext()
    const cleanup = await plugin.setup(fake.context)
    for (const tool of ["shell", "bash", "Bash"]) await expect(fake.fire.tool("execute.before", { id: tool, sessionID: "root", tool, input: { command: "sleep 5" } })).rejects.toThrow("foreground `sleep` is refused")
    const event = await fake.fire.tool("execute.before", { id: "bg", sessionID: "root", tool: "Bash", input: { command: "sleep 5", run_in_background: true } })
    expect(event.tool).toBe("shell")
    await cleanup?.()
    const off = createFakeContext({ options: { waitGuard: false } })
    const dispose = await plugin.setup(off.context)
    await off.fire.tool("execute.before", { id: "off", sessionID: "root", tool: "shell", input: { command: "sleep 5" } })
    await dispose?.()
  })
})

describe("scratch entries", () => {
  test("selects only new matching entries within the remaining note budget", () => {
    expect(newScratchEntries(["/s/a", "/s/b"], new Set(["/s/a"]), ["/s/a", "/s/b", "/s/other"], new Set())).toEqual(["/s/b"])
    expect(newScratchEntries(["/s/job-XXXXXX"], new Set(), ["/s/job-Ab12cd", "/s/job-other-long"], new Set())).toEqual(["/s/job-Ab12cd"])
    expect(newScratchEntries(["/s/a"], new Set(), ["/s/a"], new Set(["/s/a"]))).toEqual([])
    expect(newScratchEntries(["/s/a"], new Set(), ["/s/a"], new Set(["/s/b", "/s/c", "/s/d"]))).toEqual([])
  })
  test("resolves top-level entries without confusing siblings or the root", () => {
    expect(scratchEntry("a/b", "/tmp/opencode", "/tmp/opencode")).toBe("/tmp/opencode/a")
    for (const target of ["/tmp/opencode", "/tmp/opencode-other/a", "/tmp/opencode/../other"]) expect(scratchEntry(target, "/repo", "/tmp/opencode")).toBeUndefined()
    expect(scratchEntries("write", { path: "/tmp/opencode/a/b" }, "/repo", "/tmp/opencode")).toEqual(["/tmp/opencode/a"])
    expect(scratchEntries("shell", { command: "mkdir -p a/b; echo hi > c/file; mktemp -d d/XXXXXX", workdir: "/tmp/opencode" }, "/repo", "/tmp/opencode")).toEqual(["/tmp/opencode/c", "/tmp/opencode/a", "/tmp/opencode/d"])
    expect(scratchEntries("patch", { patchText: "*** Add File: /tmp/opencode/p/file" }, "/repo", "/tmp/opencode")).toEqual(["/tmp/opencode/p"])
  })

  test("notes new child entries once, never existing entries, and caps each session at three", async () => {
    const root = join(realpathSync(tmpdir()), "opencode")
    const fixture = mkdtempSync(join(root, "efficiency-test-"))
    const created: string[] = []
    const fake = createFakeContext({ directory: root, sessions: [{ id: "child", parentID: "root", location: { directory: root } }, { id: "root", location: { directory: root } }] })
    const cleanup = await plugin.setup(fake.context)
    try {
      const run = async (entry: string, sessionID = "child") => {
        const event = { id: entry, sessionID, tool: "write", input: { path: join(entry, "file") } }
        await fake.fire.tool("execute.before", event)
        mkdirSync(entry, { recursive: true })
        return fake.fire.tool("execute.after", { ...event, status: "completed", result: { content: "ok" } })
      }
      expect((await run(fixture)).result.content).toBe("ok")
      for (let i = 0; i < 4; i++) {
        const entry = `${fixture}-${i}`
        created.push(entry)
        const result = (await run(entry)).result
        expect(JSON.stringify(result).includes("Scratch: you created")).toBe(i < 3)
        rmSync(entry, { recursive: true })
        expect((await run(entry)).result.content).toBe("ok")
      }
      const primary = `${fixture}-primary`
      created.push(primary)
      expect((await run(primary, "root")).result.content).toBe("ok")
    } finally {
      await cleanup?.()
      for (const entry of [...created, fixture]) rmSync(entry, { recursive: true, force: true })
    }
    expect(fake.active()).toBe(0)
  })
})
