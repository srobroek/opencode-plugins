import { describe, expect, test } from "bun:test"

import { applyPatterns, type Evaluation, matchPatterns, type PatternRule, wildcardMatch } from "./patterns.ts"

describe("wildcardMatch", () => {
  test("* matches any run and ? one character", () => {
    expect(wildcardMatch("git status", "git *")).toBe(true)
    expect(wildcardMatch("src/a.ts", "src/*.ts")).toBe(true)
    expect(wildcardMatch("a.ts", "?.ts")).toBe(true)
    expect(wildcardMatch("ab.ts", "?.ts")).toBe(false)
  })

  test("a trailing ' *' also matches the bare command", () => {
    expect(wildcardMatch("git push", "git push *")).toBe(true)
    expect(wildcardMatch("git push origin main", "git push *")).toBe(true)
    expect(wildcardMatch("git pushx", "git push *")).toBe(false)
  })

  test("is anchored, treats regex characters literally and spans newlines", () => {
    expect(wildcardMatch("xgit status", "git *")).toBe(false)
    expect(wildcardMatch("a+b(c)", "a+b(c)")).toBe(true)
    expect(wildcardMatch("aab", "a+b")).toBe(false)
    expect(wildcardMatch("echo a\necho b", "echo *")).toBe(true)
  })
})

const RULES: PatternRule[] = [
  { pattern: "git push --force*", effect: "deny", message: "Use --force-with-lease." },
  { pattern: "git push *", effect: "ask" },
  { pattern: "rm -rf *", effect: "deny", message: "no", action: "shell" },
]

describe("matchPatterns", () => {
  test("returns the first matching rule's decision", () => {
    expect(matchPatterns(["git push --force origin"], RULES)).toEqual({
      effect: "deny",
      message: "Use --force-with-lease.",
      pattern: "git push --force*",
      resource: "git push --force origin",
    })
    expect(matchPatterns(["ls", "git push"], RULES)).toEqual({
      effect: "ask",
      pattern: "git push *",
      resource: "git push",
    })
  })

  test("returns undefined when nothing matches", () => {
    expect(matchPatterns(["ls"], RULES)).toBeUndefined()
    expect(matchPatterns([], RULES)).toBeUndefined()
  })

  test("a rule with an action only matches that action", () => {
    expect(matchPatterns(["rm -rf /"], RULES)).toBeUndefined()
    expect(matchPatterns(["rm -rf /"], RULES, "edit")).toBeUndefined()
    expect(matchPatterns(["rm -rf /"], RULES, "shell")?.effect).toBe("deny")
  })
})

describe("applyPatterns", () => {
  test("sets effect and message on a match and leaves a miss alone", () => {
    const hit: Evaluation = { action: "shell", resources: ["rm -rf /tmp/x"], effect: "allow" }
    expect(applyPatterns(hit, RULES)?.pattern).toBe("rm -rf *")
    expect(hit).toMatchObject({ effect: "deny", message: "no" })

    const miss: Evaluation = { action: "shell", resources: ["ls"], effect: "allow" }
    expect(applyPatterns(miss, RULES)).toBeUndefined()
    expect(miss).toEqual({ action: "shell", resources: ["ls"], effect: "allow" })
  })
})
