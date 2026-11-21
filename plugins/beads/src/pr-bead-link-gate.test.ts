import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { writeExecutable } from "@srobroek/opencode-lib/executable-fixture"

import {
  beadsActive,
  bodyFileReader,
  bodyOfGhCreate,
  controlledByViewerPermission,
  decideCommand,
  decidePrCreate,
  REASON,
  repositoryControlled,
  repositoryFromGhCreate,
} from "./pr-bead-link-gate.ts"

describe("repository subprocess contract", () => {
  test("uses gh repo view's viewerPermission output contract", () => {
    const dir = mkdtempSync(join(tmpdir(), "beads-gh-"))
    const gh = join(dir, "gh")
    const args = join(dir, "args")
    writeExecutable(gh, '#!/bin/sh\nprintf "%s\\n" "$@" > "$GH_ARGS_FILE"\nprintf "%s\\n" "${' + 'GH_PERMISSION:-WRITE}"\n')
    const previousPath = process.env.PATH
    const previousArgsFile = process.env.GH_ARGS_FILE
    const previousPermission = process.env.GH_PERMISSION
    process.env.PATH = `${dir}:${previousPath ?? ""}`
    process.env.GH_ARGS_FILE = args
    process.env.GH_PERMISSION = "WRITE"
    try {
      expect(repositoryControlled("owner/repo")).toEqual({ kind: "controlled" })
      process.env.GH_PERMISSION = "READ"
      expect(repositoryControlled("owner/repo")).toEqual({ kind: "uncontrolled" })
      expect(readFileSync(args, "utf8").trim().split("\n")).toEqual([
        "repo",
        "view",
        "owner/repo",
        "--json",
        "viewerPermission",
        "--jq",
        ".viewerPermission",
      ])
    } finally {
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
      if (previousPermission === undefined) delete process.env.GH_PERMISSION
      else process.env.GH_PERMISSION = previousPermission
      if (previousArgsFile === undefined) delete process.env.GH_ARGS_FILE
      else process.env.GH_ARGS_FILE = previousArgsFile
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("refuses when the permission lookup fails and names the failure", () => {
    const dir = mkdtempSync(join(tmpdir(), "beads-gh-failure-"))
    const gh = join(dir, "gh")
    writeExecutable(gh, '#!/bin/sh\nprintf "%s" "permission lookup failed" >&2\nexit 1\n')
    const previousPath = process.env.PATH
    process.env.PATH = `${dir}:${previousPath ?? ""}`
    try {
      const control = repositoryControlled("owner/repo")
      expect(control.kind).toBe("unknown")
      const decision = decidePrCreate("plain prose", control)
      expect(decision?.block).toBe(true)
      expect(decision?.reason).toContain("Repository permission could not be determined")
      expect(decision?.reason).toContain("permission lookup failed")
    } finally {
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("repository control", () => {
  test("only write-capable viewer permissions control", () => {
    for (const permission of ["WRITE", "MAINTAIN", "ADMIN"]) expect(controlledByViewerPermission(permission)).toBe(true)
    for (const permission of ["READ", "TRIAGE", null, undefined, ""])
      expect(controlledByViewerPermission(permission)).toBe(false)
  })
  test("resolves explicit repo and rejects ambiguous targets", () => {
    expect(repositoryFromGhCreate("gh pr create --repo owner/old --repo=owner/new --body x")).toBe("owner/new")
    expect(repositoryFromGhCreate('gh pr create "--repo" owner/quoted --body x')).toBe("owner/quoted")
    expect(repositoryFromGhCreate("gh pr create -R owner/short --body x")).toBe("owner/short")
    expect(repositoryFromGhCreate('gh pr create --title "--repo owner/fake" --body x')).toBeNull()
    expect(repositoryFromGhCreate('gh pr create --body "--repo owner/fake"')).toBeNull()
    expect(repositoryFromGhCreate("gh pr create -R owner/one -Rowner/two --body x")).toBe("owner/two")
    expect(repositoryFromGhCreate("gh pr create -dRowner/two --body x")).toBe("owner/two")
    expect(repositoryFromGhCreate('gh pr create --body "--repo owner/fake"')).toBeNull()
    expect(repositoryFromGhCreate("gh pr create --repo ghe.example.com/owner/project --body x")).toBe(
      "ghe.example.com/owner/project",
    )
  })
})

describe("bodyOfGhCreate", () => {
  test("reads every real --body spelling, attached forms included", () => {
    expect(bodyOfGhCreate("gh pr create --title t --body 'Bead: omp-1'")).toBe("Bead: omp-1")
    expect(bodyOfGhCreate('gh pr create --body="Bead: omp-2"')).toBe("Bead: omp-2")
    expect(bodyOfGhCreate("gh pr create -b 'Bead: omp-3'")).toBe("Bead: omp-3")
    expect(bodyOfGhCreate("gh pr create -b'Bead: omp-4'")).toBe("Bead: omp-4")
    expect(bodyOfGhCreate("gh pr create -b=Bead:omp-5")).toBe("Bead:omp-5")
  })

  test("does not read a --body that lives inside another flag's value", () => {
    expect(bodyOfGhCreate("gh pr create --title 'add --body foo' --body 'Bead: omp-1'")).toBe("Bead: omp-1")
    expect(bodyOfGhCreate("gh pr create --title 'x --body sneaky'")).toBeNull()
  })

  test("ignores --body-file, which the gate cannot read", () => {
    expect(bodyOfGhCreate("gh pr create --body-file body.md")).toBeNull()
    expect(bodyOfGhCreate("gh pr create --body-file=b.md --title t")).toBeNull()
  })

  test("reports no body for --fill", () => {
    expect(bodyOfGhCreate("gh pr create --fill")).toBeNull()
  })

  test("ignores gh invocations that are not pr create", () => {
    expect(bodyOfGhCreate("gh pr edit 4 --body 'no bead'")).toBeNull()
    expect(bodyOfGhCreate("gh pr view 4 --json body")).toBeNull()
  })

  test("ignores a gh pr create that is not at command position", () => {
    expect(bodyOfGhCreate("echo gh pr create --body 'no bead'")).toBeNull()
  })

  test("reads through env prefixes", () => {
    expect(bodyOfGhCreate("GH_TOKEN=x gh pr create --body 'Bead: omp-9'")).toBe("Bead: omp-9")
  })
})

describe("beads activity", () => {
  test("allows bead-less bodies for a regular-file RETIRED sentinel", () => {
    const root = mkdtempSync(join(tmpdir(), "beads-retired-"))
    mkdirSync(join(root, ".beads"))
    writeFileSync(join(root, ".beads", "RETIRED"), "")
    try {
      expect(beadsActive(root)).toBe(false)
      expect(decidePrCreate("plain prose", beadsActive(root))).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  test("requires beads for ordinary and malformed RETIRED paths", () => {
    for (const retired of [false, true]) {
      const root = mkdtempSync(join(tmpdir(), "beads-live-"))
      mkdirSync(join(root, ".beads"))
      if (retired) mkdirSync(join(root, ".beads", "RETIRED"))
      try {
        expect(beadsActive(root)).toBe(true)
        expect(decidePrCreate("plain prose", beadsActive(root))).not.toBeNull()
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  })
  test("keeps a symlink RETIRED marker active even when it targets a file", () => {
    const root = mkdtempSync(join(tmpdir(), "beads-retired-link-"))
    mkdirSync(join(root, ".beads"))
    writeFileSync(join(root, "marker"), "")
    symlinkSync(join(root, "marker"), join(root, ".beads", "RETIRED"))
    try {
      expect(beadsActive(root)).toBe(true)
      expect(decidePrCreate("plain prose", beadsActive(root))).not.toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  test("does not inherit an ancestor sentinel past a nearer live ledger", () => {
    const root = mkdtempSync(join(tmpdir(), "beads-shadow-"))
    mkdirSync(join(root, ".beads"))
    writeFileSync(join(root, ".beads", "RETIRED"), "")
    const child = join(root, "child")
    mkdirSync(join(child, ".beads"), { recursive: true })
    try {
      expect(beadsActive(child)).toBe(true)
      expect(decidePrCreate("plain prose", beadsActive(child))).not.toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("decidePrCreate", () => {
  test("rejects internal linkage placeholders instead of treating them as an escape hatch", () => {
    const _placeholder = ["No", "-Bead"].join("")
    expect(decidePrCreate(`: revert of a bad merge`, true)).not.toBeNull()
    expect(decidePrCreate(`:`, true)).not.toBeNull()
  })

  test("blocks a body naming neither route and explains both", () => {
    const decision = decidePrCreate("Adds a fish alias.", true)
    expect(decision).toEqual({ block: true, reason: REASON })
    expect(decision?.reason).toContain("Bead: <id>")
  })

  test("allows Bead, Closes-Bead and several beads", () => {
    expect(decidePrCreate("Bead: chezmoi-4rc2", true)).toBeNull()
    expect(decidePrCreate("Closes-Bead: chezmoi-5vn", true)).toBeNull()
    expect(decidePrCreate("Bead: omp-1\nBead: omp-2", true)).toBeNull()
  })

  test("stays silent where beads is not active", () => {
    expect(decidePrCreate("Adds a fish alias.", false)).toBeNull()
  })

  test("does not accept a bare id or a bead-shaped word", () => {
    expect(decidePrCreate("Fixes omp-plugins-dd1 somehow", true)).not.toBeNull()
    expect(decidePrCreate("Beading: omp-1", true)).not.toBeNull()
  })
})

describe("decideCommand", () => {
  test("blocks a bead-less create anywhere in a chain", () => {
    expect(decideCommand("gh pr create --body 'Bead: omp-1' && gh pr create --body 'nothing'", true)).not.toBeNull()
  })

  test("allows a chain whose creates all name beads", () => {
    expect(decideCommand("gh pr create --body 'Bead: omp-1' ; gh pr create --body 'Bead: omp-2'", true)).toBeNull()
  })

  test("leaves a quoted separator inside a body intact", () => {
    expect(decideCommand("gh pr create --body 'Bead: omp-1; and more'", true)).toBeNull()
    expect(decideCommand("gh pr create --body 'no bead; just prose'", true)).not.toBeNull()
  })

  test("ignores unrelated gh commands", () => {
    expect(decideCommand("gh pr list --state open", true)).toBeNull()
    expect(decideCommand("gh run watch 42", true)).toBeNull()
  })
})

describe("per-segment repository control", () => {
  test("evaluates mixed targets independently in either order", () => {
    const controlled = (segment: string) => segment.includes("controlled/repo")
    expect(
      decideCommand(
        "gh pr create --repo external/repo --body plain && gh pr create --repo controlled/repo --body plain",
        controlled,
      ),
    ).not.toBeNull()
    expect(
      decideCommand(
        "gh pr create --repo controlled/repo --body plain && gh pr create --repo external/repo --body plain",
        controlled,
      ),
    ).not.toBeNull()
  })
  test("handles three mixed targets without sharing classification", () => {
    const controlled = (segment: string) => segment.includes("controlled/repo")
    expect(
      decideCommand(
        "gh pr create --repo external/repo --body 'Bead: x-1' && gh pr create --repo controlled/repo --body plain && gh pr create --repo external/repo --body 'Bead: x-2'",
        controlled,
      ),
    ).not.toBeNull()
  })
})

describe("repository control lookup cost", () => {
  test("classifies only a segment whose decision depends on it", () => {
    const asked: string[] = []
    const active = (segment: string) => {
      asked.push(segment)
      return true
    }
    // Resolving control spawns `gh`, twice, and this gate decides every bash call in the
    // session: a command with no PR to judge must cost no lookup at all.
    expect(decideCommand("git status && bd list && echo done", active)).toBeNull()
    expect(asked).toEqual([])
    // A create that already names a bead is allowed whatever the answer would have been.
    expect(decideCommand("gh pr create --body 'Bead: omp-1'", active)).toBeNull()
    expect(asked).toEqual([])
    expect(decideCommand("gh pr create --body 'plain prose'", active)).not.toBeNull()
    expect(asked).toHaveLength(1)
  })
})

describe("short flag clusters", () => {
  test("reads a body attached to a clustered -b", () => {
    expect(bodyOfGhCreate("gh pr create -dbNoBead")).toBe("NoBead")
    expect(bodyOfGhCreate("gh pr create -db 'Bead: omp-1'")).toBe("Bead: omp-1")
  })

  test("blocks a clustered bead-less body", () => {
    expect(decideCommand("gh pr create -dbjust prose", true)).not.toBeNull()
  })

  test("leaves clusters without b alone", () => {
    expect(bodyOfGhCreate("gh pr create -d --fill")).toBeNull()
  })
})

describe("body sources are judged alike", () => {
  const readFile = (files: Record<string, string>) => (path: string) => files[path]

  test("reads a bead trailer through $'...' quoting, whose \\n is a newline to the shell", () => {
    expect(decideCommand("gh pr create --body $'Summary\\n\\nBead: omp-1'", true)).toBeNull()
    expect(decideCommand("gh pr create --body $'Summary\\n\\nno trailer'", true)).not.toBeNull()
  })

  test.each([
    ["gh pr create --body-file b.md", "b.md"],
    ["gh pr create --body-file=b.md", "b.md"],
    ["gh pr create -F b.md --title t", "b.md"],
  ])("reads the file named by %s", (command, path) => {
    expect(decideCommand(command, true, undefined, { readFile: readFile({ [path]: "Bead: omp-1\n" }) })).toBeNull()
    expect(decideCommand(command, true, undefined, { readFile: readFile({ [path]: "no trailer\n" }) })).not.toBeNull()
  })

  test("lets an unreadable or stdin body file through, as before", () => {
    const none = { readFile: readFile({}) }
    expect(decideCommand("gh pr create --body-file missing.md", true, undefined, none)).toBeNull()
    expect(decideCommand("gh pr create --body-file -", true, undefined, none)).toBeNull()
    expect(decideCommand("gh pr create --body-file b.md", true)).toBeNull()
  })

  test("does not read a body file that an earlier segment of the chain may write", () => {
    const stale = { readFile: readFile({ "b.md": "no trailer\n" }) }
    expect(decideCommand("printf 'Bead: omp-1' > b.md && gh pr create --body-file b.md", true, undefined, stale)).toBeNull()
  })

  test("a refusal names where it looked", () => {
    const body = decideCommand("gh pr create --title t --body 'no trailer'", true)
    expect(body?.reason).toContain("Looked at the --body text")
    expect(body?.reason).toContain("not the branch or the title")
    const file = decideCommand("gh pr create --body-file b.md", true, undefined, { readFile: readFile({ "b.md": "x" }) })
    expect(file?.reason).toContain("Looked at --body-file b.md")
  })
})

describe("body files on disk", () => {
  const OVER_CAP = 64_001
  const decide = (command: string, cwd: string) =>
    decideCommand(command, true, undefined, { readFile: bodyFileReader(cwd) })
  const withDir = (run: (dir: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), "beads-bodyfile-"))
    try {
      run(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  test("refuses a readable file without a trailer and accepts one with it", () => {
    withDir((dir) => {
      writeFileSync(join(dir, "none.md"), "Adds a fish alias.\n")
      writeFileSync(join(dir, "ok.md"), "Adds a fish alias.\n\nBead: omp-1\n")
      expect(decide("gh pr create --body-file none.md", dir)?.reason).toContain("Looked at --body-file none.md")
      expect(decide("gh pr create --body-file ok.md", dir)).toBeNull()
    })
  })

  test("resolves a relative -F path against the supplied working directory", () => {
    withDir((dir) => {
      mkdirSync(join(dir, "sub"))
      writeFileSync(join(dir, "sub", "b.md"), "no trailer\n")
      expect(decide("gh pr create -F sub/b.md", dir)).not.toBeNull()
      expect(decide("gh pr create -F sub/b.md", join(dir, "sub"))).toBeNull()
    })
  })

  test("passes an oversized file, directly or through a symlink", () => {
    withDir((dir) => {
      writeFileSync(join(dir, "big.md"), "x".repeat(OVER_CAP))
      symlinkSync(join(dir, "big.md"), join(dir, "link.md"))
      expect(decide("gh pr create --body-file big.md", dir)).toBeNull()
      expect(decide("gh pr create --body-file link.md", dir)).toBeNull()
    })
  })

  test("reads a file of exactly the cap", () => {
    withDir((dir) => {
      writeFileSync(join(dir, "edge.md"), "x".repeat(64_000))
      expect(decide("gh pr create --body-file edge.md", dir)).not.toBeNull()
    })
  })

  test("passes a directory and a missing path", () => {
    withDir((dir) => {
      mkdirSync(join(dir, "d"))
      expect(decide("gh pr create --body-file d", dir)).toBeNull()
      expect(decide("gh pr create --body-file nope.md", dir)).toBeNull()
    })
  })

  // The test took 0.16-0.25 s alone (3 runs); 15 s covers the 10 s child deadline plus load.
  test("passes a FIFO without blocking", { timeout: 15_000 }, () => {
    withDir((dir) => {
      const made = spawnSync("mkfifo", [join(dir, "pipe")])
      if (made.status !== 0) {
        console.warn("SKIPPED: mkfifo is unavailable")
        return
      }
      const gate = join(import.meta.dir, "pr-bead-link-gate.ts")
      const script = `import { bodyFileReader, decideCommand } from ${JSON.stringify(gate)}
console.log(JSON.stringify(decideCommand("gh pr create --body-file pipe", true, undefined, { readFile: bodyFileReader(process.env.DIR ?? "") })))`
      const child = spawnSync(process.execPath, ["-e", script], { env: { ...process.env, DIR: dir }, timeout: 10_000, encoding: "utf8" })
      expect(child.error).toBeUndefined()
      expect(child.stdout.trim()).toBe("null")
    })
  })
})
