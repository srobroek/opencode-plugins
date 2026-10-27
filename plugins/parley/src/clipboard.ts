import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createHostClipboard } from "@opentui/core"
import type { FileValue } from "./answers.ts"
import { mimeFor } from "./tui-state.ts"

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/tiff"] as const

export interface ClipboardWriter {
  copyToClipboardOSC52(text: string): boolean
}

export function clipboardCommands(platform: string): string[][] {
  return platform === "darwin" ? [["pbcopy"]] : platform === "linux" ? [["wl-copy"], ["xclip", "-selection", "clipboard"]] : []
}

async function systemCopy(text: string, signal?: AbortSignal): Promise<boolean> {
  for (const command of clipboardCommands(process.platform)) {
    if (signal?.aborted) return false
    if (!Bun.which(command[0] ?? "")) continue
    try {
      const proc = Bun.spawn(command, { stdin: new TextEncoder().encode(text), stdout: "ignore", stderr: "ignore" })
      const kill = () => { proc.kill() }
      signal?.addEventListener("abort", kill, { once: true })
      const timeout = setTimeout(kill, 1500)
      try {
        if ((await proc.exited) === 0) return true
      } finally {
        clearTimeout(timeout)
        signal?.removeEventListener("abort", kill)
      }
    } catch { /* Try the next installed backend. */ }
  }
  return false
}

/** OSC 52 first (including remote terminals); bounded local commands when unsupported. */
export async function copyText(
  text: string,
  terminal: ClipboardWriter,
  signal?: AbortSignal,
  fallback: (text: string, signal?: AbortSignal) => Promise<boolean> = systemCopy,
): Promise<boolean> {
  if (signal?.aborted) return false
  try {
    if (terminal.copyToClipboardOSC52(text)) return true
  } catch { /* Host/terminal does not support OSC 52. */ }
  return fallback(text, signal)
}

/** Paths from a `text/uri-list` or a pasted list of `file://` URLs. */
export function fileURLs(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("file://"))
    .map((line) => decodeURIComponent(new URL(line).pathname))
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)

async function hostRead(types: readonly [string, ...string[]]) {
  const clipboard = createHostClipboard({ timeoutMs: 3000 })
  try {
    const result = await clipboard.read({ preferredTypes: types })
    return result.status === "read" ? result.representation : undefined
  } catch {
    return undefined
  } finally {
    await clipboard.dispose().catch(() => {})
  }
}

/** macOS fallback when the native clipboard service is unavailable: AppleScript writes the PNG to a temp file. */
async function osascriptImage(): Promise<Uint8Array | undefined> {
  if (process.platform !== "darwin") return undefined
  const dir = mkdtempSync(path.join(tmpdir(), "parley-paste-"))
  const target = path.join(dir, "clipboard.png")
  const script = `set f to open for access POSIX file "${target}" with write permission
write (the clipboard as «class PNGf») to f
close access f`
  try {
    const proc = Bun.spawn(["osascript", "-e", script], { stdout: "ignore", stderr: "ignore" })
    if ((await proc.exited) !== 0) return undefined
    const bytes = readFileSync(target)
    return bytes.length > 0 ? new Uint8Array(bytes) : undefined
  } catch {
    return undefined
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Files on the system clipboard: an image (a screenshot) or files copied in a file manager.
 * Text is left to the terminal's own paste. Returns an empty list when there is nothing to attach.
 */
export async function clipboardFiles(images: boolean): Promise<FileValue[]> {
  const image = (await hostRead(IMAGE_TYPES)) ?? undefined
  if (image) {
    const ext = image.mimeType.split("/")[1] ?? "png"
    const data = Buffer.from(image.bytes).toString("base64")
    return [{ name: `clipboard-${stamp()}.${ext}`, mime: image.mimeType, size: image.bytes.length, data }]
  }
  const list = await hostRead(["text/uri-list"])
  if (list) {
    const paths = fileURLs(new TextDecoder().decode(list.bytes))
    const files: FileValue[] = []
    for (const file of paths) {
      const handle = Bun.file(file)
      if (!(await handle.exists())) continue
      const mime = (handle.type || mimeFor(file)).split(";")[0] ?? mimeFor(file)
      if (images && !mime.startsWith("image/")) continue
      const data = Buffer.from(await handle.arrayBuffer()).toString("base64")
      files.push({ name: path.basename(file), path: file, mime, size: handle.size, data })
    }
    if (files.length > 0) return files
  }
  const png = await osascriptImage()
  if (png) return [{ name: `clipboard-${stamp()}.png`, mime: "image/png", size: png.length, data: Buffer.from(png).toString("base64") }]
  return []
}
