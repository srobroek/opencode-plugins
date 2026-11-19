import { afterEach, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { CLOSED_MARKER, markClosed, readUpload, removeUpload, saveUpload, sweepUploads, UNMARKED_TTL_MS, UPLOAD_TTL_MS, uploadRoot } from "./uploads.ts"

const bases: string[] = []
const base = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "parley-uploads-"))
  bases.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of bases.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const file = (name: string, text = "secret") => ({ name, mime: "text/plain", size: text.length, data: Buffer.from(text).toString("base64") })
const mode = (target: string) => statSync(target).mode & 0o777

test("uploads are written as private files in private directories", () => {
  const dir = base()
  const target = saveUpload(file("key.txt"), "rnd_1", dir) ?? ""
  expect(readFileSync(target, "utf8")).toBe("secret")
  expect(mode(target)).toBe(0o600)
  for (let at = path.dirname(target); at.startsWith(uploadRoot(dir)); at = path.dirname(at)) expect(mode(at)).toBe(0o700)
})

test("a root directory that already exists with wider permissions is tightened", () => {
  const dir = base()
  mkdirSync(uploadRoot(dir), { mode: 0o755 })
  chmodSync(uploadRoot(dir), 0o755) // check-test-executables: directory permission, not a script
  saveUpload(file("a.txt"), "rnd_1", dir)
  expect(mode(uploadRoot(dir))).toBe(0o700)
})

test("two uploads with the same name in one round keep both files and their names", () => {
  const dir = base()
  const first = saveUpload(file("shot.png", "one"), "rnd_1", dir) ?? ""
  const second = saveUpload(file("nested/shot.png", "two"), "rnd_1", dir) ?? ""
  expect(first).not.toBe(second)
  expect(path.basename(first)).toBe("shot.png")
  expect(path.basename(second)).toBe("shot.png")
  expect(readFileSync(first, "utf8")).toBe("one")
  expect(readFileSync(second, "utf8")).toBe("two")
})

test("an upload with no contents writes nothing", () => {
  expect(saveUpload({ name: "a", mime: "text/plain", size: 0 }, "rnd_1", base())).toBeUndefined()
})

test("a file or round name cannot escape the upload root", () => {
  const dir = base()
  const target = saveUpload(file("../../evil.txt"), "../../round", dir) ?? ""
  expect(target.startsWith(uploadRoot(dir) + path.sep)).toBe(true)
  expect(path.basename(target)).toBe("evil.txt")
})

test("a round's files stay until 24 hours after it closed, then go; other rounds' files stay", () => {
  const dir = base()
  const closed = saveUpload(file("a.txt"), "rnd_1", dir) ?? ""
  const open = saveUpload(file("b.txt"), "rnd_2", dir) ?? ""
  markClosed("rnd_1", 1_000, dir)
  markClosed("rnd_1", 9_999_999, dir)
  expect(readFileSync(path.join(uploadRoot(dir), "rnd_1", CLOSED_MARKER), "utf8")).toBe("1000")
  sweepUploads(1_000 + UPLOAD_TTL_MS, dir)
  expect(existsSync(closed)).toBe(true)
  sweepUploads(1_000 + UPLOAD_TTL_MS + 1, dir)
  expect(existsSync(closed)).toBe(false)
  expect(existsSync(open)).toBe(true)
})

test("a round directory never marked closed goes once untouched for 48 hours", () => {
  const dir = base()
  const target = saveUpload(file("a.txt"), "rnd_1", dir) ?? ""
  const roundDir = path.join(uploadRoot(dir), "rnd_1")
  const touched = Date.now()
  utimesSync(roundDir, touched / 1000, touched / 1000)
  sweepUploads(touched + UNMARKED_TTL_MS - 1000, dir)
  expect(existsSync(target)).toBe(true)
  sweepUploads(touched + UNMARKED_TTL_MS + 1000, dir)
  expect(existsSync(target)).toBe(false)
})

test("marking a round without uploads creates nothing, and sweeping a missing root does nothing", () => {
  const dir = base()
  markClosed("rnd_none", 1, dir)
  expect(existsSync(path.join(uploadRoot(dir), "rnd_none"))).toBe(false)
  sweepUploads(Date.now(), dir)
})

test("a private copy reads back as base64; paths outside the upload root and missing copies read as nothing", () => {
  const dir = base()
  const copy = saveUpload(file("a.txt", "hello"), "rnd_1", dir) ?? ""
  expect(readUpload(copy, dir)).toBe(Buffer.from("hello").toString("base64"))
  expect(readUpload(path.join(dir, "elsewhere.txt"), dir)).toBeUndefined()
  expect(readUpload(path.join(uploadRoot(dir), "..", "escape.txt"), dir)).toBeUndefined()
  rmSync(path.dirname(copy), { recursive: true })
  expect(readUpload(copy, dir)).toBeUndefined()
})

test("removing one copy removes its own directory only, and nothing outside the upload root", () => {
  const dir = base()
  const one = saveUpload(file("a.txt"), "rnd_1", dir) ?? ""
  const two = saveUpload(file("a.txt"), "rnd_1", dir) ?? ""
  removeUpload(one, dir)
  expect(existsSync(one)).toBe(false)
  expect(existsSync(two)).toBe(true)
  const outside = path.join(dir, "keep.txt")
  writeFileSync(outside, "x")
  removeUpload(outside, dir)
  removeUpload(path.join(uploadRoot(dir), "rnd_1", "loose.txt"), dir)
  expect(existsSync(outside)).toBe(true)
  expect(existsSync(two)).toBe(true)
})
