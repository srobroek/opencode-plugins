import { afterAll, describe, expect, test } from "bun:test"
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { branchEvidence } from "./extract.ts"
import { type OmpSession, writeOmpStore } from "./fixtures.ts"
import { pathKeys } from "./git.ts"
import { ompSource, parseOmpTranscript, readHead, storeFiles, visitJsonl } from "./omp.ts"
import { listSessions, type ResumeEnv, readSession } from "./resume.ts"

const roots: string[] = []
function store(sessions: OmpSession[]): { root: string; files: string[] } {
  const root = mkdtempSync(join(tmpdir(), "omp-store-"))
  roots.push(root)
  return { root, files: writeOmpStore(root, sessions) }
}
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

const shipped: OmpSession = {
  stem: "2026-08-24T09-00-00-000Z_aaaaaaaa-1111-7000-8888-000000000001",
  cwd: "/repo/main",
  title: "Wire the export path",
  updatedAt: "2026-08-24T13:30:00.000Z",
  entries: [
    { kind: "user", text: "Add the CSV export" },
    {
      kind: "assistant",
      text: "Starting on the export path.",
      thinking: "secret reasoning that must stay hidden",
      tools: [{ name: "bash", args: { command: "git checkout -b feat/csv" }, result: "Switched to a new branch 'feat/csv'" }],
    },
    {
      kind: "todo",
      phases: [
        {
          name: "Export",
          tasks: [
            { content: "Write writer", status: "completed" },
            { content: "Wire CLI", status: "in_progress" },
          ],
        },
      ],
    },
    {
      kind: "assistant",
      text: "Writer landed; the CLI flag is still open.",
      tools: [{ name: "edit", args: { path: "src/export.ts" }, intent: "Editing writer" }],
    },
  ],
}

describe("omp parsing (ported from omp-plugins)", () => {
  test("head yields id, cwd, title and the in-place updatedAt", async () => {
    const { files } = store([shipped])
    const head = await readHead(files[0] as string)
    expect(head).toMatchObject({
      id: "aaaaaaaa-1111-7000-8888-000000000001",
      cwd: "/repo/main",
      title: "Wire the export path",
      updatedAtMs: Date.parse("2026-08-24T13:30:00.000Z"),
    })
  })

  test("tool results fold into their calls and thinking is dropped by default", async () => {
    const { files } = store([shipped])
    const transcript = await parseOmpTranscript(files[0] as string)
    expect(transcript.turns).toHaveLength(1)
    const tools = transcript.turns[0]?.tools ?? []
    expect(tools.map((trace) => trace.name)).toEqual(["bash", "todo", "edit"])
    expect(tools[0]?.result).toContain("Switched to a new branch")
    expect(tools[2]?.brief).toBe("Editing writer")
    expect(transcript.turns[0]?.files).toEqual(["src/export.ts"])
    expect(JSON.stringify(transcript)).not.toContain("secret reasoning")
    expect(JSON.stringify(await parseOmpTranscript(files[0] as string, { includeReasoning: true }))).toContain("secret reasoning")
    expect(branchEvidence(transcript.turns)).toEqual({ branch: "feat/csv", tier: "switched" })
  })

  test("the newest todo board wins and an empty board clears it", async () => {
    const replaced = store([
      {
        ...shipped,
        entries: [
          { kind: "todo", phases: [{ name: "Old", tasks: [{ content: "stale", status: "pending" }] }] },
          { kind: "todo", phases: [{ name: "New", tasks: [{ content: "fresh", status: "in_progress" }] }] },
        ],
      },
    ])
    expect((await parseOmpTranscript(replaced.files[0] as string)).todo).toEqual([
      { name: "New", tasks: [{ content: "fresh", status: "in_progress" }] },
    ])
    const cleared = store([
      {
        ...shipped,
        entries: [
          { kind: "todo", phases: [{ name: "Old", tasks: [{ content: "obsolete", status: "pending" }] }] },
          { kind: "todo", phases: [{ name: "Cleared", tasks: [] }] },
        ],
      },
    ])
    expect((await parseOmpTranscript(cleared.files[0] as string)).todo).toEqual([])
  })

  test("compaction and exit are surfaced", async () => {
    const { files } = store([
      {
        ...shipped,
        entries: [
          { kind: "user", text: "go" },
          { kind: "compaction", summary: "## Objective\nearlier work summarized" },
          { kind: "user", text: "continue the parser" },
          { kind: "assistant", text: "continuing" },
          { kind: "exit", reason: "dispose", exitKind: "normal" },
        ],
      },
    ])
    const transcript = await parseOmpTranscript(files[0] as string)
    expect(transcript.compactions.map((entry) => entry.sections[0]?.body)).toEqual(["earlier work summarized"])
    expect(transcript.boundary).toBe(1)
    expect(transcript.exitReason).toBe("normal/dispose")
  })

  test("empty turns are dropped and a truncated final line does not abort the parse", async () => {
    const { files } = store([{ ...shipped, entries: [{ kind: "assistant" }, { kind: "user", text: "real" }] }])
    const file = files[0] as string
    appendFileSync(file, '{"type":"message","message":{"role":"assis')
    expect((await parseOmpTranscript(file)).turns.map((turn) => turn.user)).toEqual(["real"])
  })

  test("a file that changes during the read is an error, not a partial result", async () => {
    const { files } = store([shipped])
    const file = files[0] as string
    let appended = false
    await expect(
      visitJsonl(file, () => {
        if (!appended) appendFileSync(file, "{}\n")
        appended = true
        return undefined
      }),
    ).rejects.toThrow("changed while being read")
  })

  test("spilled tool-output directories are not transcripts", () => {
    const { root } = store([shipped])
    const spill = join(root, shipped.cwd.replace(/\//g, "-"), shipped.stem)
    mkdirSync(spill, { recursive: true })
    writeFileSync(join(spill, "12.read.log"), "spilled\n")
    expect(storeFiles(root)).toHaveLength(1)
    expect(storeFiles(join(root, "missing"))).toEqual([])
  })

  test("pathKeys accepts both spellings of a symlinked directory", () => {
    const base = mkdtempSync(join(tmpdir(), "omp-keys-"))
    roots.push(base)
    const real = join(base, "real")
    mkdirSync(real)
    symlinkSync(real, join(base, "link"))
    const keys = pathKeys(join(base, "link"))
    expect(keys[0]).toBe(join(base, "link"))
    expect(keys).toHaveLength(2)
  })
})

describe("omp source", () => {
  const other: OmpSession = {
    ...shipped,
    stem: "2026-08-24T09-00-00-000Z_bbbbbbbb-2222-7000-8888-000000000002",
    cwd: "/elsewhere",
    title: "Unrelated",
    updatedAt: "2026-08-25T13:30:00.000Z",
  }
  const linked: OmpSession = {
    ...shipped,
    stem: "2026-08-24T09-00-00-000Z_cccccccc-3333-7000-8888-000000000003",
    cwd: "/repo/wt",
    title: "Port the login timeout fix",
    updatedAt: "2026-08-23T13:30:00.000Z",
    entries: [{ kind: "user", text: "Fix the login timeout" }, { kind: "assistant", text: "Needs a test still." }],
  }
  const env = (root: string): ResumeEnv => ({
    source: ompSource(root, new Set(["/repo/main", "/repo/wt"])),
    exclude: new Set(),
    directory: "/repo/main",
    worktrees: [
      { path: "/repo/main", head: "a", branch: "main", detached: false, isMain: true },
      { path: "/repo/wt", head: "b", branch: "feat/login", detached: false, isMain: false },
    ],
    family: new Set(["/repo/main", "/repo/wt"]),
    now: Date.parse("2026-08-26T12:00:00.000Z"),
  })

  test("lists only this repository's worktrees and ranks by description", async () => {
    const { root } = store([shipped, other, linked])
    const listed = await listSessions(env(root), { mode: "list" })
    expect(listed.metadata.ids).toEqual(["aaaaaaaa-1111-7000-8888-000000000001", "cccccccc-3333-7000-8888-000000000003"])
    expect(listed.text).toContain("worktree: wt — /repo/wt")
    expect(listed.text).toContain("branch: feat/csv [worked-on → worktree now on main]")
    const ranked = await listSessions(env(root), { mode: "list", query: "login timeout" })
    expect((ranked.metadata.ids as string[])[0]).toBe("cccccccc-3333-7000-8888-000000000003")
    expect(ranked.metadata.recommended).toBe("cccccccc-3333-7000-8888-000000000003")
    expect((await listSessions(env(root), { mode: "list", scope: "all" })).metadata.sessions).toBe(3)
  })

  test("reads with the todo board, and gates a session outside the repository", async () => {
    const { root } = store([shipped, other])
    const read = await readSession(env(root), { mode: "read", session: "aaaaaaaa" })
    expect(read.text).toContain("Latest todo board:")
    expect(read.text).toContain("[~] Wire CLI")
    expect(read.text).toContain("Writer landed; the CLI flag is still open.")
    expect(read.text).not.toContain("secret reasoning")
    const gated = await readSession(env(root), { mode: "read", session: "bbbbbbbb" })
    expect(gated.metadata.gated).toBe(true)
    expect(gated.text).not.toContain("Starting on the export path")
    const confirmed = await readSession(env(root), { mode: "read", session: "bbbbbbbb", confirm: true })
    expect(confirmed.text).toContain("Starting on the export path")
  })
})
