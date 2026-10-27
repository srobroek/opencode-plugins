import { expect, test } from "bun:test"
import { clipboardCommands, copyText } from "./clipboard.ts"
import { cardText } from "./copy-text.ts"
import type { Question } from "./questions.ts"
import { initialDraft, keyHints, setText } from "./tui-state.ts"

test("copies the current edited code, body and note as plain text", () => {
  const question: Question = { id: "code", title: "Snippet", kind: "ask_code", body: "Write it", recommended: "old()" }
  const draft = setText(question, initialDraft(question), "new()")
  draft.note = "Keep this"
  expect(cardText(question, draft)).toBe("Snippet\n\nWrite it\n\nAnswer:\nnew()\n\nNote:\nKeep this")
})

test("copies review sections and a diff without terminal formatting", () => {
  const question: Question = { id: "diff", title: "Change", kind: "show_diff", diff: "- old\n+ new", sections: [{ id: "s", title: "Context", content: "Details" }] }
  expect(cardText(question, initialDraft(question))).toBe("Change\n\nContext\nDetails\n\n- old\n+ new")
})

test("copies choice labels and file names, never attachment bytes", () => {
  const question: Question = { id: "one", title: "Pick", kind: "pick_one", options: [{ id: "a", label: "Alpha" }], recommended: "a" }
  expect(cardText(question, initialDraft(question))).toContain("Answer:\nAlpha")
  const files: Question = { id: "files", title: "Upload", kind: "ask_file" }
  const draft = initialDraft(files)
  draft.value = { files: [{ name: "secret.txt", path: "docs/secret.txt", data: "do-not-copy" }] }
  expect(cardText(files, draft)).toBe("Upload\n\nAnswer:\ndocs/secret.txt")
})

test("copy hints apply to card/panel but not a text editor", () => {
  expect(keyHints(undefined, "card")).toContain("y copy")
  expect(keyHints(undefined, "panel")).toContain("y copy")
  expect(keyHints(undefined, "card", { field: "text", enterSaves: true })).not.toContain("y copy")
})

test("OSC 52 succeeds without invoking the local fallback", async () => {
  let received = ""
  let local = false
  expect(await copyText("héllo", { copyToClipboardOSC52: (text) => { received = text; return true } }, undefined, async () => { local = true; return true })).toBe(true)
  expect(received).toBe("héllo")
  expect(local).toBe(false)
})

test("unsupported or failing OSC 52 uses the fallback and reports unavailable", async () => {
  const fallback = async (text: string) => text === "text"
  expect(await copyText("text", { copyToClipboardOSC52: () => false }, undefined, fallback)).toBe(true)
  expect(await copyText("text", { copyToClipboardOSC52: () => { throw new Error("closed") } }, undefined, fallback)).toBe(true)
  expect(await copyText("other", { copyToClipboardOSC52: () => false }, undefined, fallback)).toBe(false)
})

test("disposed controls cannot write to the clipboard", async () => {
  const abort = new AbortController()
  abort.abort()
  expect(await copyText("text", { copyToClipboardOSC52: () => { throw new Error("must not write") } }, abort.signal, async () => { throw new Error("must not spawn") })).toBe(false)
})

test("local backends prefer native macOS or Wayland then X11", () => {
  expect(clipboardCommands("darwin")).toEqual([["pbcopy"]])
  expect(clipboardCommands("linux")).toEqual([["wl-copy"], ["xclip", "-selection", "clipboard"]])
  expect(clipboardCommands("win32")).toEqual([])
})
