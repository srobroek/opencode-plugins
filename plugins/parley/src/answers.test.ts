import { describe, expect, test } from "bun:test"
import { canonical, describeAnswer, normaliseAnswer, publicAnswer, validateValue } from "./answers.ts"
import { coerceQuestion, type Question, recommendedValue, validateQuestions } from "./questions.ts"

const opts = [
  { id: "sqlite", label: "SQLite" },
  { id: "pg", label: "Postgres" },
  { id: "redis", label: "Redis" },
]

const pickOne: Question = { id: "auth.storage", title: "Storage", kind: "pick_one", options: opts, recommended: "sqlite" }
const pickMany: Question = { id: "scope", title: "Scope", kind: "pick_many", options: opts, recommended: ["pg", "sqlite"], max: 2 }
const rank: Question = { id: "prio", title: "Priority", kind: "rank", options: opts, recommended: ["redis"] }
const slider: Question = { id: "ttl", title: "TTL", kind: "slider", min: 0, max: 60, step: 5, recommended: 30 }

describe("validateQuestions", () => {
  test("accepts a mixed round", () => {
    expect(
      validateQuestions([
        pickOne,
        pickMany,
        rank,
        slider,
        { id: "go", title: "Go?", kind: "confirm", recommended: "yes" },
        { id: "name", title: "Name", kind: "ask_text", recommended: "parley" },
        { id: "plan", title: "Plan", kind: "review", markdown: "# Plan" },
      ]),
    ).toEqual([])
  })
  test("rejects duplicate ids, including ids already in the round", () => {
    expect(validateQuestions([pickOne, pickOne]).join()).toContain("duplicate id")
    expect(validateQuestions([pickOne], [pickOne]).join()).toContain("duplicate id")
  })
  test("rejects unknown recommended options and bad bounds", () => {
    expect(validateQuestions([{ ...pickOne, recommended: "mysql" }]).join()).toContain("unknown option")
    expect(validateQuestions([{ ...slider, min: 10, max: 10 }]).join()).toContain("min must be < max")
    expect(validateQuestions([{ ...slider, recommended: 99 }]).join()).toContain("outside")
    expect(validateQuestions([{ ...pickMany, min: 3, max: 2 }]).join()).toContain("min must be <= max")
  })
  test("requires options for option kinds and a diff for show_diff", () => {
    expect(validateQuestions([{ id: "x", title: "X", kind: "pick_one" }]).join()).toContain("at least 2")
    expect(validateQuestions([{ id: "x", title: "X", kind: "show_diff" }]).join()).toContain("diff")
  })
  test("rejects unknown kinds and empty input", () => {
    expect(validateQuestions([{ id: "x", title: "X", kind: "nope" }]).join()).toContain("kind must be")
    expect(validateQuestions([])).toEqual(["questions must be a non-empty array"])
  })
})

describe("recommendedValue", () => {
  test("completes a partial rank with the remaining options", () => {
    expect(recommendedValue(rank)).toEqual({ order: ["redis", "sqlite", "pg"] })
  })
  test("is undefined without a recommendation", () => {
    expect(recommendedValue({ ...pickOne, recommended: undefined })).toBeUndefined()
  })
})

describe("normaliseAnswer", () => {
  test("accepted fills in the recommendation", () => {
    expect(normaliseAnswer(pickOne, { id: pickOne.id, status: "accepted", note: "v1 only" })).toEqual({
      answer: {
        id: pickOne.id,
        status: "accepted",
        value: { selected: "sqlite" },
        accepted_recommendation: true,
        note: "v1 only",
      },
    })
  })
  test("an answer equal to the recommendation becomes accepted", () => {
    const result = normaliseAnswer(pickMany, { id: "scope", status: "answered", value: { selected: ["sqlite", "pg"] } })
    expect("answer" in result && result.answer.status).toBe("accepted")
  })
  test("a different answer stays answered", () => {
    const result = normaliseAnswer(pickOne, { id: pickOne.id, status: "answered", value: { selected: "pg" } })
    expect(result).toEqual({
      answer: { id: pickOne.id, status: "answered", value: { selected: "pg" }, accepted_recommendation: false },
    })
  })
  test("noted needs a note, deferred honours allow_defer", () => {
    expect(normaliseAnswer(pickOne, { id: pickOne.id, status: "noted" })).toHaveProperty("error")
    expect(normaliseAnswer(pickOne, { id: pickOne.id, status: "noted", note: "ask ops" })).toEqual({
      answer: { id: pickOne.id, status: "noted", note: "ask ops" },
    })
    expect(normaliseAnswer({ ...pickOne, allow_defer: false }, { id: pickOne.id, status: "deferred" })).toHaveProperty(
      "error",
    )
  })
  test("accepting without a recommendation fails", () => {
    expect(normaliseAnswer({ ...pickOne, recommended: undefined }, { id: pickOne.id, status: "accepted" })).toHaveProperty(
      "error",
    )
  })
})

describe("validateValue", () => {
  test("pick_many enforces max and allow_other", () => {
    expect(validateValue(pickMany, { selected: ["sqlite", "pg", "redis"] })).toHaveProperty("error")
    expect(validateValue(pickMany, { selected: [], other: "mongo" })).toHaveProperty("error")
  })
  test("pick_one allows other by default", () => {
    expect(validateValue(pickOne, { other: "mysql" })).toEqual({ value: { other: "mysql" } })
  })
  test("rank must be a permutation", () => {
    expect(validateValue(rank, { order: ["sqlite", "pg"] })).toHaveProperty("error")
    expect(validateValue(rank, { order: ["pg", "redis", "sqlite"] })).toEqual({ value: { order: ["pg", "redis", "sqlite"] } })
  })
  test("slider snaps to step and checks bounds", () => {
    expect(validateValue(slider, { value: 32 })).toEqual({ value: { value: 30 } })
    expect(validateValue(slider, { value: 61 })).toHaveProperty("error")
  })
  test("files are size checked and image kinds need image mimes", () => {
    const image: Question = { id: "shot", title: "Shot", kind: "ask_image" }
    expect(validateValue(image, { files: [{ name: "a.txt", mime: "text/plain", data: "aGk=" }] })).toHaveProperty("error")
    expect(validateValue(image, { files: [{ name: "a.png", mime: "image/png", data: "aGk=" }] })).toEqual({
      value: { files: [{ name: "a.png", mime: "image/png", size: 2, data: "aGk=" }] },
    })
  })
})

describe("output helpers", () => {
  test("publicAnswer strips file data", () => {
    const answer = {
      id: "f",
      status: "answered" as const,
      value: { files: [{ name: "a.png", mime: "image/png", size: 3, data: "aGk=" }] },
    }
    expect(publicAnswer(answer).value).toEqual({ files: [{ name: "a.png", mime: "image/png", size: 3 }] })
  })
  test("describeAnswer uses labels", () => {
    expect(
      describeAnswer(pickOne, { id: pickOne.id, status: "answered", value: { selected: "pg" }, note: "for now" }, 0),
    ).toBe("Q1 auth.storage [answered] → Postgres (note: for now)")
  })
  test("canonical ignores key order", () => {
    expect(canonical({ b: 1, a: [1, { d: 2, c: 3 }] })).toBe(canonical({ a: [1, { c: 3, d: 2 }], b: 1 }))
  })
})

describe("coerceQuestion", () => {
  test("turns numeric strings into numbers for slider bounds and recommendation", () => {
    expect(coerceQuestion({ id: "t", title: "T", kind: "slider", min: "5", max: 60, recommended: "15" })).toEqual({
      id: "t",
      title: "T",
      kind: "slider",
      min: 5,
      max: 60,
      recommended: 15,
    })
    expect(coerceQuestion({ id: "x", kind: "ask_text", recommended: "15" })).toMatchObject({ recommended: "15" })
  })
})
