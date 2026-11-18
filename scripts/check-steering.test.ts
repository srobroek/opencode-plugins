import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { checkLocalLinks, checkSkillFrontmatter, checkText, shippedMarkdown } from "./check-steering.ts"

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

describe("checkSkillFrontmatter", () => {
  const reasons = (text: string) => checkSkillFrontmatter("SKILL.md", text).map((finding) => finding.reason)

  test("accepts strict YAML with a name and description", () => {
    expect(reasons('---\nname: a\ndescription: "Use when x: y."\n---\nbody')).toEqual([])
  })

  test("rejects an unquoted colon-space, a missing field and missing frontmatter", () => {
    expect(reasons("---\nname: a\ndescription: Use when x: y.\n---\nbody")[0]).toContain("not valid YAML")
    expect(reasons("---\nname: a\n---\nbody")).toEqual(["frontmatter has no description"])
    expect(reasons("body")).toEqual(["SKILL.md has no frontmatter"])
  })
})

describe("checkLocalLinks", () => {
  const present = new Set(["s/references/a.md"])
  const missing = (text: string) =>
    checkLocalLinks("s/SKILL.md", text, (target) => present.has(target)).map((finding) => [finding.line, finding.match])

  test("flags a relative link whose file is missing, with its line", () => {
    expect(missing("ok\nRead [b](references/b.md).")).toEqual([[2, "references/b.md"]])
  })

  test("accepts an existing file, with or without an anchor, and skips URLs and absolute paths", () => {
    expect(
      missing("[a](references/a.md) [a](references/a.md#x) [w](https://example.com/x.md) [r](/abs.md) [m](mailto:x)"),
    ).toEqual([])
  })

  test("reads an angle-bracketed destination without its brackets", () => {
    expect(missing("[a](<references/a.md>) [b](<references/b.md>)")).toEqual([[1, "references/b.md"]])
  })

  test("checks a link with a title and a reference-style definition", () => {
    expect(
      missing('[a](references/a.md "A") [b](references/b.md "B")\n[c]: references/c.md\n[d]: <references/a.md> "D"'),
    ).toEqual([
      [1, "references/b.md"],
      [2, "references/c.md"],
    ])
  })

  test("ignores link-shaped text in code spans and fenced blocks", () => {
    expect(missing("`[x](gone.md)` ``[y](gone.md)``\n```md\n[z](gone.md)\n```\n[b](references/b.md)")).toEqual([
      [5, "references/b.md"],
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
