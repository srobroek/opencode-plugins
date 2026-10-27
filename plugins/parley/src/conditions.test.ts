import { expect, test } from "bun:test"
import { visibleQuestions } from "./conditions.ts"
import type { Question } from "./questions.ts"
import { collect, Rounds, settled } from "./rounds.ts"
import { Parley } from "./service.ts"

const questions: Question[] = [
  { id: "gate", title: "Enable?", kind: "confirm" },
  { id: "detail", title: "Detail", kind: "ask_text", show_if: { id: "gate", equals: { choice: "yes" } } },
  { id: "more", title: "More", kind: "ask_text", show_if: { id: "detail", equals: { text: "go" } } },
]

test("conditions evaluate live, including hidden chains and canonical equality", () => {
  const values: Record<string, unknown> = { gate: { choice: "yes" }, detail: { text: "go" } }
  expect(visibleQuestions(questions, (id) => values[id]).map((q) => q.id)).toEqual(["gate", "detail", "more"])
  values.gate = { choice: "no" }
  expect(visibleQuestions(questions, (id) => values[id]).map((q) => q.id)).toEqual(["gate"])
})

test("round results never wait for hidden questions or leak stale hidden answers", () => {
  const store = new Rounds(() => "round")
  const opened = store.open("s", { questions }, 0)
  if ("errors" in opened) throw new Error(opened.errors.join(","))
  expect(store.submit("round", [{ id: "gate", status: "answered", value: { choice: "yes" } }, { id: "detail", status: "answered", value: { text: "go" } }], false, 1).ok).toBe(true)
  expect(collect(opened.round).pending).toEqual(["more"])
  expect(store.submit("round", [{ id: "gate", status: "answered", value: { choice: "no" } }], false, 2).ok).toBe(true)
  expect(settled(opened.round, "all")).toBe(true)
  expect(settled(opened.round, "any", ["detail", "more"])).toBe(true)
  expect(collect(opened.round).pending).toEqual([])
  expect(opened.round.answers.has("detail")).toBe(false)
})

test("fallback asks only visible questions after earlier real answers", async () => {
  for (const choice of ["Yes", "No"]) {
    const asked: string[] = []
    const service = new Parley({ settings: { fallback: "question", questionTool: "off", disabled: false, heartbeatWindowMs: 30000 }, emit: async () => {}, questionTool: async () => ({ execute: async (input) => {
      const prompt = (input as { questions: { header: string }[] }).questions[0]
      asked.push(prompt?.header ?? "")
      return { output: { answers: [[asked.length === 1 ? choice : "stop"]] } }
    } }) })
    const { result } = await service.ask({ questions }, { sessionID: "s" })
    expect(result.status).toBe("submitted")
    expect(asked).toEqual(choice === "Yes" ? ["Enable?", "Detail"] : ["Enable?"])
  }
})

test("fallback names unsupported new questions as unavailable per ID", async () => {
  const service = new Parley({ settings: { fallback: "question", questionTool: "off", disabled: false, heartbeatWindowMs: 30000 }, emit: async () => {} })
  const { result } = await service.ask({ questions: [{ id: "colour", title: "Colour", kind: "colour" }] }, { sessionID: "s" })
  expect(result).toMatchObject({ status: "unavailable", pending: ["colour"] })
})
