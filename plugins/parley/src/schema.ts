import { ANSWER_STATUSES } from "./answers.ts"
import { KINDS, MAX_QUESTIONS } from "./questions.ts"

const option = {
  type: "object",
  required: ["id", "label"],
  properties: {
    id: { type: "string" },
    label: { type: "string" },
    description: { type: "string" },
    pros: { type: "array", items: { type: "string" } },
    cons: { type: "array", items: { type: "string" } },
  },
} as const

export const questionSchema = {
  type: "object",
  required: ["id", "title", "kind"],
  properties: {
    id: { type: "string", description: "Stable id, e.g. a design-tree node; answers are keyed by it" },
    title: { type: "string" },
    kind: { type: "string", enum: [...KINDS] },
    body: { type: "string", description: "Markdown" },
    rationale: { type: "string", description: "One line on why you recommend it" },
    recommended: {
      description:
        "Preselected: option id (ids for pick_many/rank), yes|no, up|down, number, {optionId: number} for rate, text, approve|revise, or an emoji",
    },
    options: { type: "array", items: option },
    allow_other: { type: "boolean" },
    allow_defer: { type: "boolean" },
    depends_on: { type: "array", items: { type: "string" } },
    min: { type: "number", description: "slider/rate bound; pick_many minimum" },
    max: { type: "number", description: "slider/rate bound; pick_many maximum" },
    step: { type: "number" },
    unit: { type: "string" },
    labels: {
      type: "object",
      properties: { min: { type: "string" }, mid: { type: "string" }, max: { type: "string" } },
    },
    yes_label: { type: "string" },
    no_label: { type: "string" },
    placeholder: { type: "string" },
    multiline: { type: "boolean" },
    markdown: { type: "string", description: "review: the plan to approve" },
    sections: {
      type: "array",
      description: "review",
      items: {
        type: "object",
        required: ["id", "title", "content"],
        properties: { id: { type: "string" }, title: { type: "string" }, content: { type: "string" } },
      },
    },
    diff: { type: "string", description: "show_diff: unified diff" },
    language: { type: "string", description: "ask_code/show_diff" },
    emojis: { type: "array", items: { type: "string" } },
    multiple: { type: "boolean", description: "ask_image/ask_file" },
    accept: { type: "array", items: { type: "string" }, description: "ask_file extensions" },
  },
} as const

export const askInput = {
  type: "object",
  required: ["questions"],
  properties: {
    title: { type: "string", description: "Shown above the round, e.g. the plan" },
    round: { type: "integer", minimum: 1 },
    wait: {
      type: "string",
      enum: ["all", "any", "none"],
      description: "all (default): until submitted; any: first answer; none: return at once",
    },
    timeout_s: {
      type: "integer",
      minimum: 0,
      description: "Default 1800; 0 waits without limit",
    },
    format: {
      type: "string",
      enum: ["parley", "native"],
      description: "native: word the answers like the question tool",
    },
    questions: { type: "array", minItems: 1, maxItems: MAX_QUESTIONS, items: questionSchema },
  },
} as const

export const waitInput = {
  type: "object",
  properties: {
    wait: { type: "string", enum: ["all", "any"] },
    ids: { type: "array", items: { type: "string" } },
    timeout_s: { type: "integer", minimum: 0 },
  },
} as const

export const endInput = {
  type: "object",
  properties: { message: { type: "string", description: "Shown to the user when the parley closes" } },
} as const

const answer = {
  type: "object",
  required: ["id", "status"],
  properties: {
    id: { type: "string" },
    status: { type: "string", enum: [...ANSWER_STATUSES] },
    value: {},
    note: { type: "string" },
    accepted_recommendation: { type: "boolean" },
  },
} as const

export const resultOutput = {
  type: "object",
  required: ["status", "answers", "pending"],
  properties: {
    status: { type: "string", enum: ["submitted", "open", "partial", "timeout", "cancelled", "unavailable", "none"] },
    reason: { type: "string" },
    channel: { type: "string", enum: ["tui", "question"] },
    round: { type: "integer" },
    round_id: { type: "string" },
    answers: { type: "array", items: answer },
    pending: { type: "array", items: { type: "string" } },
  },
} as const

export const endOutput = {
  type: "object",
  required: ["ok"],
  properties: { ok: { type: "boolean" }, closed: { type: "integer" } },
} as const
