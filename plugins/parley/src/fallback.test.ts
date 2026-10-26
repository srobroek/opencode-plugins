import { describe, expect, test } from "bun:test"
import { fromQuestionTool, RECOMMENDED_SUFFIX, toPrompt, toSubmitted, unsupported } from "./fallback.ts"
import type { Question } from "./questions.ts"

const options = [
  { id: "a", label: "Alpha", description: "first", pros: ["fast"], cons: ["lock-in"] },
  { id: "b", label: "Beta" },
]

describe("toPrompt", () => {
  test("puts the recommended option first with the suffix", () => {
    const prompt = toPrompt({
      id: "x",
      title: "A very long question title that exceeds thirty",
      kind: "show_options",
      body: "First paragraph.\n\nSecond paragraph.",
      rationale: "cheaper",
      options,
      recommended: "b",
    })
    expect(prompt.header.length).toBeLessThanOrEqual(30)
    expect(prompt.question).toBe("First paragraph.\n\nWhy: cheaper")
    expect(prompt.options.map((option) => option.label)).toEqual([`Beta${RECOMMENDED_SUFFIX}`, "Alpha"])
    expect(prompt.options[1]?.description).toBe("first +fast −lock-in")
  })
  test("maps confirm, pick_many and ask_text", () => {
    expect(toPrompt({ id: "c", title: "Go", kind: "confirm", recommended: "no" }).options[0]?.label).toBe(
      `No${RECOMMENDED_SUFFIX}`,
    )
    expect(toPrompt({ id: "m", title: "M", kind: "pick_many", options, recommended: ["a"] }).multiple).toBe(true)
    expect(toPrompt({ id: "t", title: "T", kind: "ask_text", recommended: "parley" }).options).toEqual([
      { label: "Use recommended", description: "parley" },
    ])
    expect(toPrompt({ id: "t", title: "T", kind: "ask_text" }).options).toEqual([])
  })
})

describe("toSubmitted", () => {
  const pick: Question = { id: "p", title: "P", kind: "pick_one", options, recommended: "a" }
  test("matches labels with or without the suffix", () => {
    expect(toSubmitted(pick, [`Alpha${RECOMMENDED_SUFFIX}`])).toEqual({ id: "p", status: "answered", value: { selected: "a" } })
    expect(toSubmitted(pick, ["beta"])).toEqual({ id: "p", status: "answered", value: { selected: "b" } })
  })
  test("free text becomes other, defer words defer", () => {
    expect(toSubmitted(pick, ["Gamma"])).toEqual({ id: "p", status: "answered", value: { other: "Gamma" } })
    expect(toSubmitted(pick, ["not sure"])).toEqual({ id: "p", status: "deferred" })
    expect(toSubmitted(pick, [])).toMatchObject({ status: "deferred" })
  })
  test("confirm and ask_text", () => {
    expect(toSubmitted({ id: "c", title: "C", kind: "confirm" }, ["Yes (Recommended)"])).toMatchObject({
      value: { choice: "yes" },
    })
    expect(toSubmitted({ id: "t", title: "T", kind: "ask_text", recommended: "x" }, ["Use recommended"])).toEqual({
      id: "t",
      status: "accepted",
    })
  })
})

describe("fromQuestionTool", () => {
  test("normalises a round of answers", () => {
    const questions: Question[] = [
      { id: "p", title: "P", kind: "pick_one", options, recommended: "a" },
      { id: "m", title: "M", kind: "pick_many", options },
      { id: "t", title: "T", kind: "ask_text" },
    ]
    const answers = fromQuestionTool(questions, [["Alpha (Recommended)"], ["Alpha", "Beta", "and more"], ["hello"]])
    expect(answers).toEqual([
      { id: "p", status: "accepted", value: { selected: "a" }, accepted_recommendation: true },
      {
        id: "m",
        status: "answered",
        value: { selected: ["a", "b"] },
        accepted_recommendation: false,
        note: "and more",
      },
      { id: "t", status: "answered", value: { text: "hello" }, accepted_recommendation: false },
    ])
  })
  test("unsupported lists kinds the question tool cannot carry", () => {
    expect(unsupported([{ id: "r", title: "R", kind: "rank", options }])).toEqual(["r"])
  })
})
