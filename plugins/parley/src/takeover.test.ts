import { describe, expect, test } from "bun:test"
import type { Prompt } from "./fallback.ts"
import type { Question } from "./questions.ts"
import { fromPrompts, nativeAnswer, nativeResult, nativeSummary, nativeText, shouldTakeOver } from "./takeover.ts"

const db: Prompt = {
  question: "Which database should we use?",
  header: "Database",
  options: [
    { label: "SQLite (Recommended)", description: "Embedded, zero setup" },
    { label: "Postgres", description: "Postgres" },
  ],
}
const extras: Prompt = {
  question: "Which extras?",
  header: "Extras",
  multiple: true,
  options: [
    { label: "Auth (Recommended)", description: "Login" },
    { label: "Billing", description: "Stripe" },
    { label: "Search (recommended)", description: "Full text" },
  ],
}
const name: Prompt = { question: "Project name?", header: "", options: [] }

const mapped = (prompts: Prompt[]) => {
  const result = fromPrompts(prompts)
  if ("errors" in result) throw new Error(result.errors.join("; "))
  return result.questions
}

describe("fromPrompts", () => {
  test("maps options, multiple, headers and the (Recommended) suffix", () => {
    const [one, many, text] = mapped([db, extras, name])
    expect(one).toEqual({
      id: "q1",
      title: "Database",
      body: "Which database should we use?",
      kind: "pick_one",
      allow_other: true,
      options: [
        { id: "o1", label: "SQLite", description: "Embedded, zero setup" },
        { id: "o2", label: "Postgres" },
      ],
      recommended: "o1",
    })
    expect(many).toMatchObject({ kind: "pick_many", allow_other: true, recommended: ["o1", "o3"] })
    expect(many?.options?.map((option) => option.label)).toEqual(["Auth", "Billing", "Search"])
    expect(text).toEqual({ id: "q3", title: "Project name?", body: "Project name?", kind: "ask_text" })
  })

  test("no suffix means no recommendation", () => {
    const [one] = mapped([{ ...db, options: [{ label: "A", description: "" }, { label: "B", description: "" }] }])
    expect(one).not.toHaveProperty("recommended")
  })

  test("reports calls parley cannot ask", () => {
    expect(fromPrompts([{ ...db, options: [{ label: "Only", description: "" }] }])).toHaveProperty("errors")
    expect(fromPrompts([])).toHaveProperty("errors")
  })
})

describe("shouldTakeOver", () => {
  test("needs takeover on, parley enabled and a heartbeat", () => {
    expect(shouldTakeOver({ questionTool: "takeover", disabled: false }, true)).toBe(true)
    expect(shouldTakeOver({ questionTool: "takeover", disabled: false }, false)).toBe(false)
    expect(shouldTakeOver({ questionTool: "off", disabled: false }, true)).toBe(false)
    expect(shouldTakeOver({ questionTool: "takeover", disabled: true }, true)).toBe(false)
  })
})

describe("native result", () => {
  const questions = mapped([db, extras, name])
  const [one, many, text] = questions as [Question, Question, Question]

  test("answers carry the labels as the model wrote them, plus free text", () => {
    expect(nativeAnswer(db, one, { id: "q1", status: "accepted", value: { selected: "o1" } })).toEqual([
      "SQLite (Recommended)",
    ])
    expect(nativeAnswer(db, one, { id: "q1", status: "answered", value: { other: "DuckDB" } })).toEqual(["DuckDB"])
    expect(
      nativeAnswer(extras, many, { id: "q2", status: "answered", value: { selected: ["o2", "o3"], other: "Chat" } }),
    ).toEqual(["Billing", "Search (recommended)", "Chat"])
    expect(nativeAnswer(name, text, { id: "q3", status: "answered", value: { text: "atlas" } })).toEqual(["atlas"])
    expect(nativeAnswer(db, one, { id: "q1", status: "deferred" })).toEqual([])
    expect(nativeAnswer(db, one, undefined)).toEqual([])
  })

  test("text matches the built-in tool and appends notes and deferrals", () => {
    expect(nativeText([{ question: "Q?", answer: ["A"], deferred: false }])).toBe(
      'User has answered your questions: "Q?"="A". You can now continue with the user\'s answers in mind.',
    )
    const result = nativeResult([db, extras, name], questions, {
      status: "submitted",
      round: 2,
      answers: [
        { id: "q1", status: "answered", value: { selected: "o2" }, note: "we already run it" },
        { id: "q2", status: "deferred", note: "ask product" },
      ],
      pending: ["q3"],
    })
    expect(result.output).toEqual({ answers: [["Postgres"], [], []] })
    expect(result.metadata.answers).toEqual(result.output.answers)
    expect(result.metadata.parley).toMatchObject({ round: 2, pending: ["q3"] })
    expect(result.content).toBe(
      [
        'User has answered your questions: "Which database should we use?"="Postgres", "Which extras?"="Unanswered", "Project name?"="Unanswered". You can now continue with the user\'s answers in mind.',
        'Note on "Which database should we use?": we already run it',
        'Note on "Which extras?": ask product',
        'Deferred (the user will answer later): "Which extras?"',
      ].join("\n"),
    )
  })

  test("parley_ask native summary uses titles and plain text answers", () => {
    const text = nativeSummary(
      {
        status: "submitted",
        answers: [
          { id: "q1", status: "accepted", value: { selected: "o1" } },
          { id: "q3", status: "answered", value: { text: "atlas" } },
        ],
        pending: ["q2"],
      },
      questions,
    )
    expect(text).toBe(
      'User has answered your questions: "Database"="SQLite", "Extras"="Unanswered", "Project name?"="atlas". You can now continue with the user\'s answers in mind.',
    )
  })
})
