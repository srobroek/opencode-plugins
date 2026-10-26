import { describe, expect, test } from "bun:test"
import {
  beadsEvidence,
  branchEvidence,
  endState,
  filesTouched,
  isAcknowledgement,
  lastGoal,
  lastProse,
  unfinished,
  type WalkOptions,
  walkBack,
} from "./extract.ts"
import {
  assistant,
  compaction,
  idle,
  moved,
  SUMMARY,
  shellMessage,
  skillMessage,
  synthetic,
  tool,
  user,
} from "./fixtures.ts"
import { renderTurn } from "./render.ts"
import { compactionSections, section, toTranscript } from "./transcript.ts"

describe("toTranscript", () => {
  test("idle markers end turns; without idle a turn runs to the next user message", () => {
    const transcript = toTranscript([
      user("first"),
      assistant(["one"]),
      idle(),
      user("second"),
      assistant(["two"]),
      user("third"),
      assistant(["three"]),
    ])
    expect(transcript.turns.map((turn) => turn.user)).toEqual(["first", "second", "third"])
    expect(transcript.turns.map((turn) => turn.ended)).toEqual(["succeeded", undefined, undefined])
    expect(transcript.turns[1]?.assistant).toEqual(["two"])
  })

  test("shell and skill messages start turns; a skill right after a user message is a note", () => {
    const transcript = toTranscript([
      shellMessage("git status", "On branch main"),
      idle(),
      skillMessage("review"),
      assistant(["reviewing"]),
      idle(),
      user("go on"),
      skillMessage("beads"),
      assistant(["ok"]),
    ])
    expect(transcript.turns.map((turn) => [turn.kind, turn.user])).toEqual([
      ["shell", "$ git status"],
      ["skill", "/review"],
      ["user", "go on"],
    ])
    expect(transcript.turns[2]?.notes).toEqual(["skill: beads"])
    expect(transcript.turns[0]?.shells).toEqual([{ command: "git status", output: "On branch main" }])
  })

  test("reasoning is dropped unless asked for, and thinking-only turns vanish", () => {
    const messages = [user("hi"), assistant([{ reasoning: "secret plan" }, "visible"]), idle(), assistant([{ reasoning: "only thinking" }])]
    const plain = toTranscript(messages)
    expect(JSON.stringify(plain)).not.toContain("secret plan")
    expect(plain.turns).toHaveLength(1)
    const full = toTranscript(messages, { includeReasoning: true })
    expect(full.turns[0]?.reasoning).toEqual(["secret plan"])
    expect(full.turns).toHaveLength(2)
  })

  test("tool traces carry a brief, a one-line result, errors, children and nested execute calls", () => {
    const transcript = toTranscript([
      user("do it all"),
      assistant([
        tool({ name: "shell", input: { command: "ls -la\n/tmp" }, output: "a\nb" }),
        tool({ name: "read", input: { path: "src/a.ts" }, error: "ENOENT" }),
        tool({ name: "subagent", input: { description: "explore" }, output: "done", metadata: { sessionID: "ses_child" } }),
        tool({
          name: "execute",
          input: { code: "…" },
          output: "ok",
          metadata: {
            toolCalls: [
              { tool: "write", input: { path: "/repo/main/new.ts" }, status: "completed" },
              { tool: "shell", input: { command: "bd close x-1" }, status: "error" },
            ],
          },
        }),
      ]),
    ])
    const tools = transcript.turns[0]?.tools ?? []
    expect(tools.map((trace) => trace.name)).toEqual(["shell", "read", "subagent", "execute", "execute.write", "execute.shell"])
    expect(tools[0]).toMatchObject({ brief: "ls -la /tmp", result: "a b", error: false })
    expect(tools[1]).toMatchObject({ result: "ENOENT", error: true })
    expect(tools[2]?.child).toBe("ses_child")
    expect(tools[5]).toMatchObject({ nested: true, error: true, result: "(error)" })
    expect(transcript.turns[0]?.files).toEqual(["/repo/main/new.ts"])
    expect(transcript.turns[0]?.shells.map((run) => run.command)).toEqual(["ls -la\n/tmp", "bd close x-1"])
  })

  test("a completed compaction is a boundary; running and failed ones are not", () => {
    const transcript = toTranscript([
      user("old"),
      assistant(["old work"]),
      idle(),
      compaction("partial", "running"),
      compaction("broken", "failed"),
      compaction(SUMMARY),
      user("new"),
      assistant(["new work"]),
    ])
    expect(transcript.compactions).toHaveLength(1)
    expect(transcript.boundary).toBe(1)
    expect(transcript.turns.map((turn) => turn.user)).toEqual(["old", "new"])
  })

  test("context() shape: a leading compaction leaves boundary 0", () => {
    const transcript = toTranscript([compaction(SUMMARY), idle()])
    expect(transcript.turns).toEqual([])
    expect(transcript.boundary).toBe(0)
    expect(section(transcript.compactions[0], "next move")).toBe("- Wire the --csv flag into the CLI")
  })

  test("synthetic messages show only their description; locations are tracked", () => {
    const transcript = toTranscript([
      user("start"),
      synthetic("long injected text", "beads reminder"),
      moved("/repo/wt"),
      assistant(["ok"]),
    ])
    expect(transcript.turns[0]?.notes).toEqual(["synthetic: beads reminder"])
    expect(transcript.locations).toEqual(["/repo/wt"])
  })

  test("compaction sections are parsed and clipped", () => {
    const sections = compactionSections(`${SUMMARY}\n\n## Relevant Files\n${"x".repeat(700)}`)
    expect(sections.map((entry) => entry.heading)).toEqual(["Objective", "Decisions", "Next Move", "Relevant Files"])
    expect(sections[3]?.body).toContain("…[+100 chars]")
  })
})

describe("goal and prose", () => {
  test("acknowledgements are skipped and the newest substantive request wins", () => {
    expect(isAcknowledgement("ok")).toBe(true)
    expect(isAcknowledgement("lgtm, thanks")).toBe(true)
    expect(isAcknowledgement("ok so now refactor the whole parser module please")).toBe(false)
    const { turns } = toTranscript([user("Add the CSV export"), assistant(["a"]), user("Now wire the flag"), assistant(["b"]), user("yes")])
    expect(lastGoal(turns)).toEqual({ index: 1, text: "Now wire the flag" })
    expect(lastGoal(turns, 1)).toEqual({ index: 0, text: "Add the CSV export" })
    expect(lastProse(turns)).toBe("b")
  })
})

const render = (turn: Parameters<typeof renderTurn>[0], index: number) => renderTurn(turn, index)

function walkOptions(over: Partial<WalkOptions> = {}): WalkOptions {
  return { before: 0, maxChars: 100_000, minTurns: 3, boundary: 0, compacted: false, pastCompaction: false, render, ...over }
}

describe("walkBack", () => {
  const many = () =>
    toTranscript(
      Array.from({ length: 8 }, (_, index) => [user(index === 2 ? "Implement the parser" : "ok"), assistant([`step ${index}`]), idle()]).flat(),
    ).turns

  test("stops at the last goal once minTurns are shown, newest first with chronological numbers", () => {
    const result = walkBack(many(), walkOptions())
    expect(result.stop).toBe("goal")
    expect(result.shown.map((block) => block.index)).toEqual([7, 6, 5, 4, 3, 2])
    expect(result.shown[0]?.text).toStartWith("### [8] USER")
  })

  test("minTurns is enforced past a recent goal", () => {
    const { turns } = toTranscript([user("a"), assistant(["1"]), user("b"), assistant(["2"]), user("Fix the bug"), assistant(["3"])])
    expect(walkBack(turns, walkOptions()).shown).toHaveLength(3)
    expect(walkBack(turns, walkOptions({ minTurns: 1 })).shown).toHaveLength(1)
  })

  test("stops at the compaction boundary unless told to walk past it", () => {
    const transcript = toTranscript([user("old goal is here"), assistant(["x"]), idle(), compaction(SUMMARY), user("ok"), assistant(["y"]), idle()])
    const options = walkOptions({ boundary: transcript.boundary, compacted: true })
    const stopped = walkBack(transcript.turns, options)
    expect(stopped.stop).toBe("compaction")
    expect(stopped.shown.map((block) => block.index)).toEqual([1])
    const past = walkBack(transcript.turns, { ...options, pastCompaction: true })
    expect(past.shown.map((block) => block.index)).toEqual([1, 0])
    expect(past.stop).toBe("start")
    const contextOnly = walkBack(toTranscript([compaction(SUMMARY), user("ok"), assistant(["y"])]).turns, walkOptions({ compacted: true }))
    expect(contextOnly.stop).toBe("compaction")
  })

  test("the budget stops between turns, and an oversized single turn is clipped", () => {
    const turns = many()
    const one = render(turns[7] as never, 8).length
    const result = walkBack(turns, walkOptions({ maxChars: one * 2 + 1 }))
    expect(result).toMatchObject({ stop: "budget", oversized: false })
    expect(result.shown).toHaveLength(2)
    const tiny = walkBack(turns, walkOptions({ maxChars: 10 }))
    expect(tiny).toMatchObject({ stop: "budget", oversized: true })
    expect(tiny.shown[0]?.text).toContain("[turn clipped to fit max_chars]")
  })

  test("before pages older and a turn cap stops early; the start is reported", () => {
    const turns = many()
    const paged = walkBack(turns, walkOptions({ before: 6, minTurns: 99 }))
    expect(paged.shown.map((block) => block.index)).toEqual([1, 0])
    expect(paged.stop).toBe("start")
    expect(walkBack(turns, walkOptions({ turns: 2 }))).toMatchObject({ stop: "turns" })
  })
})

describe("extracts", () => {
  test("files touched: snapshot, edit metadata, write path and nested execute; deduped, newest first, capped", () => {
    const { turns } = toTranscript([
      user("go"),
      assistant([tool({ name: "write", input: { path: "/repo/main/a.ts" } })], { snapshot: { files: ["b.ts"] } }),
      assistant([tool({ name: "edit", input: { path: "/repo/main/c.ts" }, metadata: { files: [{ path: "/repo/main/c.ts" }] } })]),
      assistant([tool({ name: "patch", input: { patchText: "*** Begin Patch\n*** Update File: /repo/main/a.ts\n*** End Patch" } })]),
      assistant([tool({ name: "write", input: { path: "/elsewhere/d.ts" } })]),
    ])
    expect(filesTouched(turns, "/repo/main")).toEqual({ files: ["/elsewhere/d.ts", "a.ts", "c.ts", "b.ts"], more: 0 })
    expect(filesTouched(turns, "/repo/main", 2)).toEqual({ files: ["/elsewhere/d.ts", "a.ts"], more: 2 })
  })

  test("beads evidence keeps state-changing commands and ignores reads", () => {
    const { turns } = toTranscript([
      user("go"),
      assistant([
        tool({ name: "shell", input: { command: "bd prime && bd ready --json" } }),
        tool({ name: "shell", input: { command: "bd update x-1 --claim" } }),
        tool({ name: "shell", input: { command: 'bd create "New thing" -t task && bd close x-2 --reason done' } }),
        tool({ name: "shell", input: { command: "bd show x-1" } }),
      ]),
    ])
    expect(beadsEvidence(turns)).toEqual(["bd update x-1 --claim", "bd create New thing -t task", "bd close x-2 --reason done"])
  })

  test("branch evidence prefers git's own output over the command", () => {
    const { turns } = toTranscript([
      user("go"),
      assistant([tool({ name: "shell", input: { command: "git checkout -b feat/csv" }, output: "Switched to a new branch 'feat/csv'" })]),
      assistant([tool({ name: "shell", input: { command: "git push origin feat/other" } })]),
    ])
    expect(branchEvidence(turns)).toEqual({ branch: "feat/csv", tier: "switched" })
  })

  test("end state reports outcome, a running turn, errors and finish", () => {
    const running = toTranscript([user("go"), assistant(["x"], { finish: "length", error: { type: "x", message: "context overflow" } })])
    expect(endState(running, "failed")).toEqual([
      "session outcome: failed",
      "last turn: no idle marker (still running or cut off)",
      "error: context overflow",
      "finish: length",
    ])
    expect(unfinished(running)).toBe(true)
    const done = toTranscript([user("go"), assistant(["x"]), idle()])
    expect(unfinished(done, "succeeded")).toBe(false)
    expect(unfinished(toTranscript([user("go"), assistant(["x"]), idle("interrupted")]))).toBe(true)
  })
})

describe("renderTurn", () => {
  test("keeps assistant output in order, clips old prose first, and caps tool calls", () => {
    const { turns } = toTranscript([
      user("go"),
      assistant(["x".repeat(3000), tool({ name: "read", input: { path: "a.ts" }, output: "contents" }), "final words"]),
      assistant(Array.from({ length: 14 }, (_, index) => tool({ name: "read", input: { path: `f${index}.ts` } }))),
      idle("interrupted"),
    ])
    const text = renderTurn(turns[0] as never, 1)
    expect(text.indexOf("final words")).toBeGreaterThan(text.indexOf("read (a.ts)"))
    expect(text).toContain("…[+")
    expect(text).toContain("3 earlier tool call(s) not shown")
    expect(text).not.toContain("(f0.ts)")
    expect(text).toContain("(f13.ts)")
    expect(text).toContain("end: interrupted")
  })
})
