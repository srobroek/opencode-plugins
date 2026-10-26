import { describe, expect, test } from "bun:test"
import type { SupervisedRun } from "@srobroek/opencode-lib/subprocess"
import {
  confirmScan,
  countFindings,
  DEFAULT_TIMEOUT_SECONDS,
  interpretScan,
  MAX_OUTPUT_CHARS,
  readScanParams,
  resolveTargets,
  runScan,
  SCAN_TOOL,
  scanArgv,
} from "./impeccable.ts"

const exited = (exitCode: number, stdout: string, stderr = ""): SupervisedRun => ({
  kind: "exited",
  exitCode,
  signalCode: null,
  stdout,
  stderr,
})

describe("readScanParams", () => {
  test("defaults the timeout and config use", () => {
    expect(readScanParams({ targets: ["src"] })).toEqual({
      targets: ["src"],
      noConfig: false,
      timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
    })
  })

  test("rejects missing targets, flag-shaped targets and a bad timeout", () => {
    expect(readScanParams({})).toBeString()
    expect(readScanParams({ targets: [] })).toBeString()
    expect(readScanParams({ targets: [""] })).toBeString()
    expect(readScanParams({ targets: ["--list-rules"] })).toContain("./--list-rules")
    expect(readScanParams({ targets: ["src"], timeoutSeconds: 0 })).toBeString()
    expect(readScanParams({ targets: ["src"], timeoutSeconds: 1.5 })).toBeString()
    expect(readScanParams({ targets: ["src"], noConfig: "yes" })).toBeString()
    expect(readScanParams({ targets: ["src"], viewport: "375" })).toBeString()
    expect(readScanParams({ targets: ["src"], viewport: "375x812" })).toMatchObject({ viewport: "375x812" })
  })
})

test("paths resolve against the session directory; URLs and absolute paths stay", () => {
  expect(resolveTargets(["src", "/abs/x.html", "http://localhost:3000/a", "HTTPS://e.test"], "/p")).toEqual([
    "/p/src",
    "/abs/x.html",
    "http://localhost:3000/a",
    "HTTPS://e.test",
  ])
})

test("scanArgv runs detect with JSON output and the raw-scan switch only when asked", () => {
  expect(scanArgv({ targets: ["a"], noConfig: false, timeoutSeconds: 1 }, ["/p/a"])).toEqual([
    "npx",
    "--yes",
    "impeccable",
    "detect",
    "--json",
    "/p/a",
  ])
  expect(scanArgv({ targets: ["a"], noConfig: true, timeoutSeconds: 1 }, ["/p/a"])).toContain("--no-config")
  expect(scanArgv({ targets: ["u"], noConfig: false, viewport: "375x812", timeoutSeconds: 1 }, ["http://x"]).slice(5)).toEqual([
    "--viewport",
    "375x812",
    "http://x",
  ])
})

test("countFindings reads an array or a findings list, else gives up", () => {
  expect(countFindings([{}, {}])).toBe(2)
  expect(countFindings({ findings: [{}] })).toBe(1)
  expect(countFindings({ results: [] })).toBe(0)
  expect(countFindings({ other: 1 })).toBeNull()
  expect(countFindings("x")).toBeNull()
})

describe("interpretScan", () => {
  test("exit 0 is clean, exit 2 is findings, both ok", () => {
    expect(interpretScan(exited(0, "[]"), 1)).toMatchObject({ ok: true, status: "clean", findings: 0 })
    const found = interpretScan(exited(2, '[{"antipattern":"side-tab","line":0}]', "human text"), 1)
    expect(found).toMatchObject({ ok: true, status: "findings", findings: 1, exitCode: 2 })
    expect(found.text).toContain('"side-tab"')
    expect(found.text).not.toContain("human text")
  })

  test("exit 1 is an unscanned target and anything else a failure that keeps stderr", () => {
    expect(interpretScan(exited(1, "[]"), 1)).toMatchObject({ ok: false, status: "unscanned" })
    const failed = interpretScan(exited(127, "", "npx: not found"), 1)
    expect(failed).toMatchObject({ ok: false, status: "failed", findings: null })
    expect(failed.text).toContain("npx: not found")
  })

  test("a run with no exit is no verdict", () => {
    const timeout = interpretScan({ kind: "timeout", stdout: "", stderr: "" }, 7)
    expect(timeout).toMatchObject({ ok: false, status: "timeout" })
    expect(timeout.text).toContain("7s")
    expect(interpretScan({ kind: "aborted", stdout: "", stderr: "" }, 1).status).toBe("aborted")
    expect(interpretScan({ kind: "lost", stdout: "", stderr: "" }, 1).status).toBe("lost")
  })

  test("large output is cut", () => {
    const big = JSON.stringify(Array.from({ length: 5000 }, (_, i) => ({ id: i, text: "x".repeat(20) })))
    const result = interpretScan(exited(2, big), 1)
    expect(result.text.length).toBeLessThan(MAX_OUTPUT_CHARS + 200)
    expect(result.text).toContain("output cut")
    expect(result.findings).toBe(5000)
  })
})

test("runScan passes the resolved argv, cwd and timeout to the runner", async () => {
  const calls: unknown[] = []
  const result = await runScan({ targets: ["web"], noConfig: false, timeoutSeconds: 5 }, "/p", undefined, async (argv, options) => {
    calls.push({ argv, options })
    return exited(0, "[]")
  })
  expect(result.status).toBe("clean")
  expect(calls).toEqual([
    {
      argv: ["npx", "--yes", "impeccable", "detect", "--json", "/p/web"],
      options: { cwd: "/p", timeoutMs: 5000, signal: undefined },
    },
  ])
})

test("confirmScan turns only an allowed scan into a prompt", () => {
  const scan = { action: SCAN_TOOL, resources: ["/p/src"], effect: "allow" } as {
    action: string
    resources: string[]
    effect: string
    message?: string
  }
  confirmScan(scan)
  expect(scan.effect).toBe("ask")
  expect(scan.message).toContain("/p/src")
  const denied = { action: SCAN_TOOL, resources: [], effect: "deny" }
  confirmScan(denied)
  expect(denied.effect).toBe("deny")
  const other = { action: "shell", resources: [], effect: "allow" }
  confirmScan(other)
  expect(other.effect).toBe("allow")
})
