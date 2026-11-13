import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { configuredStore } from "./beads-store.ts"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture() {
  // realpath: macOS hands out /var/folders/..., a symlink to /private/var/folders/...
  const root = mkdtempSync(join(realpathSync(tmpdir()), "beads-store-"))
  roots.push(root)
  mkdirSync(join(root, "ledger"))
  return root
}

test.each(["metadata.json", "embeddeddolt"])("resolves and canonicalizes a store with %s", (marker) => {
  const root = fixture()
  if (marker === "metadata.json") writeFileSync(join(root, "ledger", marker), "{}")
  else mkdirSync(join(root, "ledger", marker))
  symlinkSync(join(root, "ledger"), join(root, "alias"))
  expect(configuredStore({ store: "alias" }, root)).toBe(join(root, "ledger"))
})

test.each(["missing", "ledger", "", 42, null])("refuses an invalid configured store %j", (store) => {
  expect(() => configuredStore({ store }, fixture())).toThrow(/Invalid beads store option.*metadata.json.*embeddeddolt/)
})

test("an absent option leaves existing store discovery unchanged", () => {
  expect(configuredStore({}, fixture())).toBeUndefined()
})
