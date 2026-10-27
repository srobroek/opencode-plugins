import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { createFakeContext } from "@srobroek/opencode-lib/testing"
import { ADVISORIES, addedText, advisoriesFor, runsCargoInstall, workflowRunsCargoInstall } from "./advisories.ts"
import plugin, { SKILL_NAMES } from "./index.ts"

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
  test("registers the advisory hook and the skills, and disposes them", async () => {
    const fake = createFakeContext({ directory: "/repo" })
    const cleanup = await plugin.setup(fake.context)
    expect(fake.hooks("tool")).toEqual(["execute.after"])
    expect([...fake.skills.keys()].sort()).toEqual([...SKILL_NAMES].sort())
    for (const skill of fake.skills.values()) expect(String(skill.content)).not.toMatch(/skill:\/\/|rule:\/\/|rust_quality|TTSR/)

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
