import { describe, expect, test } from "bun:test"
import { GIT_VERSION_MESSAGE, gitVersionProblem, hardenedGitEnv, parseGitVersion } from "./safe-git.ts"

describe("gitVersionProblem", () => {
  test.each([
    ["git version 2.45.0", false],
    ["git version 2.56.1 (Apple Git-150)", false],
    ["git version 3.0.0", false],
    ["git version 2.44.9", true],
    ["git version 2.41.0", true],
    ["git version 1.9.0", true],
    ["", true],
    ["zsh: command not found: git", true],
  ])("%p -> problem: %p", (text, problem) => {
    expect(gitVersionProblem(text) !== undefined).toBe(problem)
  })
  test("names the minimum in the exact refusal message", () => {
    expect(gitVersionProblem("git version 2.44.0")).toBe("subagent-worktree needs git 2.45+ for safe automatic merges")
    expect(GIT_VERSION_MESSAGE).toBe("subagent-worktree needs git 2.45+ for safe automatic merges")
  })
  test("parses a version without a patch number", () => {
    expect(parseGitVersion("git version 2.50")).toEqual([2, 50, 0])
  })
})

describe("hardenedGitEnv", () => {
  test("appends to an existing GIT_CONFIG_COUNT and drops GIT_EXTERNAL_DIFF", () => {
    const env = hardenedGitEnv({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "a.b", GIT_CONFIG_VALUE_0: "c", GIT_EXTERNAL_DIFF: "evil", HOME: "/h" })
    expect(env.GIT_CONFIG_KEY_0).toBe("a.b")
    expect(env.GIT_CONFIG_KEY_1).toBe("core.fsmonitor")
    expect(env.GIT_CONFIG_VALUE_1).toBe("false")
    expect(env.GIT_EXTERNAL_DIFF).toBeUndefined()
    expect(env.HOME).toBe("/h")
  })
  test("sets the attribute source, optional locks and lazy fetch", () => {
    const env = hardenedGitEnv({})
    expect({ attr: env.GIT_ATTR_SOURCE, locks: env.GIT_OPTIONAL_LOCKS, lazy: env.GIT_NO_LAZY_FETCH }).toEqual({
      attr: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
      locks: "0",
      lazy: "1",
    })
  })
})
