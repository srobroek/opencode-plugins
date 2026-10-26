import { existsSync } from "node:fs"
import { Plugin } from "@opencode/plugin"
import { appendResultText } from "@srobroek/opencode-lib/shell-result"
import { errorLines, type FileErrors, formatReport, newErrors, toolText, touchedFiles, within } from "./diagnostics.ts"

export { diagnosticKey, errorLines, formatReport, newErrors, toolText, touchedFiles, within } from "./diagnostics.ts"

/** lsp-tools-mcp's `diagnostics` tool under the MCP server name `lsp`. */
export const DEFAULT_TOOL = "lsp_diagnostics"
export const DEFAULT_TIMEOUT_MS = 8000
export const DEFAULT_MAX_LINES = 20
const MAX_FILES = 10
const MAX_BASELINES = 2000

type CallContext = { sessionID: string; agent: string; messageID: string; id: string }
type Execute = (input: unknown, context: unknown) => Promise<unknown>

function positive(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback
}

export default Plugin.define({
  id: "srobroek.lsp",
  async setup(ctx) {
    const toolName = typeof ctx.options.tool === "string" && ctx.options.tool ? ctx.options.tool : DEFAULT_TOOL
    const timeout = positive(ctx.options.timeout, DEFAULT_TIMEOUT_MS)
    const maxLines = positive(ctx.options.maxLines, DEFAULT_MAX_LINES)
    const baselineBefore = ctx.options.baseline !== false
    const directory = ctx.location.directory
    // Errors last seen per session and file; the next check reports only what is new.
    const baselines = new Map<string, string[]>()

    const remember = (key: string, errors: string[]) => {
      baselines.delete(key)
      baselines.set(key, errors)
      if (baselines.size > MAX_BASELINES) baselines.delete(baselines.keys().next().value as string)
    }

    const diagnosticsTool = async (): Promise<Execute | undefined> => {
      const tools = await ctx.tool.list().catch(() => [])
      return tools.find((tool) => tool.id === toolName)?.execute as Execute | undefined
    }

    /** Error lines per file, or `undefined` for a file whose check failed or ran out of time. */
    const check = async (call: CallContext, files: readonly string[]) => {
      const execute = await diagnosticsTool()
      if (execute === undefined) return undefined
      const controller = new AbortController()
      const context = { ...call, signal: controller.signal, progress: async () => {} }
      return within(
        timeout,
        controller,
        Promise.all(
          files.map((path) =>
            execute({ filePath: path, severity: "error" }, context).then(
              (result) => errorLines(toolText(result)),
              () => undefined,
            ),
          ),
        ),
      )
    }

    const key = (sessionID: string, path: string) => `${sessionID}\0${path}`

    const before = await ctx.tool.hook("execute.before", async (event) => {
      if (!baselineBefore) return
      const files = touchedFiles(event.tool, event.input, directory)
        .filter((path) => !baselines.has(key(event.sessionID, path)))
        .slice(0, MAX_FILES)
      const existing = files.filter((path) => existsSync(path))
      for (const path of files) if (!existing.includes(path)) remember(key(event.sessionID, path), [])
      if (existing.length === 0) return
      const errors = await check(event, existing)
      if (errors === undefined) return
      existing.forEach((path, i) => {
        const found = errors[i]
        if (found !== undefined) remember(key(event.sessionID, path), found)
      })
    })

    const after = await ctx.tool.hook("execute.after", async (event) => {
      if (event.status !== "completed") return
      const files = touchedFiles(event.tool, event.input, directory)
        .filter((path) => existsSync(path))
        .slice(0, MAX_FILES)
      if (files.length === 0) return
      const errors = await check(event, files)
      if (errors === undefined) return
      const report: FileErrors[] = []
      files.forEach((path, i) => {
        const current = errors[i]
        if (current === undefined) return
        const id = key(event.sessionID, path)
        report.push({ path, errors: newErrors(baselines.get(id), current) })
        remember(id, current)
      })
      const text = formatReport(report, directory, maxLines)
      if (text !== "") event.result = appendResultText(event.result, text)
    })

    return async () => {
      await after.dispose()
      await before.dispose()
      baselines.clear()
    }
  },
})
