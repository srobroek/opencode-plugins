import { describe, expect, test } from "bun:test"
import {
  commandMentionsTasksMd,
  DENY_REASON,
  decideToolCall,
  isTasksMd,
  tasksTargets,
  writesTasksMd,
} from "./tasks-guard.ts"

const active = async () => true
const inactive = async () => false

describe("isTasksMd", () => {
  test("matches relative and absolute specs/*/tasks.md", () => {
    expect(isTasksMd("specs/001-foo/tasks.md")).toBe(true)
    expect(isTasksMd("/repo/specs/001-foo/tasks.md")).toBe(true)
    expect(isTasksMd("specs/readme.md")).toBe(false)
    expect(isTasksMd("docs/tasks.md")).toBe(false)
  })
})

describe("writesTasksMd", () => {
  test("detects redirect and writers", () => {
    expect(writesTasksMd("echo x > specs/001/tasks.md")).toBe(true)
    expect(writesTasksMd("tee specs/001/tasks.md")).toBe(true)
    expect(writesTasksMd("cat specs/001/tasks.md")).toBe(false)
    expect(writesTasksMd("rg foo specs/001/tasks.md")).toBe(false)
  })

  test("treats only cp's destination as a write", () => {
    expect(writesTasksMd("cp specs/001-a/tasks.md /tmp/legacy.md")).toBe(false)
    expect(writesTasksMd("cp /tmp/x specs/001-a/tasks.md")).toBe(true)
    expect(writesTasksMd("cp /tmp/x /repo/specs/001-a/tasks.md && echo ok")).toBe(true)
    expect(writesTasksMd('cp /tmp/x "specs/001-a/tasks.md"')).toBe(true)
    expect(writesTasksMd("cp /tmp/x specs/001-a/tasks.md 2>/dev/null")).toBe(true)
    expect(writesTasksMd("cp specs/001-a/tasks.md specs/002-b/tasks.md")).toBe(true)
    expect(writesTasksMd("cp -t specs/001-a /tmp/tasks.md")).toBe(true)
  })
})

describe("commandMentionsTasksMd", () => {
  test("requires specs/ then /tasks.md", () => {
    expect(commandMentionsTasksMd("cat specs/001/tasks.md")).toBe(true)
    expect(commandMentionsTasksMd("echo tasks.md")).toBe(false)
  })
})

describe("decideToolCall", () => {
  test("refuses a write of tasks.md when beads is active", async () => {
    expect(await decideToolCall("write", { path: "specs/001-x/tasks.md", content: "" }, "/tmp", active)).toBe(
      DENY_REASON,
    )
  })

  test("allows the write when beads is inactive", async () => {
    expect(
      await decideToolCall("write", { path: "specs/001-x/tasks.md", content: "" }, "/tmp", inactive),
    ).toBeUndefined()
  })

  test("allows other files without probing", async () => {
    const probe = async () => {
      throw new Error("probed")
    }
    expect(await decideToolCall("edit", { path: "specs/001-x/spec.md" }, "/tmp", probe)).toBeUndefined()
    expect(await decideToolCall("read", { path: "specs/001-x/tasks.md" }, "/tmp", probe)).toBeUndefined()
  })

  test("refuses patch adds, updates, deletes and move destinations", async () => {
    for (const header of [
      "*** Add File: specs/001-x/tasks.md",
      "*** Update File: /repo/specs/001-x/tasks.md",
      "*** Delete File: specs/001-x/tasks.md",
      "*** Update File: src/notes.md\n*** Move to: specs/001-x/tasks.md",
    ]) {
      const patchText = `*** Begin Patch\n${header}\n+- [ ] T001\n*** End Patch`
      expect(await decideToolCall("patch", { patchText }, "/tmp", active)).toBe(DENY_REASON)
    }
  })

  test("refuses a converge-style append of a convergence phase", async () => {
    const patchText =
      "*** Begin Patch\n*** Update File: specs/001-x/tasks.md\n@@\n+## Phase 4: Convergence\n*** End Patch"
    expect(await decideToolCall("patch", { patchText }, "/tmp", active)).toBe(DENY_REASON)
    const printf = "printf '## Phase 4: Convergence\\n' >> specs/001-x/tasks.md"
    expect(await decideToolCall("shell", { command: printf }, "/tmp", active)).toBe(DENY_REASON)
    const heredoc = "cat >> specs/001-x/tasks.md <<'EOF'\n## Phase 4: Convergence\nEOF"
    expect(await decideToolCall("shell", { command: heredoc }, "/tmp", active)).toBe(DENY_REASON)
  })

  test("refuses a shell write and allows a shell read", async () => {
    expect(await decideToolCall("shell", { command: "echo x > specs/001/tasks.md" }, "/tmp", active)).toBe(DENY_REASON)
    expect(await decideToolCall("shell", { command: "cat specs/001/tasks.md" }, "/tmp", active)).toBeUndefined()
  })
})

describe("tasksTargets", () => {
  test("probes the repository that holds the target, not the session directory", () => {
    expect(tasksTargets("write", { path: "/other/repo/specs/001-x/tasks.md" }, "/session")).toEqual(["/other/repo"])
    expect(tasksTargets("edit", { path: "specs/001-x/tasks.md" }, "/session")).toEqual(["/session"])
  })

  test("resolves a shell write against the call's workdir", () => {
    expect(tasksTargets("shell", { command: "echo x > specs/001-x/tasks.md", workdir: "/wt" }, "/session")).toEqual([
      "/wt",
    ])
    expect(tasksTargets("shell", { command: "echo x > specs/001-x/tasks.md", workdir: "sub" }, "/session")).toEqual([
      "/session/sub",
    ])
    expect(tasksTargets("shell", { command: "cat specs/001-x/tasks.md", workdir: "/wt" }, "/session")).toBeUndefined()
  })

  test("ignores malformed input", () => {
    expect(tasksTargets("write", null, "/session")).toBeUndefined()
    expect(tasksTargets("shell", { command: 3 }, "/session")).toBeUndefined()
  })
})
