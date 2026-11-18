import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { bannerText, parseState, readState, stateFile } from "./state.ts"
import { rootOf } from "./tui-root.ts"

let dir: string
let env: NodeJS.ProcessEnv
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pace-lock-state-"))
  env = { PACE_LOCK_STATE_DIR: dir }
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

test("a bound state file renders the banner row", () => {
  writeFileSync(stateFile("ses_root", env), JSON.stringify({ state: "bound", customer: "acme", account: "111122223333" }))
  expect(bannerText(readState("ses_root", env))).toBe("⚠ PACE: acme (111122223333) ⚠")
})

test.each([
  ["no file", undefined],
  ["unbound", '{"state":"unbound"}'],
  ["expired", '{"state":"expired","customer":"acme"}'],
  ["closed", '{"state":"closed","customer":"acme"}'],
  ["garbage", "not json"],
])("%s shows no banner", (_name, content) => {
  if (content !== undefined) writeFileSync(stateFile("ses_root", env), content)
  expect(bannerText(readState("ses_root", env))).toBeUndefined()
})

test("a state without an account omits the parentheses", () => {
  expect(bannerText(parseState('{"state":"bound","customer":"acme"}'))).toBe("⚠ PACE: acme ⚠")
})

test("the TUI finds the root through parentID", () => {
  const sessions: Record<string, { parentID?: string }> = { c: { parentID: "b" }, b: { parentID: "a" }, a: {} }
  expect(rootOf((id) => sessions[id], "c")).toBe("a")
  expect(rootOf((id) => sessions[id], "a")).toBe("a")
})
