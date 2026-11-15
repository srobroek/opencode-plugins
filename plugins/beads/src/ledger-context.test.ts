import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createStore, describeLedger, findLedger, ledgerPrefix, ledgerRepoMismatch } from "./ledger-context.ts"
import { decideCommand, decidePrCreate } from "./pr-bead-link-gate.ts"
import { createLedgerWarning } from "./shell-gates.ts"

let root = ""
beforeAll(() => {
  root = realpathSync(mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "beads-ledger-context-")))
  mkdirSync(join(root, "proj", ".beads"), { recursive: true })
  mkdirSync(join(root, "proj", "sub", "deep"), { recursive: true })
  writeFileSync(join(root, "proj", ".beads", "config.yaml"), '# comment\nissue-prefix: "acme"\n')
  mkdirSync(join(root, "retired", ".beads"), { recursive: true })
  writeFileSync(join(root, "retired", ".beads", "RETIRED"), "")
  writeFileSync(join(root, "retired", ".beads", "metadata.json"), '{"dolt_database":"old_db"}')
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe("findLedger", () => {
  test("walks up from a subdirectory and reads the prefix", () => {
    const from = join(root, "proj", "sub", "deep")
    expect(findLedger(from)).toEqual({ from, store: join(root, "proj", ".beads"), prefix: "acme", retired: false })
  })

  test("reports a retired ledger and falls back to the database name", () => {
    expect(findLedger(join(root, "retired"))).toMatchObject({ retired: true, prefix: "old_db" })
  })

  test("a config without issue-prefix has no prefix", () => {
    expect(ledgerPrefix(join(root, "nothing", ".beads"))).toBeUndefined()
  })
})

describe("PR gate refusal names the ledger", () => {
  test("describeLedger gives path, prefix, start directory and the workdir hint", () => {
    const text = describeLedger({ from: "/w/sub", store: "/w/.beads", prefix: "acme", retired: false })
    expect(text).toContain("/w/.beads")
    expect(text).toContain('prefix "acme"')
    expect(text).toContain("walking up from /w/sub")
    expect(text).toContain("`workdir`")
  })

  test("a retired ledger says so", () => {
    expect(describeLedger({ from: "/w", store: "/w/.beads", retired: true })).toContain("It is RETIRED.")
  })

  test("a refusal appends the note; a pass never evaluates it", () => {
    const decision = decidePrCreate("prose", true, () => "NOTE")
    expect(decision?.reason.endsWith(" NOTE")).toBe(true)
    let calls = 0
    expect(decidePrCreate("Bead: a-1", true, () => String(calls++))).toBeNull()
    expect(decideCommand("gh pr list", true, () => String(calls++))).toBeNull()
    expect(calls).toBe(0)
  })

  test("the unknown-control refusal also carries the note", () => {
    const decision = decidePrCreate("prose", { kind: "unknown", reason: "no gh" }, () => "NOTE")
    expect(decision?.reason).toContain("no gh")
    expect(decision?.reason.endsWith(" NOTE")).toBe(true)
  })
})

describe("ledgerRepoMismatch", () => {
  const identity = (map: Record<string, string>) => (dir: string) => map[dir]

  test("warns when the ledger's directory belongs to another repository", () => {
    const warning = ledgerRepoMismatch({
      store: "/a/.beads",
      cwd: "/b",
      identity: identity({ "/a": "/a/.git", "/b": "/b/.git" }),
    })
    expect(warning).toContain("/a/.beads")
    expect(warning).toContain("`workdir`")
  })

  test("stays silent for the same repository, e.g. a linked worktree", () => {
    expect(
      ledgerRepoMismatch({
        store: "/a/.beads",
        cwd: "/wt",
        identity: identity({ "/a": "/a/.git", "/wt": "/a/.git" }),
      }),
    ).toBeUndefined()
  })

  test("stays silent when git cannot answer or cwd is outside any repository", () => {
    expect(ledgerRepoMismatch({ store: "/a/.beads", cwd: "/b", identity: identity({ "/a": "/a/.git" }) })).toBeUndefined()
    expect(
      ledgerRepoMismatch({ store: "/a/.beads", cwd: "/b", identity: identity({ "/a": "/a/.git", "/b": "/b" }) }),
    ).toBeUndefined()
  })

  test("warns when the ledger sits above the repository (home-directory ledger)", () => {
    expect(
      ledgerRepoMismatch({ store: "/h/.beads", cwd: "/h/repo", identity: identity({ "/h": "/h", "/h/repo": "/h/repo/.git" }) }),
    ).toContain("/h/repo")
  })
})

describe("createStore and createLedgerWarning", () => {
  test("a command-local BEADS_DIR beats the ambient one, which beats the walk", () => {
    const cwd = join(root, "proj", "sub")
    expect(createStore(cwd, "/x/.beads", { BEADS_DIR: "/y/.beads" })).toBe("/x/.beads")
    expect(createStore(cwd, undefined, { BEADS_DIR: "/y/.beads" })).toBe("/y/.beads")
    expect(createStore(cwd, undefined, { BEADS_DIR: "" })).toBe(join(root, "proj", ".beads"))
  })

  const identity = (dir: string) => (dir.startsWith(`${root}/proj`) ? "proj-git" : "other-git")

  test("warns for a bd create pinned to another repository's ledger", () => {
    const other = join(root, "other")
    const warning = createLedgerWarning("bd create --title t", join(root, "proj"), { BEADS_DIR: join(other, ".beads") }, identity)
    expect(warning).toContain(join(other, ".beads"))
  })

  test("is silent for the project's own ledger and for other verbs", () => {
    const cwd = join(root, "proj", "sub")
    expect(createLedgerWarning("bd create --title t", cwd, {}, identity)).toBeUndefined()
    expect(
      createLedgerWarning("bd list", join(root, "proj"), { BEADS_DIR: join(root, "other", ".beads") }, identity),
    ).toBeUndefined()
  })

  test("follows a literal cd prefix", () => {
    const warning = createLedgerWarning(
      `cd ${join(root, "other")} && bd create --title t`,
      join(root, "proj"),
      { BEADS_DIR: join(root, "proj", ".beads") },
      identity,
    )
    expect(warning).toContain(join(root, "proj", ".beads"))
  })
})
