import { afterAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { hasAny, MAX_MARKER_BYTES, packageDependencies, packageDirectories, readSmall } from "./project-markers.ts"

const root = mkdtempSync(join(tmpdir(), "markers-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

test("hasAny and readSmall", () => {
  writeFileSync(join(root, "a.txt"), "hi")
  writeFileSync(join(root, "big.txt"), "x".repeat(MAX_MARKER_BYTES + 1))
  expect(hasAny(root, ["nope", "a.txt"])).toBe(true)
  expect(hasAny(root, ["nope"])).toBe(false)
  expect(readSmall(join(root, "a.txt"))).toBe("hi")
  expect(readSmall(join(root, "big.txt"))).toBeUndefined()
  expect(readSmall(root)).toBeUndefined()
})

test("packageDependencies reads every dependency field and tolerates bad JSON", () => {
  const dir = join(root, "pkg")
  mkdirSync(dir)
  writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { a: "1" }, devDependencies: { b: "1" } }))
  expect(packageDependencies(dir)).toEqual(["a", "b"])
  writeFileSync(join(dir, "package.json"), "{")
  expect(packageDependencies(dir)).toEqual([])
  expect(packageDependencies(join(root, "missing"))).toEqual([])
})

test("packageDirectories finds workspace children one level deep", () => {
  const dir = join(root, "mono")
  mkdirSync(join(dir, "apps", "web"), { recursive: true })
  mkdirSync(join(dir, "packages", "empty"), { recursive: true })
  writeFileSync(join(dir, "apps", "web", "package.json"), "{}")
  expect(packageDirectories(dir)).toEqual([dir, join(dir, "apps", "web")])
})
