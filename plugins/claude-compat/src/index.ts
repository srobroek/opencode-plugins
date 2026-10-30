import { Plugin } from "@opencode/plugin"
import type { Context } from "@opencode/plugin/promise/plugin"
import { type AgentPermission, registerAgentFiles } from "@srobroek/opencode-lib/agent-files"
import { locationDirectories, parseMcpOptions, registerMcp } from "@srobroek/opencode-lib/mcp"
import { appendResultText, resultText } from "@srobroek/opencode-lib/shell-result"
import { commandText, type Diagnostic, intersectPermissions, restrictedEffect } from "./convert.ts"
import {
  claudeToolInput,
  claudeToolNames,
  type HookEvent,
  type HookSpec,
  hookEnvironment,
  interpretHook,
  matcherMatches,
  runHook,
} from "./hooks.ts"
import { acquireBundle, type Bundle, bundleKey, loadBundle, type Settings } from "./load.ts"
import { configGroups, type Group, within } from "./source.ts"
import { isTrusted, projectFileDigest, rememberTrust, TRUST_ACTION, trustResource } from "./trust.ts"

export const ID = "srobroek.claude-compat"
export const CHECK_TOOL = "claude_compat_check"
export const TRUST_COMMAND = "claude-compat-trust"
/** The permission action a hook's `ask` decision asserts; allow or deny it like any other. */
export const HOOK_ASK_ACTION = "claude_hook"

type Registration = { dispose: () => Promise<void> }

export type Options = Settings & { env: string[] }

/** The plugin options that change what loads and how hooks run. Throws on a malformed value. */
export function parseSettings(options: Record<string, unknown>): Options {
  const untyped = options.untypedAgents ?? "inherit"
  if (untyped !== "inherit" && untyped !== "deny") throw new Error("claude-compat: untypedAgents must be inherit or deny")
  for (const key of ["hooks", "instructions", "toolNote", "projectFile"])
    if (options[key] !== undefined && typeof options[key] !== "boolean") throw new Error(`claude-compat: ${key} must be a boolean`)
  const env = options.env ?? []
  if (!Array.isArray(env) || !env.every((name) => typeof name === "string")) throw new Error("claude-compat: env must be a list of names")
  return {
    untypedAgents: untyped,
    toolNote: options.toolNote !== false,
    hooks: options.hooks !== false,
    instructions: options.instructions === true,
    env,
  }
}

/** The project root sources resolve against: the location's project, else its directory. */
export function projectRoot(ctx: Pick<Context, "location">): string {
  return locationDirectories(ctx).at(-1) ?? (ctx.location.directory as string)
}

const warned = new Set<string>()

/** Warn once per process and project for each distinct line. */
function warnOnce(project: string, line: string, warn: (line: string) => void) {
  if (warned.has(`${project}\0${line}`)) return
  warned.add(`${project}\0${line}`)
  warn(line)
}

/** Hooks that will not run, one line per plugin. */
export function hookWarnings(bundle: Bundle): string[] {
  const lines: string[] = []
  for (const plugin of bundle.plugins) {
    const dropped = bundle.diagnostics.filter(
      (issue) =>
        (issue.where.startsWith(plugin.root) || issue.where.startsWith(`${plugin.name}:`)) && /hook/i.test(issue.message) && /not run/.test(issue.message),
    )
    if (dropped.length > 0) lines.push(`${ID}: ${plugin.name}: ${[...new Set(dropped.map((issue) => issue.message))].join("; ")}`)
  }
  return lines
}

export type Deps = { warn: (message: string) => void; env: Record<string, string | undefined> }

type Report = { plugins: string[]; loaded: Record<string, string[]>; diagnostics: Diagnostic[] }
type Activation = { report: Report; dispose: () => Promise<void> }

/** A project-file group waiting for approval, with the digest it would be approved under. */
type Pending = { group: Group; path: string; digest: string }

export async function setupClaudeCompat(ctx: Context, deps: Deps = { warn: console.warn, env: process.env }) {
  const options = ctx.options as Record<string, unknown>
  const settings = parseSettings(options)
  const project = projectRoot(ctx)
  const config = configGroups(options, project)
  const trusted: Group[] = []
  const pending: Pending[] = []
  for (const group of config.groups) {
    if (!group.projectFile) {
      trusted.push(group)
      continue
    }
    try {
      const digest = projectFileDigest(group, project)
      if (await isTrusted(ctx.storage, group.projectFile.path, digest))
        trusted.push({ ...group, projectFile: { ...group.projectFile, digest } })
      else pending.push({ group, path: group.projectFile.path, digest })
    } catch (error) {
      config.diagnostics.push({ where: group.projectFile.path, message: `Project sources could not be verified; not loaded: ${String(error)}` })
    }
  }

  let activation: Activation | undefined
  let disposed = false
  let queue: Promise<unknown> = Promise.resolve()
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work)
    queue = next.catch(() => undefined)
    return next
  }
  const reactivate = () =>
    serial(async () => {
      if (disposed) return
      const previous = activation
      activation = undefined
      await previous?.dispose()
      activation = await activate(ctx, project, [...trusted], settings, deps)
    })
  const pendingDiagnostics = () =>
    pending.map(({ path, digest }) => ({
      where: path,
      message: `Project file not approved (sha256:${digest.slice(0, 12)}…); nothing from it loads until you run /${TRUST_COMMAND}`,
    }))

  const registrations: Registration[] = []
  const cleanup = async () => {
    disposed = true
    const errors: unknown[] = []
    try {
      await serial(async () => {
        await activation?.dispose()
        activation = undefined
      })
    } catch (error) {
      errors.push(error)
    }
    for (const registration of registrations.toReversed()) {
      try {
        await registration.dispose()
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length) throw new AggregateError(errors, "Claude compatibility cleanup failed")
  }

  try {
    await reactivate()
    registrations.push(
      await ctx.tool.transform((editor) =>
        editor.add({
          name: CHECK_TOOL,
          description: "List what claude-compat loaded for this project and what it dropped or could not convert.",
          input: { type: "object", properties: {}, additionalProperties: false } as never,
          execute: async () => {
            const report = activation?.report ?? { plugins: [], loaded: {}, diagnostics: [] }
            const diagnostics = [...config.diagnostics, ...pendingDiagnostics(), ...report.diagnostics]
            return { content: JSON.stringify({ project, plugins: report.plugins, loaded: report.loaded, diagnostics }, null, 2) }
          },
        }),
      ),
    )
    if (pending.length > 0) {
      // Even the host's default '* allow' must not approve a repository's code silently.
      registrations.push(await ctx.permission.hook("evaluate", (event) => {
        if (event.action === TRUST_ACTION && event.effect !== "deny") event.effect = "ask"
      }))
      for (const issue of pendingDiagnostics()) warnOnce(project, `${ID}: ${issue.where}: ${issue.message}`, deps.warn)
      registrations.push(
        await ctx.command.transform((editor) =>
          editor.add({
            name: TRUST_COMMAND,
            description: "Review and approve this project's .opencode/claude-compat.json and the Claude plugins it names.",
            execute: async (input) => {
              const approved: string[] = []
              for (const entry of [...pending]) {
                // Hash again: the file or a source may have changed since load.
                const fresh = configGroups(options, project).groups.find((group) => group.projectFile?.path === entry.path)
                if (!fresh) continue
                const digest = projectFileDigest(fresh, project)
                await ctx.permission.assert({
                  sessionID: input.sessionID,
                  action: TRUST_ACTION,
                  resources: [trustResource(entry.path, digest)],
                  metadata: { file: entry.path, sources: fresh.sources, plugins: fresh.plugins ?? "all" },
                } as never)
                if (disposed) throw new Error("claude-compat was disposed during approval")
                const verified = configGroups(options, project).groups.find((group) => group.projectFile?.path === entry.path)
                if (!verified || projectFileDigest(verified, project) !== digest)
                  throw new Error("Project file or sources changed during approval; run the trust command again")
                await rememberTrust(ctx.storage, entry.path, digest)
                pending.splice(pending.indexOf(entry), 1)
                trusted.push({ ...fresh, projectFile: { ...fresh.projectFile as { path: string; text: string }, digest } })
                approved.push(entry.path)
              }
              if (approved.length > 0) await reactivate()
              const report = activation?.report
              await ctx.session.synthetic({
                sessionID: input.sessionID,
                text:
                  approved.length > 0
                    ? `claude-compat: approved ${approved.join(", ")}; loaded plugins: ${report?.plugins.join(", ") || "none"}.`
                    : "claude-compat: no project file is waiting for approval.",
                description: "claude-compat trust",
                metadata: { source: ID, kind: "trust" },
                delivery: "steer",
                resume: false,
              } as never)
            },
          }),
        ),
      )
    }
    return cleanup
  } catch (error) {
    await cleanup()
    throw error
  }
}

/** Register one bundle. The returned dispose aborts running hooks and waits for them. */
async function activate(ctx: Context, project: string, groups: Group[], settings: Options, deps: Deps): Promise<Activation> {
  const { env: extraEnv, ...bundleSettings } = settings
  const { bundle, release } = await acquireBundle(bundleKey(project, groups, bundleSettings), () => loadBundle(project, groups, bundleSettings))
  const diagnostics: Diagnostic[] = [...bundle.diagnostics]
  const loaded = { skills: [] as string[], agents: [] as string[], commands: [] as string[], mcp: [] as string[], hooks: [] as string[] }
  const registrations: Registration[] = []
  const abort = new AbortController()
  const outstanding = new Set<Promise<unknown>>()
  const track = <T>(work: Promise<T>): Promise<T> => {
    outstanding.add(work)
    void work.finally(() => outstanding.delete(work)).catch(() => undefined)
    return work
  }
  const dispose = async () => {
    abort.abort()
    const errors: unknown[] = []
    await Promise.allSettled([...outstanding])
    for (const registration of registrations.toReversed()) {
      try {
        await registration.dispose()
      } catch (error) {
        errors.push(error)
      }
    }
    release()
    if (errors.length) throw new AggregateError(errors, "Claude compatibility cleanup failed")
  }
  // Looked up on every use: a session can move to another directory at any time.
  const sessionDirectory = async (sessionID: string): Promise<string | undefined> => {
    const directory = await ctx.session
      .get({ sessionID } as never)
      .then((session) => (session as { location?: { directory?: string } }).location?.directory ?? (ctx.location.directory as string))
      .catch(() => undefined)
    return directory !== undefined && within(project, directory) ? directory : undefined
  }

  try {
    if (bundle.skills.length > 0) {
      registrations.push(
        await ctx.skill.transform((editor) => {
          for (const skill of bundle.skills) if (editor.get(skill.id) === undefined) editor.add(skill)
        }),
      )
      loaded.skills.push(...bundle.skills.map((skill) => skill.id))
    }
    if (bundle.agents.length > 0) {
      const refused = new Set<string>()
      const policies = new Map<string, { existing: AgentPermission[]; imported: AgentPermission[] }>()
      registrations.push(
        await registerAgentFiles(ctx.agent, bundle.agents, {
          onExisting: (id) => {
            policies.delete(id)
            if (refused.has(id)) return
            refused.add(id)
            diagnostics.push({ where: id, message: "An agent with this id already exists; the imported agent is not registered" })
          },
          permissions: (existing, file, editor) => {
            // V2 creates new agents with built-in defaults, not the user's global rules.
            // Those rules are already on the native build agent. Carry that baseline across
            // after the new defaults so an initial '* allow' cannot erase a configured deny.
            const baseline = [...existing, ...(editor.get("build")?.permissions ?? [])]
            policies.set(file.id, { existing: structuredClone(baseline), imported: structuredClone(file.permissions) })
            return intersectPermissions(baseline, file.permissions)
          },
        }),
      )
      registrations.push(await ctx.permission.hook("evaluate", (event) => {
        const policy = event.agent === undefined ? undefined : policies.get(event.agent)
        if (policy) event.effect = restrictedEffect(event.effect, policy.existing, policy.imported, event.action, event.resources)
      }))
      loaded.agents.push(...bundle.agents.map((agent) => agent.id).filter((id) => !refused.has(id)))
    }
    if (bundle.commands.length > 0) {
      registrations.push(
        await ctx.command.transform((editor) => {
          for (const command of bundle.commands)
            editor.add({
              name: command.name,
              ...(command.description ? { description: command.description } : {}),
              execute: async (input) => {
                await ctx.session.prompt({
                  sessionID: input.sessionID,
                  ...input.prompt,
                  text: commandText(command.template, input.prompt.text ?? ""),
                  delivery: input.delivery,
                } as never)
              },
            })
        }),
      )
      loaded.commands.push(...bundle.commands.map((command) => command.name))
    }
    // Registration only adds the server config; OpenCode connects (and reports failures) itself.
    const mcpOptions = parseMcpOptions(ctx.options as Record<string, unknown>)
    for (const entry of bundle.mcp) {
      const result = await registerMcp(ctx, entry.servers, mcpOptions, { env: { ...deps.env, CLAUDE_PLUGIN_ROOT: entry.root } })
      registrations.push(result.registration)
      loaded.mcp.push(...result.plan.add.map(([name]) => name))
      diagnostics.push(...result.plan.skipped.map(({ name, reason }) => ({ where: `${entry.plugin}: mcp ${name}`, message: reason })))
    }
    if (bundle.hooks.length > 0) {
      const env = { ...hookEnvironment(deps.env, extraEnv), CLAUDE_PROJECT_DIR: project }
      await registerHooks(ctx, bundle, project, { sessionDirectory, env, deps, registrations, signal: abort.signal, track })
      loaded.hooks.push(...bundle.hooks.map((hook) => `${hook.plugin}:${hook.event}${hook.matcher ? `(${hook.matcher})` : ""}`))
    }
    if (bundle.instructions.length > 0) {
      const text = bundle.instructions.map((entry) => `Instructions from Claude plugin ${entry.plugin} (CLAUDE.md):\n${entry.text}`).join("\n\n")
      const add = async (event: { sessionID: string; system: Array<{ type: "text"; text: string }> }) => {
        if (await sessionDirectory(event.sessionID)) event.system.push({ type: "text", text })
      }
      for (const name of ["context", "compaction", "generate"] as const) registrations.push(await ctx.session.hook(name, add as never))
    }
    for (const line of hookWarnings(bundle)) warnOnce(project, line, deps.warn)
    return { report: { plugins: bundle.plugins.map((plugin) => plugin.name), loaded, diagnostics }, dispose }
  } catch (error) {
    await dispose()
    throw error
  }
}

type HookContext = {
  sessionDirectory: (sessionID: string) => Promise<string | undefined>
  env: Record<string, string>
  deps: Deps
  registrations: Registration[]
  /** Aborted on dispose: kills running hooks and stops late results. */
  signal: AbortSignal
  track: <T>(work: Promise<T>) => Promise<T>
}

async function registerHooks(ctx: Context, bundle: Bundle, project: string, hooks: HookContext) {
  const { sessionDirectory, env, deps, registrations, signal, track } = hooks
  const servers = new Map(bundle.mcp.flatMap((entry) => Object.keys(entry.servers).map((name) => [name, entry.plugin] as const)))
  const of = (event: HookEvent) => bundle.hooks.filter((hook) => hook.event === event)
  const run = async (hook: HookSpec, payload: Record<string, unknown>, cwd: string) => {
    const outcome = interpretHook(hook.event, await track(runHook(hook, { ...payload, hook_event_name: hook.event }, env, cwd, signal)))
    if (outcome.effect === "none" && outcome.warning && !signal.aborted) deps.warn(`${ID}: ${hook.plugin} ${hook.event}: ${outcome.warning}`)
    return outcome
  }
  const base = (sessionID: string, cwd: string) => ({ session_id: sessionID, transcript_path: "", cwd, permission_mode: "default" })

  const pre = of("PreToolUse")
  if (pre.length > 0)
    registrations.push(
      await ctx.tool.hook("execute.before", async (event) => {
        const names = claudeToolNames(event.tool, servers)
        const matching = pre.filter((hook) => matcherMatches(hook.matcher, names))
        if (matching.length === 0 || signal.aborted) return
        const cwd = await sessionDirectory(event.sessionID)
        if (cwd === undefined) return
        const payload = { ...base(event.sessionID, cwd), tool_name: names[0], tool_input: claudeToolInput(event.tool, event.input), tool_use_id: event.id }
        for (const hook of matching) {
          const outcome = await run(hook, payload, cwd)
          if (outcome.effect === "block") throw new Error(`Blocked by the ${hook.plugin} PreToolUse hook: ${outcome.reason}`)
          if (outcome.effect === "ask")
            await ctx.permission.assert({
              sessionID: event.sessionID,
              agent: event.agent,
              source: { type: "tool", messageID: event.messageID, id: event.id },
              action: HOOK_ASK_ACTION,
              resources: [`${hook.plugin}: ${outcome.reason}`],
            } as never)
        }
      }),
    )

  const post = of("PostToolUse")
  if (post.length > 0)
    registrations.push(
      await ctx.tool.hook("execute.after", async (event) => {
        if (event.status !== "completed" || signal.aborted) return
        const names = claudeToolNames(event.tool, servers)
        const matching = post.filter((hook) => matcherMatches(hook.matcher, names))
        if (matching.length === 0) return
        const cwd = await sessionDirectory(event.sessionID)
        if (cwd === undefined) return
        const payload = {
          ...base(event.sessionID, cwd),
          tool_name: names[0],
          tool_input: claudeToolInput(event.tool, event.input),
          tool_response: { content: resultText(event.result), output: event.result.output },
          tool_use_id: event.id,
        }
        for (const hook of matching) {
          const outcome = await run(hook, payload, cwd)
          if (signal.aborted) return
          if (outcome.effect === "context" || outcome.effect === "block")
            event.result = appendResultText(event.result, `[${hook.plugin} PostToolUse hook] ${outcome.effect === "context" ? outcome.text : outcome.reason}`)
        }
      }),
    )

  // Only `startup` SessionStart hooks reach the bundle; parseHooks reports the others.
  const start = of("SessionStart")
  if (start.length === 0) return
  // A session is new when it was created after this load; older ones would be Claude's "resume".
  const loadedAt = Date.now()
  const starts = new Map<string, Promise<void>>()
  type Info = { parentID?: unknown; location?: { directory?: unknown }; time?: { created?: unknown } }
  const sessionStart = (sessionID: string, known?: Info): Promise<void> => {
    const existing = starts.get(sessionID)
    if (existing) return existing
    const pending = track(
      (async () => {
        const info = known ?? ((await ctx.session.get({ sessionID } as never)) as Info)
        if (typeof info.parentID === "string") return
        if (typeof info.time?.created === "number" && info.time.created < loadedAt) return
        const location = info.location?.directory
        const cwd = typeof location === "string" ? (within(project, location) ? location : undefined) : await sessionDirectory(sessionID)
        if (cwd === undefined) return
        for (const hook of start) {
          if (signal.aborted) return
          const outcome = await run(hook, { ...base(sessionID, cwd), source: "startup" }, cwd)
          // A result that arrives after dispose is dropped.
          if (outcome.effect === "context" && !signal.aborted)
            await ctx.session.synthetic({
              sessionID,
              text: `Session context from the Claude plugin ${hook.plugin} (SessionStart hook):\n${outcome.text}`,
              description: `${hook.plugin} SessionStart hook`,
              metadata: { source: ID, kind: "session-start", plugin: hook.plugin },
              // Steer folds the context into the session's next (or current) turn instead of starting one.
              delivery: "steer",
              resume: false,
            } as never)
        }
      })().catch((error) => {
        if (!signal.aborted) deps.warn(`${ID}: SessionStart hook failed: ${String(error)}`)
      }),
    )
    starts.set(sessionID, pending)
    return pending
  }
  // The first prompt waits for the hooks, so their context lands before it, as in Claude Code.
  registrations.push(await ctx.session.hook("prompt", (event) => sessionStart(event.sessionID)))
  const iterator = ctx.event.subscribe({ signal } as never)[Symbol.asyncIterator]()
  registrations.push({
    dispose: async () => {
      await iterator.return?.()
      starts.clear()
    },
  })
  void (async () => {
    for (;;) {
      const next = await iterator.next().catch(() => ({ done: true as const, value: undefined }))
      if (next.done || signal.aborted) return
      const event = next.value as { type?: unknown; data?: Record<string, unknown> }
      if (event?.type === "session.created" && typeof event.data?.sessionID === "string")
        void sessionStart(event.data.sessionID, event.data as Info)
    }
  })()
}

export default Plugin.define({ id: ID, setup: (ctx) => setupClaudeCompat(ctx) })
