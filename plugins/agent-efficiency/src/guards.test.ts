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
  test("parameter and arithmetic expansions are data, but nested executable substitutions run", () => {
    for (const command of [`printf '%s' "\${sleep}"`, `printf '%s' "\${sleep:-sleep 5}"`, `printf '%s' "$((sleep + 5))"`]) expect(runsSleep(command)).toBe(false)
    for (const command of ["echo $(sleep 5)", "echo `sleep 5`", "cat <(sleep 5)", "cat >(sleep 5)", `echo "\${value:-$(sleep 5)}"`, `cat <<EOF\n\${value:-$(sleep 5)}\nEOF`]) expect(runsSleep(command)).toBe(true)
  })
  test("eval scripts and xargs invocations run while ordinary quoted arguments stay data", () => {
    for (const command of ["eval 'sleep 9'", "eval sleep 9", "printf '9' | xargs sleep", "printf '9' | xargs -n 1 -P 2 sleep", "printf '9' | xargs -rn 1 sleep", "printf '9' | xargs --max-args=1 -- sleep", "printf '9' | xargs -I '{}' sh -c 'sleep 9'"]) expect(runsSleep(command)).toBe(true)
    for (const command of ["echo 'eval sleep 9'", "printf '%s' 'xargs sleep'", "printf '9' | xargs echo sleep", "eval 'echo sleep'", "echo 'sh -c sleep'"]) expect(runsSleep(command)).toBe(false)
  })
  test("here-document text and shell-looking quoted arguments are data", () => {
    for (const command of ["cat <<EOF\nsleep 5\nEOF", "cat <<'EOF'\nsleep 5\nEOF", `echo 'sh -c "sleep 7"'`, `echo 'bash -lc "sleep 7"'`, `echo 'zsh -ec "sleep 7"'`]) expect(runsSleep(command)).toBe(false)
    expect(runsSleep("cat <<EOF\n$(sleep 5)\nEOF")).toBe(true)
    expect(runsSleep("cat <<'EOF'\n$(sleep 5)\nEOF")).toBe(false)
  })
  test("shell scripts are executable only at shell command positions", () => {
    for (const command of [`sh -lc "sleep 7"`, `bash -lc "sleep 7"`, `zsh -c "sleep 7"`, `sh -ec "sleep 7"`, `bash -lec "sleep 7"`, `bash -o pipefail -c "sleep 5"`, "bash -s argument <<'EOF'\nsleep 5\nEOF", "bash <<'EOF'\nsleep 5\nEOF", "bash <<EOF\nsleep 5\nEOF"]) expect(runsSleep(command)).toBe(true)
  })
  test("detects command positions and timeout wrappers", () => {
    for (const command of ["sleep 5", "true && sleep 5", "true; sleep 5", "sleep 5 | cat", "while true; do sleep 5; done", "for x in a b; do sleep 5; done", "if true; then sleep 5; fi", "if false; then :; else sleep 5; fi", "(sleep 5)", "timeout 10 sleep 5", "timeout -k 2 10 sleep 5", "echo $(sleep 5)"]) expect(runsSleep(command)).toBe(true)
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
  test("script and loop creators share traversal while retaining effective directories", () => {
    for (const command of ["sh -c 'mkdir /tmp/opencode/fresh-entry'", "sh -c 'cd /tmp/opencode; mkdir fresh-entry'", "cd /tmp/opencode; sh -c 'mkdir fresh-entry'", "for x in one; do mkdir /tmp/opencode/fresh-entry; done", "while false; do mktemp -d /tmp/opencode/fresh-entry/XXXXXX; done", "for x in one; do cd /tmp/opencode; mkdir fresh-entry; done", "sh -c 'while false; do cd /tmp/opencode; mktemp -d fresh-entry/XXXXXX; done'", "bash <<'EOF'\ncd /tmp/opencode\nmkdir fresh-entry\nEOF", "eval 'mkdir /tmp/opencode/fresh-entry'", "printf 'x' | xargs mkdir /tmp/opencode/fresh-entry", "echo $(sh -c 'mkdir /tmp/opencode/fresh-entry')"]) expect(scratchEntries("shell", { command }, "/repo", "/tmp/opencode")).toEqual(["/tmp/opencode/fresh-entry"])
    expect(scratchEntries("shell", { command: "echo 'sh -c mkdir /tmp/opencode/data-entry'" }, "/repo", "/tmp/opencode")).toEqual([])
    expect(scratchEntries("shell", { command: "if false; then :; else mkdir /tmp/opencode/fresh-entry; fi" }, "/repo", "/tmp/opencode")).toEqual(["/tmp/opencode/fresh-entry"])
    expect(scratchEntries("shell", { command: "(cd /tmp/opencode; sh -c 'mkdir fresh-entry'); sh -c 'mkdir outside'" }, "/repo", "/tmp/opencode")).toEqual(["/tmp/opencode/fresh-entry"])
  })
  test("mkdir and mktemp inherit effective cd, subshell and wrapper directories", () => {
    for (const command of ["cd /tmp/opencode && mkdir x", "cd /tmp/opencode && mktemp -d x/XXXXXX", "(cd /tmp/opencode; mkdir x); mkdir outside", "env -C /tmp/opencode mkdir x", "cd /tmp/opencode && mktemp -d -p x"]) expect(scratchEntries("shell", { command }, "/repo", "/tmp/opencode")).toEqual(["/tmp/opencode/x"])
    expect(scratchEntries("shell", { command: "cd /tmp/opencode; mkdir x; cd /repo; mkdir outside" }, "/repo", "/tmp/opencode")).toEqual(["/tmp/opencode/x"])
  })
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
    expect(scratchEntries("shell", { command: "mkdir -p a/b; echo hi > c/file; mktemp -d d/XXXXXX", workdir: "/tmp/opencode" }, "/repo", "/tmp/opencode")).toEqual(["/tmp/opencode/a", "/tmp/opencode/c", "/tmp/opencode/d"])
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

describe("session cache deletion", () => {
  const deleted = async (fake: ReturnType<typeof createFakeContext>, sessionID: string) => {
    fake.emit({ type: "session.deleted", data: { sessionID } })
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  test("evicts lead text on deletion, but preserves it for resumable sessions", async () => {
    const fake = createFakeContext({ agents: [{ id: "coder" }], sessions: [{ id: "root" }] })
    const cleanup = await plugin.setup(fake.context)
    const request = () => fake.fire.session("context", { sessionID: "root", agent: "build", tools: { subagent: {} }, system: [] as Array<{ type: "text"; text: string }> })
    try {
      const initial = await request()
      fake.agents.clear()
      expect((await request()).system).toEqual(initial.system)
      await deleted(fake, "unrelated")
      expect((await request()).system).toEqual(initial.system)
      await deleted(fake, "root")
      expect((await request()).system[0]?.text).not.toContain("- `coder`:")
    } finally { await cleanup?.() }
  })
  test("evicts child, reminder and pending-call state only for deleted sessions", async () => {
    const root = join(realpathSync(tmpdir()), "opencode")
    const fixture = mkdtempSync(join(root, "efficiency-delete-test-"))
    const entry = `${fixture}-entry`
    const pending = `${fixture}-pending`
    const fake = createFakeContext({ sessions: [{ id: "child", parentID: "root", location: { directory: root } }] })
    const cleanup = await plugin.setup(fake.context)
    const before = (path: string) => fake.fire.tool("execute.before", { id: path, sessionID: "child", tool: "shell", input: { command: `cd ${root} && mkdir ${path}`, workdir: "/repo" } })
    const after = (event: Awaited<ReturnType<typeof before>>) => fake.fire.tool("execute.after", { ...event, status: "completed", result: { content: "ok" } })
    try {
      let event = await before(entry)
      mkdirSync(entry)
      expect(JSON.stringify((await after(event)).result)).toContain("Scratch: you created")
      rmSync(entry, { recursive: true })
      await deleted(fake, "unrelated")
      event = await before(entry)
      mkdirSync(entry)
      expect((await after(event)).result.content).toBe("ok")
      rmSync(entry, { recursive: true })
      const interrupted = await before(pending)
      await deleted(fake, "child")
      mkdirSync(pending)
      expect((await after(interrupted)).result.content).toBe("ok")
      event = await before(entry)
      mkdirSync(entry)
      expect(JSON.stringify((await after(event)).result)).toContain("Scratch: you created")
      await deleted(fake, "child")
      fake.sessions.set("child", { id: "child", location: { directory: root } })
      rmSync(entry, { recursive: true })
      event = await before(entry)
      mkdirSync(entry)
      expect((await after(event)).result.content).toBe("ok")
    } finally {
      await cleanup?.()
      for (const path of [fixture, entry, pending]) rmSync(path, { recursive: true, force: true })
    }
  })
})
