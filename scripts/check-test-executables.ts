#!/usr/bin/env bun
/**
 * Fail when a test writes an executable directly instead of through `writeExecutable`
 * (`@srobroek/opencode-lib/executable-fixture`). Endpoint security agents check every newly
 * written file the first time it runs, which under load stalls that run for up to tens of
 * seconds and times tests out; a symlink to the committed trampoline starts at once.
 *
 * - `writeFileSync(..., { mode: <executable> })` in a `*.test.ts` file is always a finding.
 * - `chmodSync(..., <executable>)` is counted per file against CHMOD_BASELINE, which may only
 *   shrink. Mark a directory chmod with `// check-test-executables: <reason>` on the same line.
 *
 *   bun scripts/check-test-executables.ts   check plugins/ and scripts/
 */

import { readFileSync } from "node:fs"
import path from "node:path"

export type Site = { line: number; kind: "write" | "chmod" }
export type Finding = { file: string; line: number; reason: string }

/** Test files with chmodSync calls to an executable mode that predate this check. Lower, never raise. */
export const CHMOD_BASELINE: Record<string, number> = {
  "plugins/beads/src/binary-hooks.test.ts": 2,
  "plugins/beads/src/gate-admission-owner.test.ts": 1,
  "plugins/delivery/src/cleanup.test.ts": 4,
  "plugins/delivery/src/forge-adapter.test.ts": 5,
  "plugins/delivery/src/land.test.ts": 2,
  "plugins/delivery/src/landing-receipt.test.ts": 2,
  "plugins/dep-update/src/apply-safety.test.ts": 1,
  "plugins/lib/src/session-eviction.test.ts": 1,
  "plugins/lib/src/worktree-locks.test.ts": 6,
  "plugins/parley/src/uploads.test.ts": 1,
  "plugins/safety/src/branch-delete.timeout.test.ts": 1,
  "plugins/safety/src/commit-msg.test.ts": 2,
  "plugins/safety/src/worktree-detached.timeout.test.ts": 1,
  "plugins/session/src/index.test.ts": 2,
  "plugins/speckit/src/commit.test.ts": 4,
  "plugins/speckit/src/index.test.ts": 1,
  "plugins/subagent-worktree/src/lifecycle.test.ts": 6,
  "plugins/worktrunk/src/merge-gate.test.ts": 1,
  "scripts/sync-cad.test.ts": 2,
}

const EXEMPT = /\/\/\s*check-test-executables:\s*\S/
/** An octal literal whose owner digit has the execute bit. */
const EXECUTABLE_MODE = "0o[1357][0-7]{2}"
const WRITE = new RegExp(`writeFileSync\\((?:(?!writeFileSync\\()[\\s\\S]){0,400}?\\bmode:\\s*${EXECUTABLE_MODE}\\b`, "g")
const CHMOD = new RegExp(`chmodSync\\([^\\n]*?,\\s*${EXECUTABLE_MODE}\\s*\\)`, "g")

const lineAt = (text: string, index: number) => text.slice(0, index).split("\n").length

/** Direct executable writes and executable chmods in one file, by the line each call starts on. */
export function directExecutables(text: string): Site[] {
  const lines = text.split("\n")
  const sites: Site[] = []
  for (const [pattern, kind] of [
    [WRITE, "write"],
    [CHMOD, "chmod"],
  ] as const) {
    for (const match of text.matchAll(pattern)) {
      const line = lineAt(text, match.index ?? 0)
      const last = lineAt(text, (match.index ?? 0) + match[0].length)
      if (lines.slice(line - 1, last).some((l) => EXEMPT.test(l))) continue
      sites.push({ line, kind })
    }
  }
  return sites.sort((a, b) => a.line - b.line)
}

/** Findings for test files (repo-relative path to text) against a chmod baseline. */
export function checkTree(files: Map<string, string>, baseline: Record<string, number>): Finding[] {
  const findings: Finding[] = []
  const counted = new Set<string>()
  for (const [file, text] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    const sites = directExecutables(text)
    for (const site of sites.filter((s) => s.kind === "write"))
      findings.push({
        file,
        line: site.line,
        reason: "writes an executable directly; use writeExecutable from @srobroek/opencode-lib/executable-fixture",
      })
    const chmods = sites.filter((s) => s.kind === "chmod")
    if (chmods.length === 0) continue
    counted.add(file)
    const allowed = baseline[file] ?? 0
    if (chmods.length > allowed)
      findings.push({
        file,
        line: chmods[allowed]?.line ?? 1,
        reason: `${chmods.length} chmodSync calls to an executable mode, baseline ${allowed}; use writeExecutable for a script, or mark a directory with \`// check-test-executables: <reason>\``,
      })
    else if (chmods.length < allowed)
      findings.push({
        file,
        line: chmods[0]?.line ?? 1,
        reason: `baseline ${allowed} but only ${chmods.length} chmodSync call(s) left; lower its CHMOD_BASELINE entry`,
      })
  }
  for (const file of Object.keys(baseline).sort())
    if (!counted.has(file))
      findings.push({
        file,
        line: 1,
        reason: "CHMOD_BASELINE names a file that has no chmodSync calls or no longer exists; remove the entry",
      })
  return findings
}

function main(): number {
  const root = path.resolve(import.meta.dir, "..")
  const files = new Map<string, string>()
  for (const pattern of ["plugins/*/src/**/*.test.ts", "scripts/**/*.test.ts"])
    for (const file of new Bun.Glob(pattern).scanSync({ cwd: root }))
      if (!file.includes("node_modules") && file !== "scripts/check-test-executables.test.ts")
        files.set(file, readFileSync(path.join(root, file), "utf8"))
  const findings = checkTree(files, CHMOD_BASELINE)
  for (const f of findings) console.error(`${f.file}:${f.line}: ${f.reason}`)
  if (findings.length > 0) {
    console.error(`check-test-executables: ${findings.length} finding(s)`)
    return 1
  }
  console.log(`check-test-executables: ${files.size} test file(s) clean`)
  return 0
}

if (import.meta.main) process.exit(main())
