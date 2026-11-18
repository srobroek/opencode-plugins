import { Plugin } from "@opencode/plugin"
import { checkerBin, runChecker, verdict } from "./checker.ts"
import { parseCommand } from "./command.ts"
import { createRootResolver } from "./root.ts"

export const ID = "srobroek.pace-lock"
/** Tools that only read; they never reach a customer account. */
const READ_ONLY = new Set(["read", "grep", "glob", "list"])
/** A prefilter that cannot be read matches everything, so the checker decides. */
const MATCH_ALL = /[\s\S]/

type Context = Plugin.Context

export async function setupPaceLock(ctx: Context, options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}) {
  const env = options.env ?? process.env
  const bin = checkerBin(env)
  const autoBind = env.PACE_LOCK?.trim() || undefined
  const roots = createRootResolver(async (input) => (await ctx.session.get(input as never)) as never)
  const harness = ["--harness", "opencode"]

  let prefilter: Promise<RegExp> | undefined
  const loadPrefilter = (): Promise<RegExp> => {
    prefilter ??= runChecker(bin, ["prefilter"], { timeoutMs: 5000 }).then((run) => {
      if (run.code !== 0 || run.failed || run.stdout.trim() === "") return MATCH_ALL
      try {
        return new RegExp(run.stdout.trim())
      } catch {
        return MATCH_ALL
      }
    })
    return prefilter
  }

  const bindings = new Map<string, Promise<void>>()
  /** Bind a root to `PACE_LOCK` once, whichever of the event or the first tool call arrives first. */
  const ensureAutoBound = (root: string): Promise<void> => {
    if (autoBind === undefined) return Promise.resolve()
    let bound = bindings.get(root)
    if (bound === undefined) {
      bound = runChecker(bin, ["bind", ...harness, "--root", root, autoBind]).then((run) => {
        if (run.code !== 0) console.error(`${ID}: PACE_LOCK=${autoBind} did not bind ${root}: ${run.stderr.trim() || "checker failed"}`)
      })
      bindings.set(root, bound)
    }
    return bound
  }

  const say = (sessionID: string, text: string) =>
    ctx.session.synthetic({ sessionID, text, description: "PACE lock", resume: false } as never)

  const execute = async (input: { sessionID: string; prompt: { text?: string } }) => {
    const command = parseCommand(input.prompt.text)
    if (command.kind === "invalid") return void (await say(input.sessionID, command.reason))
    const root = await roots.resolve(input.sessionID)
    if (root === undefined) return void (await say(input.sessionID, "PACE lock: cannot resolve this session's root, so nothing was changed."))
    if (command.kind === "bind") {
      const run = await runChecker(bin, ["bind", ...harness, "--root", root, command.customer])
      if (run.code !== 0) return void (await say(input.sessionID, `PACE lock refused: ${run.stderr.trim() || "the checker failed"}`))
      let line = `PACE lock: bound to ${command.customer}.`
      try {
        const bound = JSON.parse(run.stdout) as { account?: string; region?: string; expires_at?: string }
        line = `PACE lock: bound to ${command.customer} (account ${bound.account ?? "?"}, ${bound.region ?? "?"}), expires ${bound.expires_at ?? "?"}. Every other customer is blocked.`
      } catch {}
      return void (await say(input.sessionID, line))
    }
    const run = await runChecker(bin, [command.kind, ...harness, "--root", root])
    const out = run.code === 0 ? run.stdout.trim() : `PACE lock: ${run.stderr.trim() || "the checker failed"}`
    await say(input.sessionID, command.kind === "off" && run.code === 0 ? `PACE lock: closed. ${out}`.trim() : out)
  }

  const registrations: Array<{ dispose: () => Promise<void> }> = []
  registrations.push(
    await ctx.command.transform((editor) =>
      editor.add({ name: "pace", description: "bind this session to a PACE customer: <customer> | off | (status)", execute: execute as never }),
    ),
  )

  registrations.push(
    await ctx.tool.hook("execute.before", async (event) => {
      if (READ_ONLY.has(event.tool)) return
      const root = await roots.resolve(event.sessionID)
      const serialized = JSON.stringify(event.input ?? null) ?? "null"
      if (root === undefined) {
        // Fail closed: without a root, no binding can be consulted.
        if ((await loadPrefilter()).test(serialized))
          throw new Error("PACE lock: cannot resolve this session's root, so the call is blocked.")
        return
      }
      await ensureAutoBound(root)
      if (!(await loadPrefilter()).test(serialized)) return
      const run = await runChecker(bin, ["check", ...harness, "--root", root, "--tool", event.tool], { stdin: serialized, timeoutMs: options.timeoutMs })
      const result = verdict(run)
      if (!result.allow) throw new Error(result.reason)
    }),
  )

  const controller = new AbortController()
  void (async () => {
    for await (const raw of ctx.event.subscribe({ types: ["session.created"], signal: controller.signal } as never)) {
      if (controller.signal.aborted) break
      const data = (raw as { data?: { sessionID?: unknown; parentID?: unknown } }).data
      if (typeof data?.sessionID !== "string") continue
      if (data.parentID) {
        void roots.resolve(data.sessionID)
        continue
      }
      roots.markRoot(data.sessionID)
      void ensureAutoBound(data.sessionID)
    }
  })().catch((error) => console.error(`${ID}: event stream ended`, error))

  return async () => {
    controller.abort()
    for (const registration of registrations.reverse()) await registration.dispose()
  }
}

export default Plugin.define({ id: ID, setup: (ctx) => setupPaceLock(ctx) })
