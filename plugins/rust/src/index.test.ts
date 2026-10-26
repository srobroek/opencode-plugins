import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createFakeContext } from "@srobroek/opencode-lib/testing"
import { ADVISORIES, addedText, advisoriesFor, runsCargoInstall, workflowRunsCargoInstall } from "./advisories.ts"
import plugin, { SKILL_NAMES } from "./index.ts"
import { decidePath, decideToolCall, latestMigration, migrationTarget } from "./migration-gate.ts"

/** A repo with `migrations/<name>` for each entry; directory entries end in `/`. */
function repo(entries: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "migration-gate-"))
  const dir = join(root, "migrations")
  mkdirSync(dir, { recursive: true })
  for (const entry of entries) {
    if (entry.endsWith("/")) {
      mkdirSync(join(dir, entry.slice(0, -1)), { recursive: true })
      writeFileSync(join(dir, entry.slice(0, -1), "up.sql"), "SELECT 1;\n")
    } else {
      writeFileSync(join(dir, entry), "SELECT 1;\n")
    }
  }
  return root
}

describe("migrationTarget", () => {
  test("finds the numbered entry under migrations/", () => {
    expect(migrationTarget("migrations/0001_init.sql")).toEqual({ dir: "migrations", entry: "0001_init.sql" })
    expect(migrationTarget("crates/db/migrations/20240115120000_add.sql")).toEqual({
      dir: "crates/db/migrations",
      entry: "20240115120000_add.sql",
    })
    expect(migrationTarget("migrations/0003_name/up.sql")).toEqual({ dir: "migrations", entry: "0003_name" })
    expect(migrationTarget("/abs/migrations/0001_init.sql")?.dir).toBe("/abs/migrations")
  })

  test("ignores unnumbered entries and non-migration paths", () => {
    expect(migrationTarget("migrations/README.md")).toBeNull()
    expect(migrationTarget("migrations/.gitkeep")).toBeNull()
    expect(migrationTarget("src/lib.rs")).toBeNull()
    expect(migrationTarget("migrations")).toBeNull()
    expect(migrationTarget("docs/migrations-guide.md")).toBeNull()
  })
})

describe("latestMigration", () => {
  test("orders by numeric prefix, not lexically", () => {
    expect(latestMigration(join(repo(["1_a.sql", "2_b.sql", "10_c.sql", "README.md"]), "migrations"))).toBe("10_c.sql")
  })

  test("handles timestamp prefixes and per-migration directories", () => {
    const root = repo(["20240101090000_a.sql", "20240115120000_b/"])
    expect(latestMigration(join(root, "migrations"))).toBe("20240115120000_b")
  })

  test("a missing directory yields nothing", () => {
    expect(latestMigration(join(tmpdir(), "no-such-migrations-dir"))).toBeUndefined()
  })
})

describe("decidePath", () => {
  test("refuses a committed migration that is not the latest", () => {
    const root = repo(["0001_init.sql", "0002_add.sql"])
    const reason = decidePath(join(root, "migrations", "0001_init.sql"))
    expect(reason).toContain("append-only")
    expect(reason).toContain("0002_add.sql")
  })

  test("leaves the latest migration editable and allows a new one", () => {
    const root = repo(["0001_init.sql", "0002_add.sql"])
    expect(decidePath(join(root, "migrations", "0002_add.sql"))).toBeUndefined()
    expect(decidePath(join(root, "migrations", "0003_new.sql"))).toBeUndefined()
  })

  test("numeric ordering decides which one is latest", () => {
    const root = repo(["1_a.sql", "2_b.sql", "10_c.sql"])
    expect(decidePath(join(root, "migrations", "10_c.sql"))).toBeUndefined()
    expect(decidePath(join(root, "migrations", "2_b.sql"))).toBeDefined()
  })

  test("refuses a file inside an older per-migration directory", () => {
    const root = repo(["0001_init/", "0002_add/"])
    expect(decidePath(join(root, "migrations", "0001_init", "up.sql"))).toBeDefined()
    expect(decidePath(join(root, "migrations", "0002_add", "up.sql"))).toBeUndefined()
  })

  test("ignores unnumbered files and other trees", () => {
    const root = repo(["0001_init.sql", "0002_add.sql"])
    writeFileSync(join(root, "migrations", "README.md"), "docs\n")
    expect(decidePath(join(root, "migrations", "README.md"))).toBeUndefined()
    expect(decidePath(join(root, "src", "lib.rs"))).toBeUndefined()
  })
})

describe("decideToolCall", () => {
  test("refuses write, edit, patch and shell writes; ignores reads", () => {
    const root = repo(["0001_init.sql", "0002_add.sql"])
    const old = "migrations/0001_init.sql"
    expect(decideToolCall("write", { path: old, content: "SELECT 2;" }, root)).toBeDefined()
    expect(decideToolCall("edit", { path: join(root, old), oldString: "1", newString: "2" }, "/nowhere")).toBeDefined()
    const patchText = `*** Begin Patch\n*** Update File: src/db.rs\n+x\n*** Update File: ${old}\n+SELECT 2;\n*** End Patch`
    expect(decideToolCall("patch", { patchText }, root)).toBeDefined()
    expect(decideToolCall("shell", { command: `sed -i s/1/2/ ${old}` }, root)).toBeDefined()
    expect(decideToolCall("shell", { command: "sed -i s/1/2/ 0001_init.sql", workdir: "migrations" }, root)).toBeDefined()
    expect(decideToolCall("shell", { command: `cat ${old}` }, root)).toBeUndefined()
    expect(decideToolCall("read", { path: old }, root)).toBeUndefined()
  })
})

describe("cargo install advisory", () => {
  test.each([
    "cargo install cargo-nextest",
    "cargo install --locked ripgrep",
    "echo ready; cargo install cargo-deny",
    "cargo +nightly install cargo-udeps",
    "sudo cargo install x",
  ])("fires: %s", (command) => {
    expect(runsCargoInstall(command)).toBe(true)
  })

  test.each([
    "cargo test",
    "cargo install --help",
    "echo cargo install ripgrep",
    'bd create --description "cargo install cargo-nextest"',
    'echo "cargo install cargo-nextest"',
  ])("holds: %s", (command) => {
    expect(runsCargoInstall(command)).toBe(false)
  })

  test("reads workflow run lines", () => {
    expect(workflowRunsCargoInstall("      - run: cargo install cargo-nextest")).toBe(true)
    expect(workflowRunsCargoInstall("        run: |\n          cargo install --locked just")).toBe(true)
    expect(workflowRunsCargoInstall("      - uses: taiki-e/install-action@v2\n        with:\n          tool: nextest")).toBe(
      false,
    )
  })
})

describe("advisoriesFor", () => {
  const CWD = "/repo"
  const HOME = "/home/me"
  const workflow = ".github/workflows/ci.yml"

  test("shell cargo install", () => {
    expect(advisoriesFor("shell", { command: "cargo install ripgrep" }, CWD, HOME)).toEqual(["cargo-install"])
  })

  test("workflow edits: cargo install and a RUSTFLAGS linker", () => {
    const content = 'env:\n  RUSTFLAGS: "-C link-arg=-fuse-ld=mold"\njobs:\n  t:\n    steps:\n      - run: cargo install just\n'
    expect(advisoriesFor("write", { path: workflow, content }, CWD, HOME)).toEqual(["cargo-install", "rustflags-linker"])
    expect(
      advisoriesFor("edit", { path: workflow, oldString: "a", newString: "RUSTFLAGS: -C linker=clang" }, CWD, HOME),
    ).toEqual(["rustflags-linker"])
    expect(advisoriesFor("write", { path: "src/RUSTFLAGS.md", content: "RUSTFLAGS linker" }, CWD, HOME)).toEqual([])
  })

  test("a patch is read per file from its added lines", () => {
    const patchText = [
      "*** Begin Patch",
      `*** Update File: ${workflow}`,
      "-      - run: cargo build",
      "+      - run: cargo install cargo-deny",
      "*** Update File: README.md",
      "+RUSTFLAGS linker",
      "*** End Patch",
    ].join("\n")
    expect(addedText("patch", { patchText }, CWD).get(`/repo/${workflow}`)).toBe("      - run: cargo install cargo-deny\n")
    expect(advisoriesFor("patch", { patchText }, CWD, HOME)).toEqual(["cargo-install"])
  })

  test("a global target directory in Cargo's home config or a shell profile", () => {
    const config = { path: `${HOME}/.cargo/config.toml`, content: '[build]\ntarget-dir = "/tmp/target"\n' }
    expect(advisoriesFor("write", config, CWD, HOME)).toEqual(["global-target-dir"])
    expect(advisoriesFor("write", { ...config, path: "/repo/.cargo/config.toml" }, CWD, HOME)).toEqual([])
    const profile = { path: `${HOME}/.zshrc`, oldString: "a", newString: "export CARGO_TARGET_DIR=~/target" }
    expect(advisoriesFor("edit", profile, CWD, HOME)).toEqual(["global-target-dir"])
    const append = { command: `echo 'export CARGO_TARGET_DIR=/tmp/t' >> ${HOME}/.zshrc` }
    expect(advisoriesFor("shell", append, CWD, HOME)).toEqual(["global-target-dir"])
    expect(advisoriesFor("shell", { command: "CARGO_TARGET_DIR=/tmp/t cargo build" }, CWD, HOME)).toEqual([])
  })
})

describe("plugin", () => {
  test("registers the gate, the advisory hook and the skills, and disposes them", async () => {
    const root = repo(["0001_init.sql", "0002_add.sql"])
    const fake = createFakeContext({ directory: root })
    const cleanup = await plugin.setup(fake.context)
    expect(fake.hooks("tool")).toEqual(["execute.before", "execute.after"])
    expect([...fake.skills.keys()].sort()).toEqual([...SKILL_NAMES].sort())
    for (const skill of fake.skills.values()) expect(String(skill.content)).not.toMatch(/skill:\/\/|rule:\/\/|rust_quality|TTSR/)

    await expect(
      fake.fire.tool("execute.before", { tool: "write", sessionID: "s", input: { path: "migrations/0001_init.sql" } }),
    ).rejects.toThrow("append-only")
    await fake.fire.tool("execute.before", { tool: "write", sessionID: "s", input: { path: "migrations/0002_add.sql" } })

    const event = (command: string) => ({
      tool: "shell",
      sessionID: "s",
      status: "completed",
      input: { command },
      result: { content: "ok" },
    })
    const first = await fake.fire.tool("execute.after", event("cargo install ripgrep"))
    expect(first.result.content).toBe(`ok\n${ADVISORIES["cargo-install"]}`)
    const again = await fake.fire.tool("execute.after", event("cargo install fd-find"))
    expect(again.result.content).toBe("ok")

    await cleanup?.()
    expect(fake.active()).toBe(0)
  })

  test("the built entry resolves the shipped skills from the package root", async () => {
    const built = (await import(join(import.meta.dir, "..", "index.js"))) as { SKILL_PATHS: string[] }
    expect(built.SKILL_PATHS[0]).toBe(join(import.meta.dir, "..", "skills", "rust-quality", "SKILL.md"))
    for (const path of built.SKILL_PATHS) expect(existsSync(path)).toBe(true)
  })
})
