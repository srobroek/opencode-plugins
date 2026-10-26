import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { checkText, shippedMarkdown } from "./check-steering.ts"

const matches = (text: string) => checkText("x.md", text).map((finding) => finding.match)

describe("checkText", () => {
  test("flags omp URI schemes", () => {
    expect(matches("Load skill://debate and rule://design-no-slop.")).toEqual(["skill://", "rule://"])
    expect(matches("agent://a proc:// xd://generate_image history://x")).toEqual([
      "agent://",
      "proc://",
      "xd://",
      "history://",
    ])
    expect(matches("See https://example.com and git://host/repo.")).toEqual([])
  })

  test("flags backticked omp tool names but not code fences or prose words", () => {
    expect(matches("Run it with `bash`, spawn via `task`, inspect with `eval`.")).toEqual(["`bash`", "`task`", "`eval`"])
    expect(matches("```bash\nls\n```")).toEqual([])
    expect(matches("Find the task and run bash.")).toEqual([])
  })

  test("flags omp tool identifiers, TTSR and omp CLI paths", () => {
    expect(matches("use ast_grep or web_search")).toEqual(["ast_grep", "web_search"])
    expect(matches("a TTSR rule")).toEqual(["TTSR"])
    expect(matches("omp plugin install x; edit ~/.omp/agent")).toEqual(["omp plugin", "~/.omp"])
  })

  test("reports line numbers", () => {
    expect(checkText("x.md", "ok\nskill://a")).toEqual([
      { file: "x.md", line: 2, match: "skill://", reason: expect.stringContaining("skill://") },
    ])
  })
})

describe("shippedMarkdown", () => {
  test("collects markdown under skills/ and agents/ only", () => {
    const dir = mkdtempSync(join(tmpdir(), "steering-"))
    try {
      mkdirSync(join(dir, "a", "skills", "s", "references"), { recursive: true })
      mkdirSync(join(dir, "a", "agents"))
      writeFileSync(join(dir, "a", "README.md"), "skill://ignored")
      writeFileSync(join(dir, "a", "skills", "s", "SKILL.md"), "")
      writeFileSync(join(dir, "a", "skills", "s", "references", "r.md"), "")
      writeFileSync(join(dir, "a", "skills", "s", "LICENSE"), "")
      writeFileSync(join(dir, "a", "agents", "x.md"), "")
      expect(shippedMarkdown(dir).map((file) => file.slice(dir.length + 1))).toEqual([
        "a/skills/s/SKILL.md",
        "a/skills/s/references/r.md",
        "a/agents/x.md",
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
