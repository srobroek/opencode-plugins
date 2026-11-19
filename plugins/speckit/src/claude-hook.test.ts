import { describe, expect, test } from "bun:test"
import { CLAUDE_DENY_REASON, claudeDecision, type HookInput, type PreToolUseOutput } from "./claude-hook.ts"

const active = async () => true
const inactive = async () => false
const call = (tool_name: string, tool_input: Record<string, unknown>): HookInput => ({ cwd: "/repo", tool_name, tool_input })

const denied: PreToolUseOutput = {
  hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: CLAUDE_DENY_REASON },
}

describe("claudeDecision", () => {
  test.each([
    ["an Edit of tasks.md", call("Edit", { file_path: "/repo/specs/001-a/tasks.md", old_string: "a", new_string: "b" })],
    ["a Write of a relative tasks.md", call("Write", { file_path: "specs/001-a/tasks.md", content: "x" })],
    ["a Bash redirect into tasks.md", call("Bash", { command: "echo x > specs/001-a/tasks.md" })],
  ])("denies %s while beads is active", async (_, input) => {
    expect(await claudeDecision(input, active)).toEqual(denied)
  })

  test.each([
    ["the same Edit without an active beads workspace", call("Edit", { file_path: "/repo/specs/001-a/tasks.md" }), inactive],
    ["a read of tasks.md through Bash", call("Bash", { command: "cat specs/001-a/tasks.md" }), active],
    ["an Edit of spec.md", call("Edit", { file_path: "/repo/specs/001-a/spec.md" }), active],
    ["a tool the guard does not cover", call("Read", { file_path: "/repo/specs/001-a/tasks.md" }), active],
  ])("allows %s", async (_, input, probe) => {
    expect(await claudeDecision(input, probe)).toBeUndefined()
  })

  test("fails open when the beads probe throws", async () => {
    const broken = async (): Promise<boolean> => {
      throw new Error("bd missing")
    }
    expect(await claudeDecision(call("Write", { file_path: "/repo/specs/001-a/tasks.md" }), broken)).toBeUndefined()
  })

  test("the refusal drops the OpenCode option hint", () => {
    expect(CLAUDE_DENY_REASON).toEndWith("Do not create tasks.md to get past the check.")
  })
})
