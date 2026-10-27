// Demo rounds for the parley playground. Pure data and formatting; index.ts wires it to the plugin context.

export type Question = Record<string, unknown> & { id: string; title: string; kind: string }

export interface Samples {
  /** Absolute path of the playground's samples/ directory. */
  readonly dir: string
  /** samples/plan.md, shown by the review question. */
  readonly plan: string
  /** samples/change.diff, shown by the show_diff question. */
  readonly diff: string
}

export interface Ask {
  readonly tool: "parley_ask"
  readonly input: {
    readonly title?: string
    readonly questions: readonly Question[]
    readonly wait?: "all" | "any" | "none"
    readonly timeout_s?: number
  }
}

export interface Wait {
  readonly tool: "parley_wait"
  readonly input: { readonly wait?: "all" | "any"; readonly ids?: readonly string[]; readonly timeout_s?: number }
  /** Only run this step when the previous result left answers outstanding. */
  readonly ifOpen?: boolean
}

export interface End {
  readonly tool: "parley_end"
  readonly input: { readonly message?: string }
}

export type Step = (Ask | Wait | End) & { readonly label: string }

export type Plan = { readonly steps: readonly Step[] } | { readonly special: "help" | "cancel" } | { readonly error: string }

export function kindQuestions(samples: Samples): Record<string, Question> {
  return {
    pick_one: {
      id: "db.engine",
      title: "Which database should the service use?",
      kind: "pick_one",
      body: "Pick one, or press `e` to type your own answer (`allow_other` is on by default).",
      options: [
        { id: "postgres", label: "PostgreSQL", description: "Relational, mature, JSONB" },
        { id: "sqlite", label: "SQLite", description: "Embedded, zero ops" },
        { id: "dynamo", label: "DynamoDB", description: "Managed key-value" },
      ],
      recommended: "postgres",
      rationale: "The team already runs it and the data is relational.",
      allow_other: true,
    },
    show_options: {
      id: "cache.layer",
      title: "Where should the cache live?",
      kind: "show_options",
      body: "Options are shown side by side with their pros and cons. No free-text answer for this kind.",
      options: [
        {
          id: "in_process",
          label: "In-process LRU",
          pros: ["No network hop", "Nothing new to run"],
          cons: ["Per-instance, so hit rate drops with more replicas"],
        },
        {
          id: "redis",
          label: "Redis",
          pros: ["Shared across replicas", "TTL and eviction built in"],
          cons: ["One more service to operate", "Network latency"],
        },
      ],
      recommended: "in_process",
      rationale: "Simplest thing that meets the latency goal; revisit if replicas grow.",
    },
    pick_many: {
      id: "ci.checks",
      title: "Which checks must pass before merge?",
      kind: "pick_many",
      body: "Choose 2 to 3. `space` toggles; `e` adds an \"other\" entry.",
      options: [
        { id: "lint", label: "Lint" },
        { id: "types", label: "Type check" },
        { id: "unit", label: "Unit tests" },
        { id: "e2e", label: "End-to-end tests" },
      ],
      recommended: ["types", "unit"],
      rationale: "Fast and catch most regressions; e2e is slow and flaky today.",
      min: 2,
      max: 3,
      allow_other: true,
    },
    confirm: {
      id: "rollout.flag",
      title: "Ship the cache behind a feature flag?",
      kind: "confirm",
      yes_label: "Yes, behind a flag",
      no_label: "No, ship it on",
      recommended: "yes",
      rationale: "Lets us turn it off without a deploy.",
    },
    rank: {
      id: "roadmap.order",
      title: "Rank these by priority (highest first)",
      kind: "rank",
      body: "Move the item under the cursor with `shift+↑`/`shift+↓` or `K`/`J`.",
      options: [
        { id: "perf", label: "Performance" },
        { id: "a11y", label: "Accessibility" },
        { id: "docs", label: "Documentation" },
        { id: "i18n", label: "Translations" },
      ],
      recommended: ["perf", "a11y", "docs", "i18n"],
      rationale: "Performance is the current complaint; a11y is a compliance deadline.",
    },
    slider: {
      id: "cache.ttl",
      title: "Cache TTL",
      kind: "slider",
      body: "`←`/`→` moves the value by one step.",
      min: 0,
      max: 300,
      step: 15,
      unit: "s",
      labels: { min: "always fresh", mid: "balanced", max: "very stale" },
      recommended: 60,
      rationale: "Edits are rare; a minute of staleness is acceptable.",
    },
    ask_text: {
      id: "release.name",
      title: "What should the release be called?",
      kind: "ask_text",
      body: "Press `e` to edit, `esc` to finish.",
      placeholder: "e.g. Quick Quokka",
      recommended: "Cache Money",
      rationale: "Memorable, and it is mostly about the cache.",
    },
    ask_code: {
      id: "cache.key",
      title: "How should the cache key be built?",
      kind: "ask_code",
      language: "typescript",
      body: "Edit the snippet with `e`.",
      recommended: "const key = [tenant, report, JSON.stringify(params)].join(\"|\")",
      rationale: "Ids never contain a pipe, so the key is unambiguous.",
    },
    review: {
      id: "plan.review",
      title: "Review the cache plan",
      kind: "review",
      body: "Approve, or choose revise and press `e` for feedback.",
      sections: sections(samples.plan),
      recommended: "approve",
      rationale: "It is small, flagged and reversible.",
    },
    show_diff: {
      id: "change.review",
      title: "Review the change",
      kind: "show_diff",
      language: "typescript",
      diff: samples.diff,
      recommended: "approve",
      rationale: "Keeps the uncached path behind the flag.",
    },
    rate: {
      id: "libs.rating",
      title: "Rate these cache libraries",
      kind: "rate",
      body: "Move between libraries with `↑`/`↓`, set a rating with `←`/`→`.",
      min: 1,
      max: 5,
      options: [
        { id: "lru_cache", label: "lru-cache" },
        { id: "quick_lru", label: "quick-lru" },
        { id: "homegrown", label: "Our own Map wrapper" },
      ],
      recommended: { lru_cache: 4, quick_lru: 3, homegrown: 2 },
      rationale: "lru-cache has TTL support and is widely used.",
    },
    thumbs: {
      id: "naming.thumbs",
      title: "Do you like the name `report_cache` for the flag?",
      kind: "thumbs",
      recommended: "up",
    },
    emoji_react: {
      id: "mood.emoji",
      title: "How do you feel about this sprint?",
      kind: "emoji_react",
      emojis: ["🚀", "🙂", "😐", "😩", "🔥"],
      recommended: "🚀",
    },
    ask_image: {
      id: "design.image",
      title: "Attach a screenshot or diagram",
      kind: "ask_image",
      body: "Press `e` and type a path, for example `samples/diagram.png` (relative to where you started opencode).\n\nThe model receives it as image content.",
    },
    ask_file: {
      id: "context.files",
      title: "Attach supporting files",
      kind: "ask_file",
      multiple: true,
      body: [
        "Press `e` and type one or more paths, separated by commas, for example:",
        "",
        "`samples/notes.txt, samples/data.bin`",
        "",
        "The text file is inlined in the result; the binary is saved to a temp file and its path reported.",
      ].join("\n"),
    },
  }
}

/** Splits markdown into review sections at `## ` headings; the part before the first heading becomes "Overview". */
export function sections(markdown: string): { id: string; title: string; content: string }[] {
  const out: { id: string; title: string; content: string }[] = []
  let title = "Overview"
  let lines: string[] = []
  const flush = () => {
    const content = lines.join("\n").trim()
    if (content !== "") out.push({ id: slug(title, out.length), title, content })
  }
  for (const line of markdown.split("\n")) {
    const heading = /^##\s+(.+)$/.exec(line)
    if (heading?.[1]) {
      flush()
      title = heading[1].trim()
      lines = []
    } else lines.push(line)
  }
  flush()
  return out
}

const slug = (title: string, index: number) =>
  title.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || `section_${index + 1}`

const CHOICE_KINDS = ["pick_one", "show_options", "pick_many", "confirm", "rank", "slider", "rate", "thumbs", "emoji_react"]
const CONTENT_KINDS = ["ask_text", "ask_code", "review", "show_diff", "ask_image", "ask_file"]
const FALLBACK_KINDS = ["pick_one", "show_options", "pick_many", "confirm", "ask_text"]

export const KINDS = [...CHOICE_KINDS, ...CONTENT_KINDS]

export function statusQuestions(): Question[] {
  return [
    {
      id: "status.accept",
      title: "1. Accept: press `a` (or leave the preselected answer)",
      kind: "pick_one",
      options: [
        { id: "monday", label: "Monday" },
        { id: "friday", label: "Friday" },
      ],
      recommended: "monday",
      rationale: "Nobody deploys on a Friday.",
      body: "Comes back `accepted` with `accepted_recommendation: true`.",
    },
    {
      id: "status.change",
      title: "2. Change: pick the other option",
      kind: "pick_one",
      options: [
        { id: "tabs", label: "Tabs" },
        { id: "spaces", label: "Spaces" },
      ],
      recommended: "spaces",
      rationale: "Matches the formatter default.",
      body: "Choose Tabs. Comes back `answered` with `accepted_recommendation: false`.",
    },
    {
      id: "status.note",
      title: "3. Note only: press `n`, type a comment, `esc`",
      kind: "confirm",
      body: "No recommendation and no choice: the note alone comes back as `noted`.",
    },
    {
      id: "status.defer",
      title: "4. Defer: press `d`, then `n` to say why",
      kind: "slider",
      min: 1,
      max: 10,
      recommended: 5,
      body: "Comes back `deferred` with your note. Press `d` again to undo.",
    },
    {
      id: "status.pending",
      title: "5. Leave this one alone",
      kind: "ask_text",
      body: "No recommendation and untouched: its id comes back in `pending`.",
    },
  ]
}

const pick = (all: Record<string, Question>, kinds: readonly string[]) =>
  kinds.map((kind) => all[kind]).filter((question): question is Question => question !== undefined)

const ask = (label: string, input: Ask["input"]): Step => ({ label, tool: "parley_ask", input })

export const SUBCOMMANDS = [
  "all",
  "<kind>",
  "files",
  "statuses",
  "wait",
  "timeout",
  "resume",
  "fallback",
  "cancel",
  "end",
  "help",
] as const

/** Turns `/parley-demo <args>` into the tool calls to run. */
export function plan(args: string, samples: Samples): Plan {
  const word = args.trim().replace(/^\/?parley-demo\b/, "").trim().split(/\s+/)[0]?.toLowerCase() ?? ""
  const all = kindQuestions(samples)
  switch (word) {
    case "":
    case "help":
      return { special: "help" }
    case "cancel":
      return { special: "cancel" }
    case "all":
      return {
        steps: [
          ask("all, round 1 of 2 (choices)", {
            title: "Every kind, round 1 of 2: choices",
            questions: pick(all, CHOICE_KINDS),
          }),
          ask("all, round 2 of 2 (content)", {
            title: "Every kind, round 2 of 2: text, review and files",
            questions: pick(all, CONTENT_KINDS),
          }),
        ],
      }
    case "files":
      return {
        steps: [ask("files", { title: "File uploads", questions: pick(all, ["ask_image", "ask_file"]) })],
      }
    case "statuses":
      return {
        steps: [ask("statuses", { title: "Answer statuses: follow the numbered titles", questions: statusQuestions() })],
      }
    case "wait":
      return {
        steps: [
          ask("wait: none (returns at once)", {
            title: "Wait modes",
            wait: "none",
            questions: pick(all, ["confirm", "thumbs"]),
          }),
          { label: "parley_wait wait: any", tool: "parley_wait", input: { wait: "any" } },
          { label: "parley_wait wait: all", tool: "parley_wait", input: { wait: "all" }, ifOpen: true },
        ],
      }
    case "timeout":
      return {
        steps: [
          ask("timeout_s: 15", {
            title: "Timeout: wait 15 seconds before submitting",
            timeout_s: 15,
            questions: pick(all, ["slider"]),
          }),
          { label: "parley_wait after the timeout", tool: "parley_wait", input: { timeout_s: 600 }, ifOpen: true },
        ],
      }
    case "resume":
      return { steps: [{ label: "parley_wait", tool: "parley_wait", input: {} }] }
    case "fallback":
      return {
        steps: [
          ask("fallback kinds", { title: "Kinds the question-tool fallback supports", questions: pick(all, FALLBACK_KINDS) }),
        ],
      }
    case "end":
      return {
        steps: [{ label: "parley_end", tool: "parley_end", input: { message: "Parley demo finished. Thanks!" } }],
      }
    default: {
      const question = all[word]
      if (question) return { steps: [ask(word, { title: `Kind: ${word}`, questions: [question] })] }
      return { error: `Unknown subcommand "${word}". ${help()}` }
    }
  }
}

export function help(): string {
  return [
    "Usage: /parley-demo <subcommand>",
    "",
    "  all        every kind, in two rounds (a round holds at most 12 questions)",
    `  <kind>     one question: ${KINDS.join(", ")}`,
    "  files      ask_image and ask_file",
    "  statuses   accept, change, note, defer and pending in one round",
    "  wait       wait: none, then parley_wait any and all",
    "  timeout    timeout_s: 15, then parley_wait",
    "  resume     parley_wait on the open round",
    "  fallback   only the kinds the question-tool fallback supports",
    "  cancel     abort this session's running demo calls (result: cancelled, aborted)",
    "  end        parley_end with a message",
  ].join("\n")
}

type ContentPart = { type: string; text?: string; mime?: string; name?: string; uri?: string }

/** Whether the result still has questions the user has not settled. */
export function stillOpen(result: unknown): boolean {
  const status = (result as { output?: { status?: string } })?.output?.status
  return status === "open" || status === "partial" || status === "timeout"
}

export interface Message {
  /** The full message the model receives with your next prompt: content text, file parts and structured output. */
  readonly text: string
  /** What the TUI shows above the prompt: the header and the result summary, without the JSON. */
  readonly description: string
}

const MAX_DESCRIPTION_LINES = 40

function clip(lines: readonly string[]) {
  if (lines.length <= MAX_DESCRIPTION_LINES) return lines.join("\n")
  return [...lines.slice(0, MAX_DESCRIPTION_LINES), `… ${lines.length - MAX_DESCRIPTION_LINES} more lines`].join("\n")
}

/** What the model would receive, as a chat message: the content text, file parts, then the structured output. */
export function describeResult(label: string, tool: string, result: unknown): Message {
  const { content, output } = (result ?? {}) as { content?: string | ContentPart[]; output?: unknown }
  const parts: ContentPart[] = typeof content === "string" ? [{ type: "text", text: content }] : (content ?? [])
  const text = parts
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n\n")
  const files = parts
    .filter((part) => part.type !== "text")
    .map((part) => `${part.type} part: ${part.name ?? "(unnamed)"} (${part.mime ?? "unknown"}), sent to the model as content`)
  const header = `parley-demo · ${label} · ${tool} returned:`
  const body = [header, ...(text === "" ? [] : text.split("\n")), ...files]
  const full = [`**${header}**`, "", "```text", text, "```", ...files.map((line) => `- ${line}`)]
  if (output !== undefined) full.push("", "Structured output:", "", "```json", JSON.stringify(output, null, 2), "```")
  return { text: full.join("\n"), description: clip(body) }
}

export function describeError(label: string, tool: string, error: unknown, aborted = false): Message {
  const text = aborted
    ? `parley-demo · ${label} · ${tool} was aborted. The host interrupts the call, as when you stop a model turn; parley cancels the round (reason aborted) and the panel closes.`
    : `parley-demo · ${label} · ${tool} threw: ${error instanceof Error ? error.message : String(error)}`
  return { text, description: text }
}
