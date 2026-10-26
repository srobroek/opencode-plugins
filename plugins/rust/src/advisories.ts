/**
 * Advisories appended to a completed tool result. Ported from the omp-plugins rust
 * rules `rust-cargo-install-advisory` and `rust-rustflags-linker`, plus a check for a
 * global Cargo target directory.
 */

import { homedir } from "node:os"
import { basename } from "node:path"
import { parse, parsedInvocations } from "@srobroek/opencode-lib/shell-command"
import { lexicalAbs } from "@srobroek/opencode-lib/shell-write-targets"
import { patchTargets, shellCall, writeTargets, writtenPaths } from "@srobroek/opencode-lib/tool-targets"

export type AdvisoryId = "cargo-install" | "rustflags-linker" | "global-target-dir"

export const ADVISORIES: Record<AdvisoryId, string> = {
  "cargo-install": [
    "[rust] `cargo install` builds the tool from source. In CI that is a full compile on every run, before",
    "your own build starts, and `Swatinem/rust-cache` does not cover it. In CI, install a prebuilt binary:",
    "`taiki-e/install-action` covers the common tools (`cargo-nextest`, `cargo-llvm-cov`, `cargo-deny`,",
    "`cargo-machete`, `cargo-audit`); `cargo binstall` covers the rest. Locally, try `cargo binstall <tool>`",
    "first and fall back to `cargo install --locked <tool>` only when the crate publishes no prebuilt artifact.",
  ].join("\n"),
  "rustflags-linker": [
    "[rust] `Swatinem/rust-cache` hashes `RUSTFLAGS` into its cache key, so a linker flag there changes the",
    "key for every job that inherits the variable: the cache misses and the whole dependency graph rebuilds.",
    "Set the linker per target in `.cargo/config.toml` instead, for example",
    '`[target.x86_64-unknown-linux-gnu] rustflags = ["-C", "link-arg=-fuse-ld=mold"]` or',
    '`[target.x86_64-pc-windows-msvc] linker = "rust-lld.exe"`. A `[target.*]` table applies only where it',
    "matches and is not part of the cache key. Reach for `mold` or `sccache` only once a measurement shows",
    "link time still dominates. The rust-ci skill has the rest of the CI defaults.",
  ].join("\n"),
  "global-target-dir": [
    "[rust] A global Cargo target directory (`build.target-dir` in `~/.cargo/config.toml`, or",
    "`CARGO_TARGET_DIR` exported from a shell profile) makes every project and worktree share one `target/`.",
    "Cargo holds a lock on it, so parallel builds in different checkouts wait on each other, and differing",
    "features or toolchains evict each other's artifacts. Keep the target directory per project or per",
    "worktree; set it in the project's `.cargo/config.toml` or per worktree when you need it elsewhere.",
  ].join("\n"),
}

const RUSTFLAGS_LINKER = /RUSTFLAGS[^\n]{0,60}(?:linker|link-arg)/
const TARGET_DIR_SETTING = /^\s*target-dir\s*=/m
const TARGET_DIR_EXPORT = /\bCARGO_TARGET_DIR\s*=/
const SHELL_PROFILES = new Set([
  ".profile",
  ".bash_profile",
  ".bashrc",
  ".zshrc",
  ".zshenv",
  ".zprofile",
  "config.fish",
  "env.fish",
])

/** Whether a shell command runs `cargo install` (not `cargo install --help`). */
export function runsCargoInstall(command: string): boolean {
  return parsedInvocations(parse(command), "cargo").some(({ args }) => {
    const verb = args.find((word) => !word.startsWith("-") && !word.startsWith("+"))
    return verb === "install" && !args.includes("--help") && !args.includes("-h")
  })
}

/** Whether a line of workflow YAML runs `cargo install`, after its `run:` key or list marker. */
export function workflowRunsCargoInstall(text: string): boolean {
  return text
    .split("\n")
    .some((line) => runsCargoInstall(line.replace(/^\s*(?:-\s*)?(?:run:\s*[|>]?[-+]?)?\s*/, "")))
}

export function isWorkflow(path: string): boolean {
  return /\/\.github\/workflows\/[^/]+\.ya?ml$/.test(path)
}

export function isCargoHomeConfig(path: string, home = homedir(), cargoHome = process.env.CARGO_HOME): boolean {
  const dirs = [lexicalAbs(".cargo", home), ...(cargoHome ? [lexicalAbs(cargoHome, home)] : [])]
  return dirs.some((dir) => path === `${dir}/config.toml` || path === `${dir}/config`)
}

export function isShellProfile(path: string, home = homedir()): boolean {
  return path.startsWith(`${home}/`) && SHELL_PROFILES.has(basename(path))
}

/** The text a write tool call adds, per absolute target path: `newString`, `content`, or a patch's `+` lines. */
export function addedText(tool: string, input: unknown, cwd: string): Map<string, string> {
  const out = new Map<string, string>()
  const fields = (input ?? {}) as Record<string, unknown>
  if (tool === "edit" || tool === "write") {
    const text = tool === "edit" ? fields.newString : fields.content
    const path = writeTargets(tool, input)[0]
    if (path !== undefined && typeof text === "string") out.set(lexicalAbs(path, cwd), text)
    return out
  }
  if (tool !== "patch" || typeof fields.patchText !== "string") return out
  let current: string | undefined
  for (const line of fields.patchText.split("\n")) {
    const header = patchTargets(line)[0]
    if (header) {
      current = header.operation === "delete" ? undefined : lexicalAbs(header.path, cwd)
      continue
    }
    if (current === undefined || !line.startsWith("+")) continue
    out.set(current, `${out.get(current) ?? ""}${line.slice(1)}\n`)
  }
  return out
}

/** The advisories a completed tool call earns, in a stable order. */
export function advisoriesFor(tool: string, input: unknown, cwd: string, home = homedir()): AdvisoryId[] {
  const found = new Set<AdvisoryId>()
  const shell = shellCall(tool, input)
  if (shell) {
    if (runsCargoInstall(shell.command)) found.add("cargo-install")
    const writesConfig = writtenPaths(tool, input, cwd).some(
      (path) => isCargoHomeConfig(path, home) || isShellProfile(path, home),
    )
    if (writesConfig && (TARGET_DIR_EXPORT.test(shell.command) || /\btarget-dir\s*=/.test(shell.command)))
      found.add("global-target-dir")
  }
  for (const [path, text] of addedText(tool, input, cwd)) {
    if (isWorkflow(path)) {
      if (workflowRunsCargoInstall(text)) found.add("cargo-install")
      if (RUSTFLAGS_LINKER.test(text)) found.add("rustflags-linker")
    }
    if (isCargoHomeConfig(path, home) && TARGET_DIR_SETTING.test(text)) found.add("global-target-dir")
    if (isShellProfile(path, home) && TARGET_DIR_EXPORT.test(text)) found.add("global-target-dir")
  }
  return (Object.keys(ADVISORIES) as AdvisoryId[]).filter((id) => found.has(id))
}
