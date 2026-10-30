import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type Group, gitCachePath } from "./source.ts"
import { projectFileDigest, treeDigest } from "./trust.ts"

test("S1: trust fingerprints all source contents, including git metadata, and refuses unverified sources", () => {
  const base = join(tmpdir(), "opencode")
  mkdirSync(base, { recursive: true })
  const root = mkdtempSync(join(base, "claude-trust-"))
  const cacheBefore = process.env.XDG_CACHE_HOME
  try {
    mkdirSync(join(root, "source", ".git"), { recursive: true })
    writeFileSync(join(root, "source", "agent.md"), "first")
    writeFileSync(join(root, "source", ".git", "config"), "first")
    const group: Group = { origin: "project", projectFile: { path: join(root, "config"), text: "config" }, sources: [{ path: "./source" }] }
    const first = projectFileDigest(group, root)
    writeFileSync(join(root, "source", ".git", "config"), "changed")
    expect(projectFileDigest(group, root)).not.toBe(first)
    expect(() => treeDigest(join(root, "source"), { files: 1, bytes: 1000 })).toThrow("too large to verify")
    expect(() => treeDigest(join(root, "source"), { files: 1000, bytes: 1 })).toThrow("too large to verify")
    expect(() => projectFileDigest({ ...group, sources: [{ path: "./missing" }] }, root)).toThrow()
    expect(() => projectFileDigest({ ...group, sources: [{ git: "https://example.invalid/repo", ref: "main" }] }, root)).toThrow("full commit SHA")
    // Cached git contents are part of the approval, not just a supposedly immutable URL/ref.
    process.env.XDG_CACHE_HOME = join(root, "cache")
    const source = { git: "https://example.invalid/repo", ref: "a".repeat(40) }
    const gitGroup = { ...group, sources: [source] }
    const pinned = projectFileDigest(gitGroup, root)
    const cached = gitCachePath(source)
    mkdirSync(cached, { recursive: true })
    writeFileSync(join(cached, "hook.sh"), "echo trusted")
    const populated = projectFileDigest(gitGroup, root)
    expect(populated).not.toBe(pinned)
    writeFileSync(join(cached, "hook.sh"), "echo changed")
    expect(projectFileDigest(gitGroup, root)).not.toBe(populated)
  } finally {
    if (cacheBefore === undefined) delete process.env.XDG_CACHE_HOME
    else process.env.XDG_CACHE_HOME = cacheBefore
    rmSync(root, { recursive: true, force: true })
  }
})
