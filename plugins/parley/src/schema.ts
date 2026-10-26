import { ANSWER_STATUSES } from "./answers.ts"
import { KINDS, MAX_QUESTIONS } from "./questions.ts"

const option = {
  type: "object",
  required: ["id", "label"],
  properties: {
    id: { type: "string", description: "Stable option id, e.g. sqlite" },
    label: { type: "string" },
    description: { type: "string" },
    pros: { type: "array", items: { type: "string" }, description: "show_options only" },
    cons: { type: "array", items: { type: "string" }, description: "show_options only" },
  },
} as const

export const questionSchema = {
  type: "object",
  required: ["id", "title", "kind"],
  properties: {
    id: { type: "string", description: "Stable id (e.g. a design-tree node such as auth.storage); answers are keyed by it" },
    title: { type: "string", description: "Short title" },
    kind: { type: "string", enum: [...KINDS] },
    body: { type: "string", description: "Markdown body" },
    rationale: { type: "string", description: "Why you recommend the recommended answer" },
    recommended: {
      description:
        "Recommended answer, preselected in the UI. pick_one/show_options: option id; pick_many/rank: option ids; confirm: yes|no; thumbs: up|down; slider: number; rate: {optionId: number}; ask_text/ask_code: text; review/show_diff: approve|revise; emoji_react: emoji",
    },
    options: { type: "array", items: option, description: "pick_one, show_options, pick_many, rank, rate" },
    allow_other: { type: "boolean", description: "pick_one (default true), pick_many (default false)" },
    allow_defer: { type: "boolean", description: "Default true" },
    depends_on: { type: "array", items: { type: "string" }, description: "Display only" },
    min: { type: "number", description: "slider/rate bounds; pick_many minimum selections" },
    max: { type: "number", description: "slider/rate bounds; pick_many maximum selections" },
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
    markdown: { type: "string", description: "review: the plan or summary to approve" },
    sections: {
      type: "array",
      description: "review: sections of the plan",
      items: {
        type: "object",
        required: ["id", "title", "content"],
        properties: { id: { type: "string" }, title: { type: "string" }, content: { type: "string" } },
      },
    },
    diff: { type: "string", description: "show_diff: unified diff text" },
    language: { type: "string", description: "ask_code / show_diff file type" },
    emojis: { type: "array", items: { type: "string" }, description: "emoji_react choices" },
    multiple: { type: "boolean", description: "ask_image/ask_file: allow several files" },
    accept: { type: "array", items: { type: "string" }, description: "ask_file: allowed extensions" },
  },
} as const

export const askInput = {
  type: "object",
  required: ["questions"],
  properties: {
    title: { type: "string", description: "Shown at the top of the round, e.g. the plan being discussed" },
    round: { type: "integer", minimum: 1, description: "Round number to display" },
    wait: {
      type: "string",
      enum: ["all", "any", "none"],
      description: "all (default): block until the round is submitted; any: until the first answer; none: return at once",
    },
    timeout_s: {
      type: "integer",
      minimum: 0,
      description: "Default 1800. 0 waits without limit. On timeout, call parley_wait",
    },
    questions: { type: "array", minItems: 1, maxItems: MAX_QUESTIONS, items: questionSchema },
  },
} as const

export const waitInput = {
  type: "object",
  properties: {
    wait: { type: "string", enum: ["all", "any"] },
    ids: { type: "array", items: { type: "string" }, description: "Only these question ids" },
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
