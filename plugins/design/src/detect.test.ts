import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { isFrontendProject } from "./detect.ts"

const root = mkdtempSync(join(tmpdir(), "design-detect-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))
let count = 0

function project(files: Record<string, string>): string {
  const dir = join(root, String(++count))
  mkdirSync(dir)
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true })
    writeFileSync(join(dir, file), text)
  }
  return dir
}

describe("isFrontendProject", () => {
  test.each([
    ["React", { "package.json": '{"dependencies":{"react":"19"}}' }],
    ["Svelte dev dependency", { "package.json": '{"devDependencies":{"@sveltejs/kit":"2"}}' }],
    ["Storybook config", { ".storybook/main.ts": "" }],
    ["static site", { "index.html": "<html></html>" }],
    ["monorepo app", { "package.json": "{}", "apps/web/package.json": '{"dependencies":{"vue":"3"}}' }],
  ])("%s", (_, files) => {
    expect(isFrontendProject(project(files))).toBe(true)
  })

  test.each([
    ["empty", {}],
    ["Node service", { "package.json": '{"dependencies":{"express":"5"}}' }],
    ["Rust crate", { "Cargo.toml": "[package]" }],
  ])("not %s", (_, files) => {
    expect(isFrontendProject(project(files))).toBe(false)
  })
})
