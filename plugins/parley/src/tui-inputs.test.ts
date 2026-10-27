import { describe, expect, test } from "bun:test"
import { describeValue } from "./answers.ts"
import { fileURLs } from "./clipboard.ts"
import { type Question, sliderText } from "./questions.ts"
import {
  acceptsPath,
  applyCompletion,
  choose,
  completionQuery,
  countdown,
  editable,
  editText,
  filePaths,
  fuzzyScore,
  initialDraft,
  keyHints,
  parseSlider,
  rankPaths,
  setFiles,
  setText,
  toSubmission,
} from "./tui-state.ts"

const options = [
  { id: "a", label: "A" },
  { id: "b", label: "B" },
  { id: "c", label: "C" },
]

describe("slider text and typing", () => {
  const scope: Question = {
    id: "w",
    title: "Width",
    kind: "slider",
    min: 1,
    max: 3,
    labels: { min: "narrow", mid: "scope", max: "wide" },
  }
  const ttl: Question = {
    id: "t",
    title: "TTL",
    kind: "slider",
    min: 0,
    max: 300,
    step: 15,
    unit: "s",
    labels: { min: "fresh", mid: "balanced", max: "stale" },
  }

  test("labelled values read as their label", () => {
    expect(sliderText(scope, 2)).toBe("scope")
    expect(sliderText(scope, 3)).toBe("wide")
    expect(sliderText(ttl, 0)).toBe("fresh (0 s)")
    expect(sliderText(ttl, 150)).toBe("balanced (150 s)")
    expect(sliderText(ttl, 60)).toBe("60 s")
    expect(describeValue(scope, { value: 2 })).toBe("scope")
  })

  test("typed values snap, check bounds, match labels and allow other only when on", () => {
    expect(parseSlider(ttl, "62")).toEqual({ value: 60 })
    expect(parseSlider(ttl, "90 s")).toEqual({ value: 90 })
    expect(parseSlider(ttl, "400")).toHaveProperty("error")
    expect(parseSlider(ttl, "stale")).toEqual({ value: 300 })
    expect(parseSlider(ttl, "")).toBeUndefined()
    expect(parseSlider(ttl, "it depends")).toHaveProperty("error")
    expect(parseSlider({ ...ttl, allow_other: true }, "it depends")).toEqual({ other: "it depends" })
    const draft = setText(ttl, initialDraft(ttl), "45")
    expect(draft).toMatchObject({ status: "answered", value: { value: 45 } })
    expect(editText(ttl, draft)).toBe("45")
    expect(editable(ttl)).toBe(true)
  })
})

describe("pick_many other", () => {
  test("is editable by default and kept with the selection", () => {
    const question: Question = { id: "m", title: "M", kind: "pick_many", options }
    expect(editable(question)).toBe(true)
    expect(editable({ ...question, allow_other: false })).toBe(false)
    const draft = setText(question, choose(question, initialDraft(question), 0), "D")
    expect(toSubmission(question, draft)).toEqual({ id: "m", status: "answered", value: { selected: ["a"], other: "D" } })
  })
})

describe("files and path completion", () => {
  const image: Question = { id: "i", title: "I", kind: "ask_image" }
  const many: Question = { id: "f", title: "F", kind: "ask_file", multiple: true, accept: [".txt", "md"] }
  const file = (name: string, path?: string) => ({ name, mime: "image/png", size: 1, data: "", ...(path ? { path } : {}) })

  test("typed paths replace typed files and keep pasted ones", () => {
    let draft = setFiles(many, initialDraft(many), [file("clip.png")], "pasted")
    draft = setFiles(many, draft, [file("a.txt", "a.txt")], "typed")
    draft = setFiles(many, draft, [file("b.txt", "b.txt")], "typed")
    expect((draft.value as { files: { name: string }[] }).files.map((f) => f.name)).toEqual(["clip.png", "b.txt"])
    expect(filePaths(draft)).toEqual(["b.txt"])
    const single = setFiles(image, setFiles(image, initialDraft(image), [file("one.png")], "pasted"), [file("two.png")], "pasted")
    expect((single.value as { files: { name: string }[] }).files.map((f) => f.name)).toEqual(["two.png"])
    expect(setFiles(image, single, [], "typed").status).toBe("answered")
  })

  test("completion works on the last path in the field", () => {
    expect(completionQuery("a.txt, sam")).toEqual({ start: 7, query: "sam" })
    expect(applyCompletion("a.txt, sam", "samples/notes.txt")).toBe("a.txt, samples/notes.txt")
    expect(applyCompletion("sam", "samples/")).toBe("samples/")
  })

  test("candidates fit the card and rank fuzzily", () => {
    expect(acceptsPath(image, "samples/diagram.png")).toBe(true)
    expect(acceptsPath(image, "samples/notes.txt")).toBe(false)
    expect(acceptsPath(many, "samples/notes.txt")).toBe(true)
    expect(acceptsPath(many, "samples/data.bin")).toBe(false)
    expect(acceptsPath(many, "samples/")).toBe(true)
    expect(rankPaths("diag", ["docs/dialog-guide.md", "samples/diagram.png", "README.md"])).toEqual([
      "samples/diagram.png",
      "docs/dialog-guide.md",
    ])
    expect(fuzzyScore("xyz", "samples/diagram.png")).toBeUndefined()
  })

  test("file URLs from the clipboard become paths", () => {
    expect(fileURLs("file:///Users/me/My%20Shot.png\r\nhttps://x\n")).toEqual(["/Users/me/My Shot.png"])
  })
})

describe("key hints", () => {
  test("name the focused card's own keys", () => {
    const rank: Question = { id: "r", title: "R", kind: "rank", options }
    const slider: Question = { id: "s", title: "S", kind: "slider", min: 0, max: 10 }
    expect(keyHints(rank, "panel")).toContain("J/K or shift+↑/↓ move item")
    expect(keyHints(slider, "card")).toContain("←/→ adjust · e type a number")
    expect(keyHints({ ...slider, allow_other: true }, "card")).toContain("or your own answer")
    expect(keyHints(rank, "panel")).toContain("f side panel")
    expect(keyHints(rank, "side")).toContain("f full screen")
    expect(keyHints(rank, "panel", undefined, true)).toContain("f inline card")
    const editing = keyHints({ id: "i", title: "I", kind: "ask_image" }, "card", {
      field: "text",
      enterSaves: true,
      suggestions: true,
    })
    expect(editing).toContain("tab complete")
    expect(editing).toContain("ctrl+v paste")
  })
})

test("countdown shows the last ten minutes", () => {
  expect(countdown(1797)).toBeUndefined()
  expect(countdown(65)).toBe("closes in 1m 05s")
  expect(countdown(9)).toBe("closes in 9s")
  expect(countdown(undefined)).toBeUndefined()
})
