import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SupervisedRun } from "@srobroek/opencode-lib/subprocess"
import {
  chooseRunner,
  confirmPack,
  DEFAULT_TIMEOUT_SECONDS,
  interpretPack,
  LARGE_PACK_TOKENS,
  PACK_INPUT,
  PACK_TOOL,
  type PackParams,
  packArgv,
  packLabel,
  parseSummary,
  prunePacks,
  REPOMIX_VERSION,
  readPackParams,
  resolveTarget,
  runPack,
  targetResource,
} from "./pack.ts"

const exited = (exitCode: number, stdout: string, stderr = ""): SupervisedRun => ({
  kind: "exited",
  exitCode,
  signalCode: null,
  stdout,
  stderr,
})

const params = (extra: Partial<PackParams> = {}): PackParams => ({
  include: [],
  ignore: [],
  compress: false,
  style: "xml",
  lineNumbers: false,
  timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
  ...extra,
})

// Captured from repomix 1.18.0 with stdout piped: spinner frames, colour codes and \r included.
const SUMMARY = [
  "",
  "\u001b[1m📦 Repomix v1.18.0\u001b[22m",
  "",
  "\r\u001b[K\u001b[?25l⠋ Initializing...",
  "\r\u001b[K\u001b[1A\r\u001b[K\u001b[?25l⠙ Processing file... (3/3) src/a.ts",
  "\r\u001b[K\u001b[1A\r\u001b[K\u001b[?25l✔ Packing completed successfully!",
  "\u001b[?25h",
  "📈 Top 3 Files by Token Count:",
  "──────────────────────────────",
  "1.  src/mcp/tools/mcpToolRuntime.ts (926 tokens, 4,081 chars, 19%)",
  "2.  src/a b.ts (1,213 tokens, 18 chars, 1.5%)",
  "",
  "🔎 Security Check:",
  "──────────────────",
  "1 suspicious file(s) detected and excluded from the output:",
  "1. src/creds.ts",
  "   - 1 security issue detected",
  "",
  "These files have been excluded from the output for security reasons.",
  "",
  "📊 Pack Summary:",
  "────────────────",
  "  Total Files: 11 files",
  " Total Tokens: 4,875 tokens",
  "  Total Chars: 20,636 chars",
  "       Output: /tmp/x.xml",
  "     Security: 1 suspicious file(s) detected and excluded",
  "",
  "🎉 All Done!",
].join("\n")

describe("readPackParams", () => {
  test("defaults to the session directory, xml, no compression", () => {
    expect(readPackParams({})).toEqual(params())
    expect(readPackParams(undefined)).toEqual(params())
  })

  test("accepts a remote at a ref and a single glob as a string", () => {
    expect(readPackParams({ remote: "yamadashy/repomix", ref: "v1.17.0", include: "src/**", compress: true })).toEqual(
      params({ remote: "yamadashy/repomix", ref: "v1.17.0", include: ["src/**"], compress: true }),
    )
    expect(readPackParams({ remote: "https://github.com/yamadashy/repomix" })).toMatchObject({
      remote: "https://github.com/yamadashy/repomix",
    })
  })

  test("refuses ambiguous targets, flag-shaped values and bad options", () => {
    expect(readPackParams({ directory: "a", remote: "o/r" })).toContain("not both")
    expect(readPackParams({ ref: "main" })).toContain("remote")
    expect(readPackParams({ remote: "--remote-trust-config" })).toBeString()
    expect(readPackParams({ remote: "git@github.com:o/r.git" })).toBeString()
    expect(readPackParams({ remote: "http://example.test/o/r" })).toBeString()
    expect(readPackParams({ remote: "o/r", ref: "-x" })).toBeString()
    expect(readPackParams({ remote: "o/r", ref: "a..b" })).toBeString()
    expect(readPackParams({ include: ["a,b"] })).toContain("comma")
    expect(readPackParams({ ignore: [""] })).toBeString()
    expect(readPackParams({ include: 3 })).toBeString()
    expect(readPackParams({ compress: "yes" })).toBeString()
    expect(readPackParams({ style: "json" })).toBeString()
    expect(readPackParams({ timeoutSeconds: 0 })).toBeString()
    expect(readPackParams({ directory: "" })).toBeString()
  })

  test("the schema offers exactly the validated styles", () => {
    expect(PACK_INPUT.properties.style.enum).toEqual(["xml", "markdown", "plain"])
  })
})

test("targets resolve against the session directory and name their resource", () => {
  const local = resolveTarget(params({ directory: "plugins/lib" }), "/p")
  expect(local).toEqual({ kind: "local", directory: "/p/plugins/lib" })
  expect(targetResource(local)).toBe("/p/plugins/lib")
  expect(resolveTarget(params(), "/p")).toEqual({ kind: "local", directory: "/p" })
  expect(resolveTarget(params({ directory: "/abs" }), "/p")).toEqual({ kind: "local", directory: "/abs" })
  expect(targetResource(resolveTarget(params({ remote: "o/r", ref: "v1" }), "/p"))).toBe("o/r@v1")
  expect(targetResource(resolveTarget(params({ remote: "o/r" }), "/p"))).toBe("o/r")
})

test("chooseRunner prefers PATH and falls back to the pinned npx package", () => {
  expect(chooseRunner(() => "/bin/repomix")).toEqual({ kind: "path", argv: ["/bin/repomix"] })
  expect(chooseRunner(() => null)).toEqual({ kind: "npx", argv: ["npx", "--yes", `repomix@${REPOMIX_VERSION}`] })
})

describe("packArgv", () => {
  const runner = { kind: "path" as const, argv: ["repomix"] }

  test("a local pack loads only the empty config and never disables the secret scan", () => {
    const argv = packArgv(runner, params(), { kind: "local", directory: "/p" }, "/t/empty.json", "/t/out.xml")
    expect(argv).toEqual([
      "repomix",
      "--config=/t/empty.json",
      "--output=/t/out.xml",
      "--style=xml",
      "--no-file-summary",
      "--no-git-sort-by-changes",
      "--top-files-len=10",
      "/p",
    ])
  })

  test("a remote pack passes the repo and ref as values, with every option", () => {
    const argv = packArgv(
      runner,
      params({ compress: true, lineNumbers: true, include: ["src/**", "*.md"], ignore: ["**/dist/**"], style: "markdown" }),
      { kind: "remote", remote: "o/r", ref: "v1.0.0" },
      "/t/c.json",
      "/t/o.md",
    )
    expect(argv.slice(4)).toEqual([
      "--no-file-summary",
      "--no-git-sort-by-changes",
      "--top-files-len=10",
      "--compress",
      "--output-show-line-numbers",
      "--include=src/**,*.md",
      "--ignore=**/dist/**",
      "--remote=o/r",
      "--remote-branch=v1.0.0",
    ])
    expect(argv[3]).toBe("--style=markdown")
  })

  test("no combination passes a trust or security-off flag", () => {
    const all = packArgv(
      { kind: "npx", argv: ["npx", "--yes", "repomix@1"] },
      params({ compress: true, lineNumbers: true, include: ["a"], ignore: ["b"] }),
      { kind: "remote", remote: "o/r", ref: "main" },
      "/c",
      "/o",
    )
    expect(all).not.toContain("--remote-trust-config")
    expect(all).not.toContain("--no-security-check")
    expect(all).not.toContain("--stdout")
  })
})

test("packLabel names the directory or repo and ref in a file-safe way", () => {
  expect(packLabel({ kind: "local", directory: "/p/plugins/lib" })).toBe("lib")
  expect(packLabel({ kind: "remote", remote: "yamadashy/repomix", ref: "v1.17.0" })).toBe("repomix-v1.17.0")
  expect(packLabel({ kind: "remote", remote: "https://github.com/o/r.git", ref: "feat/x" })).toBe("r-feat-x")
  expect(packLabel({ kind: "local", directory: "/" })).toBe("pack")
})

describe("parseSummary", () => {
  test("reads the version, totals, top files and the files the secret scan dropped", () => {
    expect(parseSummary(SUMMARY)).toEqual({
      version: "1.18.0",
      files: 11,
      tokens: 4875,
      chars: 20636,
      topFiles: [
        { path: "src/mcp/tools/mcpToolRuntime.ts", tokens: 926 },
        { path: "src/a b.ts", tokens: 1213 },
      ],
      suspiciousExcluded: ["src/creds.ts"],
    })
  })

  test("a clean scan lists nothing and unknown output degrades to nulls", () => {
    const clean = SUMMARY.replace(/1 suspicious[\s\S]*?reasons\.\n/, "✔ No suspicious files detected.\n")
    expect(parseSummary(clean).suspiciousExcluded).toEqual([])
    expect(parseSummary("something else")).toEqual({
      version: null,
      files: null,
      tokens: null,
      chars: null,
      topFiles: [],
      suspiciousExcluded: [],
    })
  })
})

describe("interpretPack", () => {
  const yes = () => true

  test("a pack returns its path and metrics, never contents", () => {
    const result = interpretPack(exited(0, SUMMARY), "/t/out.xml", "xml", 1, yes)
    expect(result).toMatchObject({ ok: true, status: "packed", path: "/t/out.xml" })
    expect(result.text).toContain("Packed 11 files, 4,875 tokens (20,636 chars) to /t/out.xml")
    expect(result.text).toContain(`grep it for '<file path="'`)
    expect(result.text).toContain("src/mcp/tools/mcpToolRuntime.ts")
    expect(result.text).toContain("Left out by the secret scan (1): src/creds.ts")
    expect(result.text).not.toContain("researcher")
    expect(interpretPack(exited(0, SUMMARY), "/t/o.md", "markdown", 1, yes).text).toContain("'## File: '")
  })

  test("a large pack advises a subagent", () => {
    const big = SUMMARY.replace("4,875 tokens", `${LARGE_PACK_TOKENS + 1} tokens`)
    expect(interpretPack(exited(0, big), "/o", "xml", 1, yes).text).toContain("researcher subagent")
  })

  test("a failure, a missing pack and a run without exit carry the reason", () => {
    const failed = interpretPack(exited(1, "", "\u001b[31mError: Repository not found\u001b[39m"), "/o", "xml", 1, yes)
    expect(failed).toMatchObject({ ok: false, status: "failed" })
    expect(failed.text).toContain("exit 1")
    expect(failed.text).toContain("Error: Repository not found")
    expect(failed.text).not.toContain("\u001b")
    expect(interpretPack(exited(0, SUMMARY), "/o", "xml", 1, () => false).text).toContain("wrote no pack")
    const timeout = interpretPack({ kind: "timeout", stdout: "", stderr: "" }, "/o", "xml", 7, yes)
    expect(timeout).toMatchObject({ ok: false, status: "timeout" })
    expect(timeout.text).toContain("7s")
    expect(interpretPack({ kind: "aborted", stdout: "", stderr: "" }, "/o", "xml", 1, yes).status).toBe("aborted")
    expect(interpretPack({ kind: "lost", stdout: "", stderr: "" }, "/o", "xml", 1, yes).status).toBe("lost")
  })
})

test("prunePacks removes only this plugin's stale packs and run directories", () => {
  const root = mkdtempSync(join(tmpdir(), "repomix-prune-"))
  try {
    const old = Date.now() / 1000 - 2 * 24 * 60 * 60
    for (const name of ["repomix-old.xml", "keep.txt"]) {
      writeFileSync(join(root, name), "x")
      utimesSync(join(root, name), old, old)
    }
    mkdirSync(join(root, "run-old"))
    utimesSync(join(root, "run-old"), old, old)
    writeFileSync(join(root, "repomix-new.xml"), "x")
    prunePacks(root, Date.now())
    expect(readdirSync(root).sort()).toEqual(["keep.txt", "repomix-new.xml"])
    prunePacks(join(root, "missing"), Date.now())
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("runPack runs in an empty directory with an empty config and removes it after", async () => {
  const root = mkdtempSync(join(tmpdir(), "repomix-run-"))
  try {
    let seen: { argv: string[]; cwd: string; timeoutMs: number; config: string; cwdFiles: string[] } | undefined
    const result = await runPack(
      params({ timeoutSeconds: 9 }),
      { kind: "local", directory: "/p/lib" },
      { kind: "path", argv: ["repomix"] },
      undefined,
      {
        root,
        exec: async (argv, { cwd, timeoutMs }) => {
          const config = (argv.find((arg) => arg.startsWith("--config=")) ?? "").slice("--config=".length)
          const output = (argv.find((arg) => arg.startsWith("--output=")) ?? "").slice("--output=".length)
          seen = { argv, cwd, timeoutMs, config: readFileSync(config, "utf8"), cwdFiles: readdirSync(cwd) }
          writeFileSync(output, "<files></files>")
          return exited(0, SUMMARY)
        },
      },
    )
    expect(result.ok).toBe(true)
    expect(seen?.timeoutMs).toBe(9000)
    expect(seen?.config.trim()).toBe("{}")
    expect(seen?.cwdFiles).toEqual(["repomix.empty.json"])
    expect(seen?.argv.at(-1)).toBe("/p/lib")
    expect(existsSync(seen?.cwd ?? "/")).toBe(false)
    expect(result.path).toMatch(new RegExp(`^${root}/repomix-lib-[\\w-]+\\.xml$`))
    expect(existsSync(result.path ?? "")).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("confirmPack turns only an allowed npx pack into a prompt", () => {
  type E = { action: string; resources: string[]; metadata?: Record<string, unknown>; effect: string; message?: string }
  const npx: E = { action: PACK_TOOL, resources: ["o/r@v1"], metadata: { runner: "npx" }, effect: "allow" }
  confirmPack(npx)
  expect(npx.effect).toBe("ask")
  expect(npx.message).toContain(`repomix@${REPOMIX_VERSION}`)
  expect(npx.message).toContain("o/r@v1")
  const installed: E = { action: PACK_TOOL, resources: [], metadata: { runner: "path" }, effect: "allow" }
  confirmPack(installed)
  expect(installed.effect).toBe("allow")
  const denied: E = { action: PACK_TOOL, resources: [], metadata: { runner: "npx" }, effect: "deny" }
  confirmPack(denied)
  expect(denied.effect).toBe("deny")
  const other: E = { action: "shell", resources: [], metadata: { runner: "npx" }, effect: "allow" }
  confirmPack(other)
  expect(other.effect).toBe("allow")
})
