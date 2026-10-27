import { describe, expect, test } from "bun:test"
import { malformedNote, parseVerdict } from "./verdict.ts"

const json = (value: unknown) => `\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`

describe("parseVerdict", () => {
  test("reads the first line and the last json block of a delivery agent", () => {
    const text = `VERDICT: DONE — branch pushed\n\nEvidence...${json({ verdict: "NOPE" })}later${json({ verdict: "DONE", branch: "b", head: "abc" })}`
    expect(parseVerdict(text, "implementer")).toEqual({
      verdict: "DONE",
      agent: "implementer",
      summary: "branch pushed",
      fields: { verdict: "DONE", branch: "b", head: "abc" },
    })
  })

  test("tolerates leading whitespace and bold markup around the line", () => {
    expect(parseVerdict(`\n  **VERDICT: BLOCKED**${json({ verdict: "BLOCKED" })}`, "operator")).toMatchObject({
      verdict: "BLOCKED",
    })
  })

  test("the reviewer needs no json block", () => {
    expect(parseVerdict("VERDICT: REQUEST-CHANGES -- a.ts:3 drops the error", "pr-reviewer")).toEqual({
      verdict: "REQUEST-CHANGES",
      agent: "pr-reviewer",
      summary: "a.ts:3 drops the error",
    })
  })

  test("a delivery agent's verdict line below a preamble or inside a code fence counts, marked late", () => {
    expect(parseVerdict("I reviewed the diff.\n\nVERDICT: APPROVE -- diff only", "pr-reviewer")).toEqual({
      verdict: "APPROVE",
      agent: "pr-reviewer",
      summary: "diff only",
      late: true,
    })
    expect(parseVerdict(`\`\`\`\nVERDICT: DONE — answered\n\`\`\`${json({ verdict: "DONE" })}`, "researcher")).toMatchObject({
      verdict: "DONE",
      summary: "answered",
      late: true,
    })
    expect(parseVerdict("## `VERDICT: COMMENT`", "pr-reviewer")).toEqual({ verdict: "COMMENT", agent: "pr-reviewer" })
    expect(parseVerdict("Summary first.\nVERDICT: MAYBE", "pr-reviewer")).toMatchObject({ verdict: "MALFORMED" })
    expect(parseVerdict("No verdict here.\nPost a `VERDICT: APPROVE` comment.", "pr-reviewer")).toMatchObject({
      verdict: "MALFORMED",
    })
  })

  test("other agents' later verdict lines are ignored", () => {
    expect(parseVerdict("notes\nVERDICT: OK", undefined)).toBeUndefined()
  })

  test("a delivery agent that breaks the contract is MALFORMED", () => {
    expect(parseVerdict("Done! All good.", "implementer")).toMatchObject({ verdict: "MALFORMED" })
    expect(parseVerdict(`VERDICT: APPROVE${json({})}`, "implementer")).toMatchObject({ verdict: "MALFORMED" })
    expect(parseVerdict("VERDICT: DONE", "implementer")).toMatchObject({ verdict: "MALFORMED" })
    expect(parseVerdict("VERDICT: DONE\n```json\n{oops\n```", "researcher")).toMatchObject({ verdict: "MALFORMED" })
    expect(parseVerdict(`VERDICT: DONE${json([1])}`, "researcher")).toMatchObject({ verdict: "MALFORMED" })
    expect(parseVerdict(`VERDICT: DONE${json({ verdict: "BLOCKED" })}`, "operator")).toMatchObject({
      verdict: "MALFORMED",
    })
  })

  test("other agents are left alone unless they report a verdict", () => {
    expect(parseVerdict("here is what I found", undefined)).toBeUndefined()
    expect(parseVerdict("VERDICT: OK", undefined)).toEqual({ verdict: "OK" })
  })

  test("the malformed note names the session to continue", () => {
    expect(malformedNote({ reason: "x" }, "ses_1")).toContain("Continue sessionID ses_1")
    expect(malformedNote({ reason: "x" }, undefined)).not.toContain("sessionID")
  })
})
