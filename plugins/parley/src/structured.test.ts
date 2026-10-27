import { describe, expect, test } from "bun:test"
import { describeValue, normaliseAnswer, validateValue } from "./answers.ts"
import { type Question, recommendedValue, validateQuestions } from "./questions.ts"
import {
  canonicalHex,
  isStructured,
  NEW_KINDS,
  structuredDefault,
  structuredSummary,
  validateStructuredQuestion,
  validateStructuredValue,
  validTemporal,
} from "./structured.ts"
import { nativeAnswer } from "./takeover.ts"

const items = [
  { id: "a", label: "Alpha" },
  { id: "b", label: "Beta" },
]
const options = [
  { id: "x", label: "Ex" },
  { id: "y", label: "Why" },
]

const form: Question = {
  id: "f",
  title: "Form",
  kind: "form",
  config: {
    fields: [
      { id: "name", label: "Name", type: "text", required: true },
      { id: "count", label: "Count", type: "number", min: 1, max: 10 },
      { id: "tier", label: "Tier", type: "choice", options: ["free", "pro"] },
      { id: "on", label: "On", type: "toggle" },
    ],
  },
}
const buckets: Question = {
  id: "bk",
  title: "Buckets",
  kind: "buckets",
  config: { items: [...items, { id: "c", label: "Gamma" }], categories: [{ id: "keep", label: "Keep" }, { id: "drop", label: "Drop" }] },
}
const match: Question = {
  id: "m",
  title: "Match",
  kind: "match",
  config: { items, targets: [{ id: "one", label: "One" }, { id: "two", label: "Two" }] },
}
const allocate: Question = { id: "al", title: "Allocate", kind: "allocate", options, config: { total: 10 } }
const matrix: Question = {
  id: "mx",
  title: "Matrix",
  kind: "matrix",
  options,
  config: { criteria: [{ id: "cost", label: "Cost" }, { id: "speed", label: "Speed" }] },
  min: 0,
  max: 1,
  step: 0.5,
}
const range: Question = { id: "r", title: "Range", kind: "range", min: 0, max: 10, step: 2, unit: "ms" }
const path: Question = { id: "p", title: "Path", kind: "path", multiple: true }
const date: Question = { id: "d", title: "Date", kind: "date", config: { min: "2024-01-01", max: "2024-12-31" } }
const time: Question = { id: "t", title: "Time", kind: "time", config: { min: "09:00", max: "17:00" } }
const datetime: Question = { id: "dt", title: "When", kind: "datetime" }
const tags: Question = { id: "tg", title: "Tags", kind: "tags", config: { suggestions: ["ui", "api"] }, min: 1, max: 2 }
const colour: Question = { id: "c", title: "Colour", kind: "colour", config: { swatches: ["#FF0000", "#00ff00"] } }

const all = [form, buckets, match, allocate, matrix, range, path, date, time, datetime, tags, colour]

const ok = (question: Question, value: unknown) => validateStructuredValue(question, value)
const err = (question: Question, value: unknown) => {
  const result = validateStructuredValue(question, value)
  return "error" in result ? result.error : undefined
}
const configErrors = (question: Question) => validateStructuredQuestion(question).join("\n")

describe("kinds", () => {
  test("every new kind is a structured kind and accepted by validateQuestions", () => {
    expect(all.map((question) => question.kind).sort()).toEqual([...NEW_KINDS].sort())
    expect(all.every(isStructured)).toBe(true)
    expect(isStructured({ kind: "pick_one" })).toBe(false)
    expect(validateQuestions(all)).toEqual([])
  })
})

describe("question config validation never throws on untrusted input", () => {
  const junk: unknown[] = [undefined, null, 1, "x", [], {}, [null], [{}], [{ id: 1 }], { fields: "x" }]
  test.each(NEW_KINDS.map((kind) => [kind]))("%s", (kind) => {
    for (const config of junk)
      expect(() => validateStructuredQuestion({ id: "q", title: "Q", kind, config: config as never })).not.toThrow()
  })
})

describe("config validation", () => {
  const cases: [string, Question, string][] = [
    ["form without config", { id: "f", title: "F", kind: "form" }, "config is required"],
    ["form empty fields", { ...form, config: { fields: [] } }, "non-empty"],
    ["form duplicate field id", { ...form, config: { fields: [{ id: "a", label: "A", type: "text" }, { id: "a", label: "B", type: "toggle" }] } }, "duplicate id a"],
    ["form bad id", { ...form, config: { fields: [{ id: "-a", label: "A", type: "text" }] } }, ".id must match"],
    ["form bad type", { ...form, config: { fields: [{ id: "a", label: "A", type: "date" as never }] } }, ".type must be one of"],
    ["form choice without options", { ...form, config: { fields: [{ id: "a", label: "A", type: "choice" }] } }, ".options must be a non-empty array"],
    ["form duplicate choices", { ...form, config: { fields: [{ id: "a", label: "A", type: "choice", options: ["x", "x"] }] } }, "duplicates"],
    ["form non-finite min", { ...form, config: { fields: [{ id: "a", label: "A", type: "number", min: Number.NaN }] } }, "finite"],
    ["form min > max", { ...form, config: { fields: [{ id: "a", label: "A", type: "number", min: 2, max: 1 }] } }, "min must be <= max"],
    ["buckets duplicate item", { ...buckets, config: { items: [items[0], items[0]], categories: [{ id: "k", label: "K" }] } } as Question, "duplicate id a"],
    ["buckets missing label", { ...buckets, config: { items: [{ id: "a" }], categories: [{ id: "k", label: "K" }] } } as never, "label is required"],
    ["buckets no categories", { ...buckets, config: { items } }, "config.categories must be a non-empty array"],
    ["match unequal", { ...match, config: { items, targets: [{ id: "one", label: "One" }] } }, "same number"],
    ["match duplicate target", { ...match, config: { items, targets: [{ id: "one", label: "One" }, { id: "one", label: "Uno" }] } }, "duplicate id one"],
    ["allocate no options", { ...allocate, options: [] }, "options must be a non-empty array"],
    ["allocate duplicate option", { ...allocate, options: [options[0], options[0]] } as Question, "duplicate id x"],
    ["allocate zero total", { ...allocate, config: { total: 0 } }, "positive"],
    ["allocate infinite total", { ...allocate, config: { total: Number.POSITIVE_INFINITY } }, "positive finite"],
    ["matrix duplicate criterion", { ...matrix, config: { criteria: [{ id: "c", label: "C" }, { id: "c", label: "D" }] } }, "duplicate id c"],
    ["matrix min >= max", { ...matrix, min: 5, max: 5 }, "min must be < max"],
    ["matrix bad step", { ...matrix, step: 0 }, "step must be a positive"],
    ["range without bounds", { id: "r", title: "R", kind: "range" }, "min and max are required"],
    ["range infinite bound", { ...range, max: Number.POSITIVE_INFINITY }, "finite"],
    ["range min >= max", { ...range, min: 3, max: 3 }, "min must be < max"],
    ["range negative step", { ...range, step: -1 }, "step must be a positive"],
    ["path bad mode", { ...path, config: { mode: "all" as never } }, "config.mode must be one of"],
    ["date impossible min", { ...date, config: { min: "2023-02-29" } }, "valid YYYY-MM-DD"],
    ["date min > max", { ...date, config: { min: "2024-02-01", max: "2024-01-01" } }, "config.min must be <= config.max"],
    ["time bad max", { ...time, config: { max: "24:00" } }, "valid HH:mm"],
    ["datetime bad min", { ...datetime, config: { min: "2024-01-01 10:00" } }, "valid YYYY-MM-DDTHH:mm"],
    ["tags duplicate suggestions", { ...tags, config: { suggestions: ["a", " a"] } }, "duplicates"],
    ["tags blank suggestion", { ...tags, config: { suggestions: [" "] } }, "non-empty strings"],
    ["tags fractional min", { ...tags, min: 1.5 }, "non-negative integer"],
    ["tags min > max", { ...tags, min: 3, max: 2 }, "min must be <= max"],
    ["colour bad swatch", { ...colour, config: { swatches: ["#fff"] } }, "#RRGGBB"],
    ["colour duplicate swatch", { ...colour, config: { swatches: ["#ABCDEF", "#abcdef"] } }, "duplicates"],
    ["config not an object", { ...path, config: [] as never }, "config must be an object"],
  ]
  test.each(cases)("%s", (_name, question, expected) => {
    expect(configErrors(question)).toContain(expected)
  })
  test("validateQuestions prefixes structured errors with the question", () => {
    expect(validateQuestions([{ ...range, min: 3, max: 3 }]).join()).toContain("questions[0] (r): min must be < max")
  })
})

describe("value validation", () => {
  const good: [Question, unknown, unknown][] = [
    [form, { fields: { name: "n", count: 1, tier: "pro", on: true } }, { fields: { name: "n", count: 1, tier: "pro", on: true } }],
    [buckets, { buckets: { keep: ["b", "a"], drop: ["c"] } }, { buckets: { keep: ["b", "a"], drop: ["c"] } }],
    [match, { pairs: { a: "two", b: "one" } }, { pairs: { a: "two", b: "one" } }],
    [allocate, { allocations: { x: 0.1 + 0.2, y: 10 - 0.3 } }, { allocations: { x: 0.1 + 0.2, y: 10 - 0.3 } }],
    [matrix, { scores: { x: { cost: 0, speed: 0.5 }, y: { cost: 1, speed: 1 } } }, { scores: { x: { cost: 0, speed: 0.5 }, y: { cost: 1, speed: 1 } } }],
    [range, { min: 2, max: 2 }, { min: 2, max: 2 }],
    [range, { min: 0, max: 10 }, { min: 0, max: 10 }],
    [path, { paths: ["src/", "README.md"], data: "x" }, { paths: ["src/", "README.md"] }],
    [date, { value: "2024-02-29" }, { value: "2024-02-29" }],
    [time, { value: "17:00" }, { value: "17:00" }],
    [datetime, { value: "2000-02-29T23:59" }, { value: "2000-02-29T23:59" }],
    [tags, { tags: [" ui ", "new"] }, { tags: ["ui", "new"] }],
    [colour, { hex: "#ABC" }, { hex: "#aabbcc" }],
    [colour, { hex: "#A1B2C3" }, { hex: "#a1b2c3" }],
  ]
  test.each(good)("%#: %p accepts", (question, value, cleaned) => {
    expect(ok(question, value)).toEqual({ value: cleaned })
  })

  const bad: [Question, unknown, string][] = [
    [form, "x", "value must be an object"],
    [form, { fields: { name: "n", count: 1, tier: "pro" } }, "missing field on"],
    [form, { fields: { name: "n", count: 1, tier: "pro", on: true, extra: 1 } }, "unknown field extra"],
    [form, { fields: { name: " ", count: 1, tier: "pro", on: true } }, "field name is required"],
    [form, { fields: { name: "n", count: 0, tier: "pro", on: true } }, "must be >= 1"],
    [form, { fields: { name: "n", count: 11, tier: "pro", on: true } }, "must be <= 10"],
    [form, { fields: { name: "n", count: Number.NaN, tier: "pro", on: true } }, "finite"],
    [form, { fields: { name: "n", count: 1, tier: "gold", on: true } }, "one of its options"],
    [form, { fields: { name: "n", count: 1, tier: "pro", on: "yes" } }, "boolean"],
    [buckets, { buckets: { keep: ["a", "b"] } }, "missing category drop"],
    [buckets, { buckets: { keep: ["a", "b", "c"], drop: [], other: [] } }, "unknown category other"],
    [buckets, { buckets: { keep: ["a", "b"], drop: ["a", "c"] } }, "placed more than once"],
    [buckets, { buckets: { keep: ["a", "b"], drop: [] } }, "item c is not placed"],
    [buckets, { buckets: { keep: ["a", "b", "z"], drop: ["c"] } }, "unknown item"],
    [match, { pairs: { a: "one" } }, "missing item b"],
    [match, { pairs: { a: "one", b: "one" } }, "matched more than once"],
    [match, { pairs: { a: "one", b: "three" } }, "unknown target"],
    [match, { pairs: { a: "one", b: "two", c: "one" } }, "unknown item c"],
    [allocate, { allocations: { x: 5, y: 4 } }, "add up to 10"],
    [allocate, { allocations: { x: 5, y: 5 + 1e-7 } }, "add up to 10"],
    [allocate, { allocations: { x: 11, y: -1 } }, "non-negative"],
    [allocate, { allocations: { x: 10 } }, "missing option y"],
    [allocate, { allocations: { x: 10, y: 0, z: 0 } }, "unknown option z"],
    [allocate, { allocations: { x: Number.POSITIVE_INFINITY, y: 0 } }, "finite"],
    [matrix, { scores: { x: { cost: 0, speed: 0 } } }, "missing option y"],
    [matrix, { scores: { x: { cost: 0 }, y: { cost: 0, speed: 0 } } }, "missing criterion"],
    [matrix, { scores: { x: { cost: 0, speed: 0, extra: 0 }, y: { cost: 0, speed: 0 } } }, "unknown criterion"],
    [matrix, { scores: { x: { cost: 0.25, speed: 0 }, y: { cost: 0, speed: 0 } } }, "on a step"],
    [matrix, { scores: { x: { cost: 1.5, speed: 0 }, y: { cost: 0, speed: 0 } } }, "within 0..1"],
    [matrix, { scores: { x: { cost: Number.NaN, speed: 0 }, y: { cost: 0, speed: 0 } } }, "finite"],
    [range, { min: 4, max: 2 }, "min must be <= max"],
    [range, { min: -2, max: 2 }, "within 0..10"],
    [range, { min: 0, max: 12 }, "within 0..10"],
    [range, { min: 1, max: 2 }, "on a step of 2"],
    [range, { min: 0, max: Number.NaN }, "finite"],
    [path, { paths: [] }, "non-empty array"],
    [path, { paths: ["a", "a"] }, "unique"],
    [path, { paths: [""] }, "non-empty strings"],
    [{ ...path, multiple: false }, { paths: ["a", "b"] }, "only one path"],
    [{ ...path, config: { mode: "files" } }, { paths: ["src/"] }, "only files"],
    [{ ...path, config: { mode: "dirs" } }, { paths: ["src"] }, "only directories"],
    [date, { value: "2023-02-29" }, "valid YYYY-MM-DD"],
    [date, { value: "2024-04-31" }, "valid YYYY-MM-DD"],
    [date, { value: "2024-13-01" }, "valid YYYY-MM-DD"],
    [date, { value: "2024-1-01" }, "valid YYYY-MM-DD"],
    [date, { value: "2023-12-31" }, "on or after 2024-01-01"],
    [date, { value: "2025-01-01" }, "on or before 2024-12-31"],
    [time, { value: "08:59" }, "on or after 09:00"],
    [time, { value: "12:60" }, "valid HH:mm"],
    [datetime, { value: "1900-02-29T10:00" }, "valid YYYY-MM-DDTHH:mm"],
    [datetime, { value: "2024-01-01T10:00:00" }, "valid YYYY-MM-DDTHH:mm"],
    [tags, { tags: [] }, "at least 1"],
    [tags, { tags: ["a", "b", "c"] }, "at most 2"],
    [tags, { tags: ["a", " a"] }, "unique"],
    [tags, { tags: [" "] }, "blank"],
    [tags, { tags: [1] }, "array of strings"],
    [colour, { hex: "red" }, "#rgb or #rrggbb"],
    [colour, { hex: "#abcd" }, "#rgb or #rrggbb"],
  ]
  test.each(bad)("%#: rejects with %p", (question, value, expected) => {
    expect(err(question, value)).toContain(expected)
  })

  test("a question with invalid config rejects values instead of throwing", () => {
    expect(err({ id: "f", title: "F", kind: "form" }, { fields: {} })).toContain("invalid question")
  })
  test("validTemporal and canonicalHex helpers", () => {
    expect(validTemporal("date", "2000-02-29")).toBe(true)
    expect(validTemporal("date", "2100-02-29")).toBe(false)
    expect(validTemporal("time", "23:59")).toBe(true)
    expect(validTemporal("datetime", "2024-01-01T24:00")).toBe(false)
    expect(canonicalHex("#FfF")).toBe("#ffffff")
    expect(canonicalHex("#12345g")).toBeUndefined()
  })
})

describe("recommendations", () => {
  test("accept the canonical answer object", () => {
    const recommended = { ...match, recommended: { pairs: { a: "one", b: "two" } } }
    expect(validateStructuredQuestion(recommended)).toEqual([])
    const value = recommendedValue(recommended)
    expect(value).toEqual({ pairs: { a: "one", b: "two" } })
    expect(value).not.toBe(recommended.recommended)
  })
  const cases: [Question, unknown, string][] = [
    [match, { pairs: { a: "one", b: "one" } }, "recommended: target one is matched more than once"],
    [allocate, { allocations: { x: 1, y: 1 } }, "add up to 10"],
    [date, { value: "2024-02-30" }, "valid YYYY-MM-DD"],
    [colour, { hex: "#ABC" }, "canonical answer"],
    [tags, { tags: [" ui"] }, "canonical answer"],
    [range, 5, "value must be an object"],
  ]
  test.each(cases)("%#: rejects invalid recommendation", (question, recommended, expected) => {
    expect(configErrors({ ...question, recommended })).toContain(expected)
  })
  test("accepting a recommendation stores a copy and answering it marks it accepted", () => {
    const recommended: Question = { ...colour, recommended: { hex: "#00ff00" } }
    expect(normaliseAnswer(recommended, { id: "c", status: "accepted" })).toEqual({
      answer: { id: "c", status: "accepted", value: { hex: "#00ff00" }, accepted_recommendation: true },
    })
    const answered = normaliseAnswer(recommended, { id: "c", status: "answered", value: { hex: "#0F0" } })
    expect(answered).toMatchObject({ answer: { status: "accepted", accepted_recommendation: true } })
  })
})

describe("structuredDefault", () => {
  test("is valid wherever the question allows one (blank required text, no paths and too few tags are not)", () => {
    for (const question of all.filter((question) => question !== form && question !== path && question !== tags))
      expect(ok(question, structuredDefault(question))).toMatchObject({ value: structuredDefault(question) })
  })
  test("neutral values per kind", () => {
    expect(structuredDefault(form)).toEqual({ fields: { name: "", count: 1, tier: "free", on: false } })
    expect(structuredDefault(buckets)).toEqual({ buckets: { keep: ["a", "b", "c"], drop: [] } })
    expect(structuredDefault(match)).toEqual({ pairs: { a: "one", b: "two" } })
    expect(structuredDefault(allocate)).toEqual({ allocations: { x: 10, y: 0 } })
    expect(structuredDefault({ ...allocate, config: {} })).toEqual({ allocations: { x: 100, y: 0 } })
    expect(structuredDefault(matrix)).toEqual({ scores: { x: { cost: 0, speed: 0 }, y: { cost: 0, speed: 0 } } })
    expect(structuredDefault(range)).toEqual({ min: 0, max: 10 })
    expect(structuredDefault({ ...range, max: 9 })).toEqual({ min: 0, max: 8 })
    expect(structuredDefault(path)).toEqual({ paths: [] })
    expect(structuredDefault(date)).toEqual({ value: "2024-01-01" })
    expect(structuredDefault({ ...date, config: {} })).toEqual({ value: "2026-01-01" })
    expect(structuredDefault({ ...time, config: {} })).toEqual({ value: "12:00" })
    expect(structuredDefault(datetime)).toEqual({ value: "2026-01-01T12:00" })
    expect(structuredDefault(tags)).toEqual({ tags: [] })
    expect(structuredDefault(colour)).toEqual({ hex: "#ff0000" })
    expect(structuredDefault({ ...colour, config: {} })).toEqual({ hex: "#808080" })
    expect(structuredDefault({ id: "f", title: "F", kind: "form" })).toBeUndefined()
  })
})

describe("structuredSummary", () => {
  test("reads by labels", () => {
    expect(structuredSummary(form, { fields: { name: "n", count: 2, tier: "pro", on: true } })).toBe(
      "Name: n\nCount: 2\nTier: pro\nOn: yes",
    )
    expect(structuredSummary(buckets, { buckets: { keep: ["a", "b", "c"], drop: [] } })).toBe(
      "Keep: Alpha, Beta, Gamma\nDrop: (none)",
    )
    expect(structuredSummary(match, { pairs: { a: "two", b: "one" } })).toBe("Alpha → Two\nBeta → One")
    expect(structuredSummary(allocate, { allocations: { x: 3, y: 7 } })).toBe("Ex: 3\nWhy: 7")
    expect(structuredSummary(matrix, { scores: { x: { cost: 1, speed: 0 } } })).toBe("Ex: Cost=1, Speed=0")
    expect(structuredSummary(range, { min: 2, max: 4 })).toBe("2–4 ms")
    expect(structuredSummary(path, { paths: ["a", "b/"] })).toBe("a, b/")
    expect(structuredSummary(date, { value: "2024-02-29" })).toBe("2024-02-29")
    expect(structuredSummary(tags, { tags: ["ui", "api"] })).toBe("ui, api")
    expect(structuredSummary(colour, { hex: "#aabbcc" })).toBe("#aabbcc")
  })
  test("answers.ts and takeover.ts use it", () => {
    expect(describeValue(range, { min: 2, max: 4 })).toBe("2–4 ms")
    expect(validateValue(range, { min: 1, max: 2 })).toEqual({ error: "r: min and max must be on a step of 2" })
    const prompt = { question: "Range?", header: "", options: [] }
    expect(nativeAnswer(prompt, range, { id: "r", status: "answered", value: { min: 2, max: 4 } })).toEqual(["2–4 ms"])
  })
})

describe("show_if", () => {
  const first: Question = { id: "go", title: "Go?", kind: "confirm" }
  test("accepts references to earlier questions, including existing ones", () => {
    expect(validateQuestions([first, { ...range, show_if: { id: "go", equals: { choice: "yes" } } }])).toEqual([])
    expect(validateQuestions([{ ...range, show_if: { id: "go", equals: null } }], [first])).toEqual([])
  })
  const cases: [string, unknown, string][] = [
    ["forward", { id: "later", equals: 1 }, "not an earlier question"],
    ["unknown", { id: "nope", equals: 1 }, "not an earlier question"],
    ["self", { id: "r", equals: 1 }, "cannot refer to the question itself"],
    ["missing equals", { id: "go" }, "show_if.equals is required"],
    ["not an object", "go", "show_if must be an object"],
    ["no id", { equals: 1 }, "show_if must be an object"],
  ]
  test.each(cases)("rejects %s", (_name, showIf, expected) => {
    const errors = validateQuestions([first, { ...range, show_if: showIf as never }, { ...path, id: "later" }])
    expect(errors.join()).toContain(expected)
  })
})
