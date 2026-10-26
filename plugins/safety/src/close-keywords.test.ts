import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { extractBody, normalize, replaceLastBody, rewriteCloseKeywords } from "./close-keywords.ts"

describe("normalize close-keyword lists", () => {
  test("expands comma issue lists after a keyword", () => {
    expect(normalize("Fixes #1, #2, and #3")).toBe("Fixes #1, fixes #2, and fixes #3")
  })

  test("handles owner/repo refs and GH- ids", () => {
    expect(normalize("Closes org/repo#4, GH-5")).toBe("Closes org/repo#4, closes GH-5")
  })

  test("leaves non-keyword text alone", () => {
    expect(normalize("See #1, #2")).toBe("See #1, #2")
  })

  test("is line-scoped", () => {
    expect(normalize("Fixes #1, #2\nNotes: keep")).toBe("Fixes #1, fixes #2\nNotes: keep")
  })
})

describe("extractBody / replaceLastBody", () => {
  test("extracts --body and -b forms", () => {
    expect(extractBody("gh pr create --body 'Fixes #1, #2'")).toBe("Fixes #1, #2")
    expect(extractBody("gh pr edit --body=Fixes\\ #1")).toBe("Fixes #1")
    expect(extractBody("FOO=1 gh pr create -b 'x'")).toBe("x")
  })

  test("replaceLastBody rewrites the last --body value", () => {
    expect(replaceLastBody("gh pr create --title t --body 'old'", "new")).toBe("gh pr create --title t --body 'new'")
  })

  test("body-valued option arguments and shell expansions are not reinterpreted", () => {
    expect(extractBody("gh pr create --body 'Fixes #1, #2' --title '--body'")).toBe("Fixes #1, #2")
    expect(replaceLastBody('gh pr create --body "$BODY"', "other")).toBeNull()
    expect(replaceLastBody("gh pr create --body 'unterminated", "other")).toBeNull()
  })
})

describe("rewriteCloseKeywords", () => {
  test("rewrites gh pr create and gh pr edit", () => {
    expect(rewriteCloseKeywords("gh pr create --title t --body 'Fixes #1, #2'")).toContain("Fixes #1, fixes #2")
    expect(rewriteCloseKeywords("gh pr edit 12 --body 'Closes #9, #10'")).toContain("Closes #9, closes #10")
  })

  test("passes through commands it does not change", () => {
    expect(rewriteCloseKeywords("gh issue list")).toBeUndefined()
    expect(rewriteCloseKeywords("gh pr create --body 'Fixes #1'")).toBeUndefined()
    expect(rewriteCloseKeywords(`gh pr create --body "$BODY" # Fixes #1, #2`)).toBeUndefined()
  })

  test("rewritten literal bodies remain data in a real shell and leave later bodies alone", () => {
    const body = "Fixes #1, #2; it's $(printf INJECTED >&2) `printf BACKTICK >&2`"
    const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`
    const command = `gh pr create -b old --body=${quote(body)}; gh issue edit 3 --body 'unrelated'`
    const rewritten = rewriteCloseKeywords(command) as string
    const run = spawnSync("bash", ["-c", `gh() { printf '%s\\0' "$@"; }; ${rewritten}`], {
      encoding: "utf8",
      timeout: 5_000,
    })
    expect(run.status).toBe(0)
    expect(run.stderr).toBe("")
    expect(run.stdout.split("\0")).toEqual([
      "pr",
      "create",
      "-b",
      "old",
      `--body=${normalize(body)}`,
      "issue",
      "edit",
      "3",
      "--body",
      "unrelated",
      "",
    ])
  })
})
