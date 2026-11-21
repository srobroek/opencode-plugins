import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { embeddedWriteTargets } from "../../beads/src/bd-embedded-write-lock.ts"
import { closeoutCommands, inClone } from "./landing-receipt.ts"

// A session pinned to the origin repository's embedded ledger hands a close-out command to the
// beads write gate. The command for another repository's landing has to pass that gate and land
// in the target's ledger, never the origin's.
let base = ""
let origin = ""
let target = ""

const embedded = (name: string): string => {
  const root = join(base, name)
  mkdirSync(join(root, ".beads"), { recursive: true })
  writeFileSync(join(root, ".beads", "metadata.json"), "{}")
  return root
}

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "in-clone-gate-")))
  origin = embedded("origin")
  target = embedded("target repo's clone")
})
afterAll(() => rmSync(base, { recursive: true, force: true }))

const oid = "b".repeat(40)

test.each(["update", "close"] as const)("the %s command for another repository's landing passes the beads gate and targets that repository's ledger", (which) => {
  const command = inClone(target, closeoutCommands("b-1", 7, oid, "/receipts/r.json")[which])
  const result = embeddedWriteTargets(command, origin, { BEADS_DIR: join(origin, ".beads") })
  expect(result).toEqual({ kind: "stores", stores: [join(target, ".beads")] })
})
