import { describe, expect, test } from "bun:test"
import type { SessionMessageInfo } from "@opencode/client"
import { lastAssistantWithUsage as upstream } from "@opencode/client/solid"
import {
  accentIndex,
  activeMs,
  buildSegments,
  compact,
  contextLevel,
  contextParts,
  DEFAULT_LAYOUT,
  fitSegments,
  formatCost,
  formatDuration,
  lastAssistantWithUsage,
  parseOptions,
  pathParts,
  renderSegment,
  rowWidth,
  SEGMENT_IDS,
  type Segment,
  type SegmentInput,
  segmentText,
  separators,
  shortSessionID,
  tokenRate,
  truncateEnd,
  truncatePath,
} from "./format.ts"

const tokens = (input: number, output = 0, read = 0, write = 0) => ({
  input,
  output,
  reasoning: 0,
  cache: { read, write },
})

const assistant = (id: string, t?: ReturnType<typeof tokens>, time = { created: 0, streamed: 1000, completed: 3000 }) =>
  ({
    id,
    type: "assistant",
    agent: "build",
    model: { providerID: "p", modelID: "m" },
    content: [],
    time,
    ...(t ? { tokens: t } : {}),
  }) as unknown as SessionMessageInfo

const compaction = (id: string) =>
  ({ id, type: "compaction", status: "completed", reason: "auto", time: { created: 0 } }) as unknown as SessionMessageInfo

describe("compact", () => {
  test("formats thousands and millions without trailing .0", () => {
    expect(compact(999)).toBe("999")
    expect(compact(1000)).toBe("1k")
    expect(compact(12_345)).toBe("12.3k")
    expect(compact(200_000)).toBe("200k")
    expect(compact(1_000_000)).toBe("1M")
    expect(compact(1_250_000)).toBe("1.3M")
  })
})

describe("shortSessionID", () => {
  test("strips the ses_ prefix and keeps 8 characters", () => {
    expect(shortSessionID("ses_0123456789abcdef")).toBe("01234567")
    expect(shortSessionID("abc")).toBe("abc")
  })
})

describe("lastAssistantWithUsage", () => {
  const cases: SessionMessageInfo[][] = [
    [],
    [assistant("a", tokens(1)), assistant("b")],
    [assistant("a", tokens(1)), compaction("c"), assistant("b")],
    [assistant("a", tokens(1)), compaction("c"), assistant("b", tokens(2))],
  ]
  test("matches @opencode/client/solid", () => {
    for (const messages of cases) {
      expect(lastAssistantWithUsage(messages)).toEqual(upstream(messages))
      expect(lastAssistantWithUsage(messages, "b")).toEqual(upstream(messages, "b"))
      expect(lastAssistantWithUsage(messages, "missing")).toEqual(upstream(messages, "missing"))
    }
  })
  test("ignores steps before the last completed compaction", () => {
    expect(lastAssistantWithUsage([assistant("a", tokens(1)), compaction("c")])).toBeUndefined()
  })
})

describe("time and rate", () => {
  test("activeMs sums completed assistant steps", () => {
    expect(
      activeMs([
        assistant("a", undefined, { created: 0, streamed: 0, completed: 2000 }),
        assistant("b", undefined, { created: 5000, streamed: 0, completed: 6500 }),
        assistant("c", undefined, { created: 0 } as never),
      ]),
    ).toBe(3500)
  })
  test("formatDuration", () => {
    expect(formatDuration(500)).toBeUndefined()
    expect(formatDuration(42_000)).toBe("42s")
    expect(formatDuration(192_000)).toBe("3m12s")
    expect(formatDuration(3_900_000)).toBe("1h05m")
  })
  test("tokenRate uses output over the streaming window", () => {
    const m = assistant("a", tokens(0, 100), { created: 0, streamed: 1000, completed: 3000 })
    expect(tokenRate(m as never)).toBe("50.0")
    expect(tokenRate(assistant("b", tokens(0, 1), { created: 0 } as never) as never)).toBeUndefined()
    expect(tokenRate(undefined)).toBeUndefined()
  })
})

describe("accentIndex", () => {
  test("is stable and in range", () => {
    expect(accentIndex("my session", 8)).toBe(accentIndex("my session", 8))
    for (const s of ["a", "b", "c", "session title"]) {
      const i = accentIndex(s, 6)
      expect(i).toBeGreaterThanOrEqual(0)
      expect(i).toBeLessThan(6)
    }
    expect(accentIndex("x", 0)).toBe(0)
  })
  test("spreads different titles", () => {
    const seen = new Set(["alpha", "beta", "gamma", "delta", "epsilon"].map((s) => accentIndex(s, 8)))
    expect(seen.size).toBeGreaterThan(1)
  })
})

describe("context", () => {
  test("renders percent of the window with a faint window unit", () => {
    expect(contextParts(tokens(100_000, 23_000), 1_000_000)).toEqual([
      { text: "12.3%", tone: "value" },
      { text: "/1M", tone: "label" },
    ])
    expect(contextParts(tokens(1500), undefined)?.map((p) => p.text).join("")).toBe("1.5k/?")
    expect(contextParts(undefined, 1000)).toBeUndefined()
  })
  test("levels follow omp's percent and token thresholds", () => {
    expect(contextLevel(40_000, 200_000)).toBe("normal")
    expect(contextLevel(100_000, 200_000)).toBe("warning")
    expect(contextLevel(185_000, 200_000)).toBe("error")
    // 150k tokens warn even in a 1M window
    expect(contextLevel(150_000, 1_000_000)).toBe("warning")
    expect(contextLevel(500_000, 1_000_000)).toBe("error")
    expect(contextLevel(160_000, undefined)).toBe("warning")
    expect(contextParts(tokens(100_000), 200_000)?.[0]?.tone).toBe("warning")
  })
})

describe("labels", () => {
  test("formatCost hides zero and keeps sub-cent spend visible", () => {
    expect(formatCost(0)).toBeUndefined()
    expect(formatCost(undefined)).toBeUndefined()
    expect(formatCost(0.0042)).toBe("0.0042")
    expect(formatCost(0.000123)).toBe("0.00012")
    expect(formatCost(1.2e-7)).toBe("<0.0001")
    expect(formatCost(1.234)).toBe("1.23")
  })
  test("truncatePath keeps the tail", () => {
    expect(truncatePath("~/a/b", 60)).toBe("~/a/b")
    expect(truncatePath("~/personal/dev/opencode-plugins", 20)).toBe("…/opencode-plugins")
    expect(truncatePath("~/averyveryverylongdirectoryname", 10)).toBe("…ctoryname")
  })
  test("pathParts dims the parent and brightens the leaf", () => {
    expect(pathParts("~/dev/app")).toEqual([
      { text: "~/dev/", tone: "label" },
      { text: "app", tone: "value" },
    ])
    expect(pathParts("~")).toEqual([{ text: "~", tone: "value" }])
  })
  test("truncateEnd", () => {
    expect(truncateEnd("short", 10)).toBe("short")
    expect(truncateEnd("a long session title", 8)).toBe("a long…")
  })
})

describe("parseOptions", () => {
  test("defaults to omp's default preset", () => {
    expect(parseOptions(undefined)).toEqual({ ...DEFAULT_LAYOUT, separator: "powerline", pathMaxLength: 40 })
    expect(DEFAULT_LAYOUT.left).toEqual(["model", "agent", "path", "git", "context_pct", "cost"])
    expect(DEFAULT_LAYOUT.right).toEqual(["session_name", "token_rate"])
  })
  test("a flat list keeps each id on its default side, filtering unknown and duplicate ids", () => {
    const o = parseOptions({ segments: ["git", "nope", "time_spent", "session", "git"], separator: "plain", pathMaxLength: 30 })
    expect(o).toEqual({ left: ["git", "session"], right: ["time_spent"], separator: "plain", pathMaxLength: 30 })
  })
  test("an object places ids on the named side", () => {
    expect(parseOptions({ segments: { left: ["model", "session_name"], right: ["context_pct", "model"] } })).toMatchObject({
      left: ["model", "session_name"],
      right: ["context_pct"],
    })
  })
  test("separators", () => {
    expect(separators("plain").left).toBe(" · ")
    expect(separators("powerline").left).toBe(" \uE0B1 ")
  })
})

const input: SegmentInput = {
  sessionID: "ses_abcdef123456",
  hostname: "mac",
  model: "Claude Opus 4.5",
  variant: "high",
  agent: "build",
  path: "~/dev/x",
  branch: "main",
  dirty: 2,
  title: "Fix bug",
  cost: 0.42,
  tokens: tokens(1200, 3400, 5600, 7800),
  messages: [assistant("a", tokens(100_000, 23_000))],
  contextWindow: 1_000_000,
}

describe("buildSegments", () => {
  test("default layout", () => {
    const { left, right } = buildSegments(input, { ...DEFAULT_LAYOUT, pathMaxLength: 40 })
    expect(left.map(segmentText)).toEqual(["Opus 4.5 · high", "build", "~/dev/x", "\uE0A0 main *2", "12.3%/1M", "$0.42"])
    expect(right.map(segmentText)).toEqual(["Fix bug", "11500.0 tok/s"])
  })
  test("every segment renders with values bright and labels faint", () => {
    const all = buildSegments(input, { left: [], right: [...SEGMENT_IDS], pathMaxLength: 40 }).right
    expect(all.map(segmentText)).toEqual([
      "abcdef12",
      "mac",
      "Opus 4.5 · high",
      "build",
      "~/dev/x",
      "\uE0A0 main *2",
      "12.3%/1M",
      "$0.42",
      "Fix bug",
      "↑1.2k",
      "↓3.4k",
      "⟳5.6k",
      "✎7.8k",
      "11500.0 tok/s",
      "3s",
    ])
    const model = all.find((s) => s.id === "model")?.parts
    expect(model?.[0]).toEqual({ text: "Opus 4.5", tone: "accent", bold: true })
    expect(model?.[2]?.tone).toBe("dim")
    expect(all.find((s) => s.id === "token_in")?.parts.map((p) => p.tone)).toEqual(["label", "value"])
  })
  test("git is green when clean and amber when dirty", () => {
    expect(renderSegment("git", { ...input, dirty: 0 }, 40)?.parts.map((p) => p.tone)).toEqual(["label", "success"])
    expect(renderSegment("git", input, 40)?.parts.map((p) => p.tone)).toEqual(["label", "warning", "warning"])
    expect(renderSegment("model", input, 40, "plain")?.parts.map((p) => p.text).join("")).toBe("Opus 4.5 high")
    expect(renderSegment("git", input, 40, "plain")?.parts.map((p) => p.text).join("")).toBe("main *2")
  })
  test("skips empty values", () => {
    const { left, right } = buildSegments(
      { sessionID: "ses_1", messages: [] },
      { left: ["git", "session", "cost"], right: ["token_in"], pathMaxLength: 60 },
    )
    expect(left.map((s) => s.id)).toEqual(["session"])
    expect(right).toEqual([])
  })
})

describe("fitSegments", () => {
  const seg = (id: Segment["id"], text: string): Segment => ({ id, parts: [{ text, tone: "value" }] })
  const sep = { left: " | ", right: " | " }
  const long = { ...input, path: "~/personal/dev/opencode-plugins" }
  const left = [seg("model", "Opus"), seg("path", "~/personal/dev/opencode-plugins"), seg("git", "main")]
  const right = [seg("session_name", "A long session title"), seg("token_in", "↑1k"), seg("time_spent", "3s")]
  const ids = (r: { left: Segment[]; right: Segment[] }) => [r.left.map(segmentText), r.right.map(segmentText)]

  test("the default right side loses tok/s before the left side shrinks", () => {
    const row = buildSegments(long, { ...DEFAULT_LAYOUT, pathMaxLength: 40 })
    const full = fitSegments(row, 200, sep, long)
    expect(full.right.map(segmentText)).toEqual(["Fix bug", "11500.0 tok/s"])
    const narrow = fitSegments(row, rowWidth(row, sep) - 10, sep, long)
    expect(narrow.right.map(segmentText)).toEqual(["Fix bug"])
    expect(narrow.left).toEqual(row.left)
  })
  test("keeps everything when it fits", () => {
    expect(fitSegments({ left, right }, 200, sep, long)).toEqual({ left, right })
  })
  test("shrinks the title before dropping anything", () => {
    // left 4+3+31+3+4 = 45, gap 2, right 20+3+3+3+2 = 31 -> 78
    expect(ids(fitSegments({ left, right }, 70, sep, long))).toEqual([
      ["Opus", "~/personal/dev/opencode-plugins", "main"],
      ["A long sess…", "↑1k", "3s"],
    ])
  })
  test("then drops right segments from the far end", () => {
    expect(ids(fitSegments({ left, right }, 59, sep, long))[1]).toEqual(["A long…"])
  })
  test("then shrinks the path", () => {
    expect(ids(fitSegments({ left, right }, 40, sep, long))).toEqual([["Opus", "…/dev/opencode-plugins", "main"], []])
  })
  test("then drops left segments, keeping the path last", () => {
    // path floors at 8 columns, then git goes, then the model
    expect(ids(fitSegments({ left, right }, 15, sep, long))).toEqual([["Opus", "…plugins"], []])
    expect(ids(fitSegments({ left, right }, 10, sep, long))).toEqual([["…plugins"], []])
    expect(ids(fitSegments({ left, right }, 3, sep, long))).toEqual([[], []])
  })
})
