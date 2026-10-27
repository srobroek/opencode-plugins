import { describe, expect, test } from "bun:test"
import type { Question } from "./questions.ts"
import {
  accept,
  arrowAction,
  badge,
  choose,
  enterIsNewline,
  initialDraft,
  moveCursor,
  parsePaths,
  rankMove,
  setNote,
  setText,
  sliderBar,
  step,
  submissions,
  toggleDefer,
  toSubmission,
} from "./tui-state.ts"

const options = [
  { id: "a", label: "A" },
  { id: "b", label: "B" },
  { id: "c", label: "C" },
]

describe("drafts", () => {
  test("recommended is preselected and submitted as an answer", () => {
    const question: Question = { id: "p", title: "P", kind: "pick_one", options, recommended: "b" }
    const draft = initialDraft(question)
    expect(draft).toMatchObject({ status: "answered", value: { selected: "b" }, cursor: 1 })
    expect(toSubmission(question, draft)).toEqual({ id: "p", status: "answered", value: { selected: "b" } })
  })

  test("no recommendation stays pending unless noted", () => {
    const question: Question = { id: "p", title: "P", kind: "pick_one", options }
    const draft = initialDraft(question)
    expect(toSubmission(question, draft)).toBeUndefined()
    expect(toSubmission(question, setNote(draft, "depends on ops"))).toEqual({
      id: "p",
      status: "noted",
      note: "depends on ops",
    })
  })

  test("choose, accept and defer", () => {
    const question: Question = { id: "m", title: "M", kind: "pick_many", options, recommended: ["a"], max: 2 }
    let draft = initialDraft(question)
    draft = choose(question, moveCursor(question, draft, 2))
    expect(draft.value).toEqual({ selected: ["a", "c"] })
    draft = choose(question, draft, 1)
    expect(draft.value).toEqual({ selected: ["a", "c"] })
    draft = accept(question, draft)
    expect(toSubmission(question, draft)).toEqual({ id: "m", status: "accepted" })
    draft = toggleDefer(draft, question)
    expect(toSubmission(question, setNote(draft, "later"))).toEqual({ id: "m", status: "deferred", note: "later" })
    expect(toggleDefer(draft, question).status).toBe("answered")
  })

  test("rank moves the item under the cursor", () => {
    const question: Question = { id: "r", title: "R", kind: "rank", options }
    let draft = initialDraft(question)
    expect(draft.status).toBe("unset")
    draft = rankMove(question, moveCursor(question, draft, 2), -1)
    expect(draft).toMatchObject({ status: "answered", cursor: 1, value: { order: ["a", "c", "b"] } })
    expect(rankMove(question, { ...draft, cursor: 0 }, -1)).toEqual({ ...draft, cursor: 0 })
  })

  test("slider and rate steps stay within bounds", () => {
    const slider: Question = { id: "s", title: "S", kind: "slider", min: 0, max: 10, step: 5, recommended: 5 }
    let draft = step(slider, initialDraft(slider), 1)
    expect(draft.value).toEqual({ value: 10 })
    draft = step(slider, draft, 1)
    expect(draft.value).toEqual({ value: 10 })
    expect(sliderBar(slider, 5, 10)).toBe("[━━━━━●─────]")
    const rate: Question = { id: "q", title: "Q", kind: "rate", options }
    const rated = step(rate, step(rate, initialDraft(rate), 1), 1)
    expect(rated.value).toEqual({ ratings: { a: 2 } })
  })

  test("text kinds and feedback", () => {
    const text: Question = { id: "t", title: "T", kind: "ask_text" }
    expect(setText(text, initialDraft(text), "hello").value).toEqual({ text: "hello" })
    const review: Question = { id: "v", title: "V", kind: "review", markdown: "plan", recommended: "approve" }
    const revised = setText(review, choose(review, initialDraft(review), 1), "split step 2")
    expect(revised.value).toEqual({ decision: "revise", feedback: "split step 2" })
    const pick: Question = { id: "p", title: "P", kind: "pick_one", options }
    expect(setText(pick, initialDraft(pick), " mine ").value).toEqual({ other: "mine" })
  })

  test("submissions skip pending cards", () => {
    const questions: Question[] = [
      { id: "x", title: "X", kind: "confirm", recommended: "yes" },
      { id: "y", title: "Y", kind: "confirm" },
    ]
    const drafts = Object.fromEntries(questions.map((question) => [question.id, initialDraft(question)]))
    expect(submissions(questions, drafts)).toEqual([{ id: "x", status: "answered", value: { choice: "yes" } }])
  })

  test("parsePaths", () => {
    expect(parsePaths("a.png, b.png\n c.png \n")).toEqual(["a.png", "b.png", "c.png"])
  })
})

describe("badge", () => {
  test("marks an unchanged recommendation", () => {
    const question: Question = { id: "c", title: "C", kind: "confirm", recommended: "yes" }
    expect(badge(initialDraft(question), question)).toBe("★ recommended")
    expect(badge(choose(question, initialDraft(question), 1), question)).toBe("● answered")
    expect(badge(toggleDefer(initialDraft(question), question), question)).toBe("⏸ deferred")
  })
})

describe("arrow keys", () => {
  const kind = (kind: Question["kind"], extra: Partial<Question> = {}) => ({ id: "q", title: "Q", kind, options, ...extra }) as Question

  test("side-by-side choices move with ←/→ and ↑/↓ change question", () => {
    for (const k of ["show_options", "emoji_react"] as const) {
      expect(arrowAction(kind(k), "left")).toEqual({ kind: "cursor", delta: -1 })
      expect(arrowAction(kind(k), "right")).toEqual({ kind: "cursor", delta: 1 })
      expect(arrowAction(kind(k), "up")).toEqual({ kind: "question", delta: -1 })
      expect(arrowAction(kind(k), "down")).toEqual({ kind: "question", delta: 1 })
    }
  })

  test("stacked rows move with ↑/↓; ←/→ do nothing unless there is a value to adjust", () => {
    for (const k of ["pick_one", "pick_many", "rank", "confirm", "thumbs", "review"] as const) {
      expect(arrowAction(kind(k), "down")).toEqual({ kind: "cursor", delta: 1 })
      expect(arrowAction(kind(k), "up")).toEqual({ kind: "cursor", delta: -1 })
      expect(arrowAction(kind(k), "right")).toBeUndefined()
    }
    expect(arrowAction(kind("rate"), "down")).toEqual({ kind: "cursor", delta: 1 })
    expect(arrowAction(kind("rate"), "left")).toEqual({ kind: "step", delta: -1 })
  })

  test("cards without rows pass ↑/↓ on to the next question", () => {
    const slider = kind("slider", { options: undefined, min: 0, max: 10 })
    expect(arrowAction(slider, "right")).toEqual({ kind: "step", delta: 1 })
    expect(arrowAction(slider, "down")).toEqual({ kind: "question", delta: 1 })
    expect(arrowAction(kind("ask_text", { options: undefined }), "up")).toEqual({ kind: "question", delta: -1 })
    expect(arrowAction(kind("ask_text", { options: undefined }), "left")).toBeUndefined()
  })

  test("the cursor stays on the side-by-side option it reaches", () => {
    const question = kind("show_options")
    const action = arrowAction(question, "right")
    const draft = moveCursor(question, initialDraft(question), action?.delta ?? 0)
    expect(choose(question, draft)).toMatchObject({ value: { selected: "b" } })
  })
})

describe("enter in text fields", () => {
  test("saves notes and answers, but starts a new line in code", () => {
    const text = { id: "t", title: "T", kind: "ask_text" } as Question
    const code = { id: "c", title: "C", kind: "ask_code" } as Question
    expect(enterIsNewline(text, "text")).toBe(false)
    expect(enterIsNewline(text, "note")).toBe(false)
    expect(enterIsNewline(code, "note")).toBe(false)
    expect(enterIsNewline(code, "text")).toBe(true)
  })
})
