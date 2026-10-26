import { describe, expect, test } from "bun:test"
import type { SessionMessageInfo } from "@opencode/client"
import { lastAssistantWithUsage as upstream } from "@opencode/client/solid"
import {
  accentIndex,
  activeMs,
  buildSegments,
  compact,
  contextUsage,
  DEFAULT_SEGMENTS,
  fitSegments,
  formatDuration,
  gitLabel,
  lastAssistantWithUsage,
  modelLabel,
  parseOptions,
  type Segment,
  separators,
  shortSessionID,
  tokenRate,
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

describe("contextUsage", () => {
  test("renders percent of the window", () => {
    expect(contextUsage(tokens(100_000, 23_000), 1_000_000)).toBe("12.3%/1M")
    expect(contextUsage(tokens(50_000, 0, 50_000), 200_000)).toBe("50.0%/200k")
  })
  test("falls back to raw count without a window", () => {
    expect(contextUsage(tokens(1500), undefined)).toBe("1.5k/?")
  })
  test("is empty without usage", () => {
    expect(contextUsage(undefined, 1000)).toBeUndefined()
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
    expect(tokenRate(m as never)).toBe("50.0 tok/s")
    expect(tokenRate(assistant("b", tokens(0, 1), { created: 0 } as never) as never)).toBeUndefined()
    expect(tokenRate(undefined)).toBeUndefined()
  })
})

describe("labels", () => {
  test("modelLabel strips Claude and appends the variant", () => {
    expect(modelLabel("Claude Opus 4.5", "high")).toBe("Opus 4.5 · high")
    expect(modelLabel("GPT-5", undefined)).toBe("GPT-5")
    expect(modelLabel(undefined, "high")).toBeUndefined()
  })
  test("gitLabel appends the dirty count", () => {
    expect(gitLabel("main", 3)).toBe("main *3")
    expect(gitLabel("main", 0)).toBe("main")
    expect(gitLabel(undefined, 3)).toBeUndefined()
  })
  test("truncatePath keeps the tail", () => {
    expect(truncatePath("~/a/b", 60)).toBe("~/a/b")
    expect(truncatePath("~/personal/dev/opencode-plugins", 20)).toBe("…/opencode-plugins")
    expect(truncatePath("~/averyveryverylongdirectoryname", 10)).toBe("…ctoryname")
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

describe("parseOptions", () => {
  test("defaults", () => {
    expect(parseOptions(undefined)).toEqual({ segments: DEFAULT_SEGMENTS, separator: "powerline", pathMaxLength: 60 })
  })
  test("filters unknown segments and keeps order", () => {
    const o = parseOptions({ segments: ["git", "nope", "session"], separator: "plain", pathMaxLength: 30 })
    expect(o).toEqual({ segments: ["git", "session"], separator: "plain", pathMaxLength: 30 })
  })
  test("separators", () => {
    expect(separators("plain").left).toBe(" · ")
    expect(separators("powerline").left).toBe(" \uE0B1 ")
  })
})

describe("buildSegments", () => {
  const input = {
    sessionID: "ses_abcdef123456",
    hostname: "mac",
    model: "Claude Opus 4.5",
    variant: "high",
    agent: "build",
    path: "~/dev/x",
    branch: "main",
    dirty: 2,
    title: "Fix bug",
    tokens: tokens(1200, 3400, 5600, 7800),
    messages: [assistant("a", tokens(100_000, 23_000))],
    contextWindow: 1_000_000,
  }
  test("mirrors omp segment order", () => {
    const { left, right } = buildSegments(input, { segments: DEFAULT_SEGMENTS, pathMaxLength: 60 })
    expect(left.map((s) => s.text)).toEqual(["abcdef12", "mac", "Opus 4.5 · high", "build", "~/dev/x", "main *2"])
    expect(right.map((s) => s.text)).toEqual(["12.3%/1M", "Fix bug", "↑1.2k", "↓3.4k", "⟳5.6k", "✎7.8k", "11500.0 tok/s", "3s"])
    expect(left[0]?.accent).toBe(true)
    expect(right[1]?.accent).toBe(true)
  })
  test("respects the configured segment list and skips empty values", () => {
    const { left, right } = buildSegments(
      { sessionID: "ses_1", messages: [] },
      { segments: ["git", "session", "token_in"], pathMaxLength: 60 },
    )
    expect(left.map((s) => s.id)).toEqual(["session"])
    expect(right).toEqual([])
  })
})

describe("fitSegments", () => {
  const seg = (id: Segment["id"], text: string): Segment => ({ id, text })
  const sep = { left: " | ", right: " | " }
  const left = [seg("session", "abcd"), seg("hostname", "mac")]
  const right = [seg("context_pct", "1%/1M"), seg("session_name", "A long title"), seg("token_in", "↑1k"), seg("time_spent", "3s")]

  test("keeps everything when it fits", () => {
    expect(fitSegments(left, right, 200, sep).right).toEqual(right)
  })
  test("drops the title first", () => {
    // left 10, gap 1, right without title: 5+3+3+3+3+2 = 19 -> 30
    expect(fitSegments(left, right, 30, sep).right.map((s) => s.id)).toEqual(["context_pct", "token_in", "time_spent"])
  })
  test("then drops right segments from the end", () => {
    expect(fitSegments(left, right, 22, sep).right.map((s) => s.id)).toEqual(["context_pct", "token_in"])
    expect(fitSegments(left, right, 5, sep).right).toEqual([])
    expect(fitSegments(left, right, 5, sep).left).toEqual(left)
  })
})
