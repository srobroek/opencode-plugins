import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cloneRegistryDirectory, registryFiles } from "./clone-registry.ts"

let root = ""
const environment = (): NodeJS.ProcessEnv => ({ HOME: process.env.HOME ?? "", DELIVERY_RECEIPTS_DIR: root })

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "clone-registry-"))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

test("an absent registry directory has no files", () => {
  expect(registryFiles(environment())).toEqual([])
})

test("only the .json files of the registry directory are listed", () => {
  const directory = cloneRegistryDirectory(environment())
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, "a.json"), "{}")
  writeFileSync(join(directory, "a.json.tmp"), "{}")
  expect(registryFiles(environment())).toEqual([join(directory, "a.json")])
})

test("a registry directory that cannot be listed is an error with its cause, not an empty list", () => {
  const directory = cloneRegistryDirectory(environment())
  // `.clones` is a file, so listing it fails with ENOTDIR rather than ENOENT.
  writeFileSync(directory, "not a directory")
  let caught: unknown
  try {
    registryFiles(environment())
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(Error)
  expect((caught as Error).message).toContain(directory)
  expect(((caught as Error).cause as NodeJS.ErrnoException).code).toBe("ENOTDIR")
})
