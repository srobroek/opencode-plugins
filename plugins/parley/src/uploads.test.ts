import { afterEach, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { removeUploads, saveUpload, uploadRoot } from "./uploads.ts"

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

test("uploads are written to a private directory as private files", () => {
  const dir = base()
  const target = saveUpload(file("key.txt"), "rnd_1", dir) ?? ""
  expect(readFileSync(target, "utf8")).toBe("secret")
  expect(mode(target)).toBe(0o600)
  expect(mode(path.dirname(target))).toBe(0o700)
  expect(mode(uploadRoot(dir))).toBe(0o700)
})

test("a root directory that already exists with wider permissions is tightened", () => {
  const dir = base()
  mkdirSync(uploadRoot(dir), { mode: 0o755 })
  chmodSync(uploadRoot(dir), 0o755)
  saveUpload(file("a.txt"), "rnd_1", dir)
  expect(mode(uploadRoot(dir))).toBe(0o700)
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

test("removing a round's uploads leaves other rounds' files", () => {
  const dir = base()
  const one = saveUpload(file("a.txt"), "rnd_1", dir) ?? ""
  const two = saveUpload(file("b.txt"), "rnd_2", dir) ?? ""
  removeUploads("rnd_1", dir)
  expect(existsSync(one)).toBe(false)
  expect(existsSync(two)).toBe(true)
  removeUploads("rnd_never_saved", dir)
})
