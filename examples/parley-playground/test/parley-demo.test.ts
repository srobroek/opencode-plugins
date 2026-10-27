import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { MAX_QUESTIONS, KINDS as PARLEY_KINDS, validateQuestions } from "../../../plugins/parley/src/questions.ts"
import { describeError, describeResult, KINDS, kindQuestions, plan, type Samples, sections, stillOpen } from "../.opencode/plugins/parley-demo/rounds.ts"

const dir = path.resolve(import.meta.dirname, "../samples")
const samples: Samples = {
  dir,
  plan: readFileSync(path.join(dir, "plan.md"), "utf8"),
  diff: readFileSync(path.join(dir, "change.diff"), "utf8"),
}

const asks = (args: string) => {
  const planned = plan(args, samples)
  if (!("steps" in planned)) throw new Error(`no steps for ${args}`)
  return planned.steps.filter((step) => step.tool === "parley_ask")
}

describe("demo rounds", () => {
  test("cover every parley kind", () => {
    expect([...KINDS].sort()).toEqual([...PARLEY_KINDS].sort())
    expect(Object.keys(kindQuestions(samples)).sort()).toEqual([...PARLEY_KINDS].sort())
  })

  test("every ask passes parley's validation and fits in a round", () => {
    for (const args of ["all", "files", "statuses", "wait", "timeout", "fallback", ...KINDS])
      for (const step of asks(args)) {
        const questions = (step.input as { questions: unknown[] }).questions
        expect(questions.length).toBeLessThanOrEqual(MAX_QUESTIONS)
        expect(validateQuestions(questions)).toEqual([])
      }
  })

  test("all asks every kind across its rounds", () => {
    const kinds = asks("all").flatMap((step) => (step.input as { questions: readonly { kind: string }[] }).questions.map((q) => q.kind))
    expect(kinds.sort()).toEqual([...PARLEY_KINDS].sort())
  })
})

describe("plan", () => {
  test("accepts the arguments with or without the command name", () => {
    expect(plan("/parley-demo confirm", samples)).toEqual(plan("confirm", samples))
    expect(plan("  ", samples)).toEqual({ special: "help" })
    expect(plan("cancel", samples)).toEqual({ special: "cancel" })
  })

  test("rejects unknown subcommands with the usage", () => {
    const planned = plan("bogus", samples)
    expect("error" in planned && planned.error).toContain("Usage: /parley-demo")
  })

  test("wait follows up with parley_wait; timeout does not", () => {
    const wait = plan("wait", samples)
    expect("steps" in wait && wait.steps.map((step) => step.tool)).toEqual(["parley_ask", "parley_wait", "parley_wait"])
    const timeout = plan("timeout", samples)
    expect("steps" in timeout && timeout.steps[0]?.input).toMatchObject({ timeout_s: 15 })
    expect("steps" in timeout && timeout.steps).toHaveLength(1)
  })
})

test("sections splits markdown at level-two headings", () => {
  expect(sections("# T\nintro\n## Goal\ng\n## Risks\nr").map((s) => [s.id, s.title])).toEqual([
    ["overview", "Overview"],
    ["goal", "Goal"],
    ["risks", "Risks"],
  ])
})

test("describeResult shows the summary and files, and keeps the JSON for the model", () => {
  const message = describeResult("files", "parley_ask", {
    content: [
      { type: "text", text: "Parley round 1: submitted" },
      { type: "file", name: "diagram.png", mime: "image/png", uri: "data:image/png;base64,AAAA" },
    ],
    output: { status: "submitted" },
  })
  expect(message.description).toContain("Parley round 1: submitted")
  expect(message.description).toContain("diagram.png (image/png)")
  expect(message.description).not.toContain("base64")
  expect(message.text).toContain('"status": "submitted"')
  expect(describeError("x", "parley_ask", new Error("boom")).text).toContain("threw: boom")
})

test("stillOpen", () => {
  expect(stillOpen({ output: { status: "partial" } })).toBe(true)
  expect(stillOpen({ output: { status: "timeout" } })).toBe(false)
  expect(stillOpen({ output: { status: "submitted" } })).toBe(false)
})
