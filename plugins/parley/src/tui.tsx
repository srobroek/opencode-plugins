import { readdirSync } from "node:fs"
import path from "node:path"
import type { LocationRef } from "@opencode/client"
import { Plugin } from "@opencode/plugin/tui"
import { SyntaxStyle } from "@opentui/core"
import { createEffect, createSignal, Show } from "solid-js"
import type { SubmittedAnswer } from "./answers.ts"
import { createRoundStore, InlineCard, PANEL, RoundPanel } from "./panel.tsx"
import { canAutoPresent, canCloseRoundPanel } from "./presentation.ts"
import { instanceChanged, reconcileRounds } from "./reconcile.ts"
import type { RoundView } from "./rounds.ts"
import { ParleyRpc, type RoundEvent } from "./rpc.ts"
import { type Outcome, submitRound } from "./submit.ts"
import { draftFromAnswer, inlineEligible } from "./tui-state.ts"

const HEARTBEAT_MS = 10_000
/** When to look for the built-in form of a call handed to the built-in tool (ms since the last look). */
const NATIVE_POLL_MS = [0, 100, 300, 700, 1500, 3000, 6000, 12_000]

interface Entry {
  readonly view: RoundView
  readonly location: LocationRef
}

/** Entries of the directory a ~ or absolute path is in, as typed paths (directories end in /). */
function listDirectory(query: string): string[] {
  const home = process.env.HOME ?? ""
  const expanded = query.startsWith("~") ? `${home}${query.slice(1)}` : query
  const dir = expanded.endsWith("/") ? expanded : path.dirname(expanded)
  const typedDir = query.endsWith("/") ? query : query.slice(0, query.length - path.basename(expanded).length)
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => !entry.name.startsWith(".") || path.basename(expanded).startsWith("."))
      .map((entry) => `${typedDir}${entry.name}${entry.isDirectory() ? "/" : ""}`)
  } catch {
    return []
  }
}

const locationKey = (location: LocationRef) => `${location.directory}\u0000${location.workspaceID ?? ""}`

export default Plugin.define({
  id: "srobroek.parley",
  setup(context) {
    let disposed = false
    const delays = new Map<ReturnType<typeof setTimeout>, () => void>()
    const sleep = (ms: number) => new Promise<void>((resolve) => {
      const timer = setTimeout(() => { delays.delete(timer); resolve() }, ms)
      delays.set(timer, resolve)
    })
    const rpc = context.client.rpc(ParleyRpc)
    const clientID = `tui_${crypto.randomUUID()}`
    const [rounds, setRounds] = createSignal<Entry[]>([])
    const store = createRoundStore()
    // Bumped to make the open card or panel take focus back (/parley, alt+p).
    const [focusRequest, setFocusRequest] = createSignal(0)
    // Sessions whose one-question round shows as the inline card (cleared by esc, kept across round updates).
    const [inline, setInline] = createSignal<ReadonlySet<string>>(new Set())
    // Opened elsewhere while another question owns the foreground. Present on an
    // intentional visit to that tab, not by replacing the user's pending question.
    const [deferred, setDeferred] = createSignal<ReadonlySet<string>>(new Set())
    const deferPresentation = (sessionID: string, on: boolean) => setDeferred((current) => {
      const next = new Set(current)
      if (on) next.add(sessionID)
      else next.delete(sessionID)
      return next
    })
    const showInline = (sessionID: string, on: boolean) =>
      setInline((current) => {
        const next = new Set(current)
        if (on) next.add(sessionID)
        else next.delete(sessionID)
        return next
      })
    const theme = context.theme
    const syntax = SyntaxStyle.fromStyles(
      {
        default: { fg: theme.text.base },
        "markup.heading": { fg: theme.markdown.heading, bold: true },
        "markup.heading.1": { fg: theme.markdown.heading, bold: true, underline: true },
        "markup.strong": { fg: theme.markdown.strong, bold: true },
        "markup.italic": { fg: theme.markdown.emphasis, italic: true },
        "markup.list": { fg: theme.markdown.listItem },
        "markup.quote": { fg: theme.markdown.blockQuote, italic: true },
        "markup.raw": { fg: theme.markdown.code },
        "markup.raw.block": { fg: theme.markdown.codeBlock },
        "markup.link": { fg: theme.markdown.link, underline: true },
        "markup.link.label": { fg: theme.markdown.linkText, underline: true },
        conceal: { fg: theme.text.faint },
      },
      context.renderer.nativeScene,
    )

    const locations = () => {
      const found = new Map<string, LocationRef>()
      const add = (location: LocationRef | undefined) => {
        if (location) found.set(locationKey(location), location)
      }
      add(context.location ?? context.data.location.default())
      if (context.ui.tabs.enabled())
        for (const tab of context.ui.tabs.list()) add(context.data.session.get(tab.sessionID)?.location)
      for (const entry of rounds()) add(entry.location)
      return [...found.values()]
    }

    // The server instance each location last answered from; a new one means the plugin reloaded there.
    const instances = new Map<string, string>()
    // Rounds the server no longer lists after a reload. They stay, with their drafts, until the user acts.
    let lost: ReadonlySet<string> = new Set()
    const refresh = async (location: LocationRef, reloaded = false) => {
      if (disposed) return
      const result = (await rpc.pending({}, { location }).catch(() => undefined)) as
        | { rounds?: RoundView[]; instance?: string }
        | undefined
      if (disposed || !result) return
      const key = locationKey(location)
      const merged = reconcileRounds({
        current: rounds().filter((entry) => locationKey(entry.location) === key),
        server: result.rounds ?? [],
        lost,
        reloaded: instanceChanged(instances, key, result.instance) || reloaded,
        toEntry: (view): Entry => ({ view, location }),
      })
      lost = merged.lost
      for (const id of merged.forget) store.forget(id)
      // A round whose message to the agent failed comes back closed: its card shows the answers the user gave.
      for (const entry of merged.entries) {
        if (entry.view.undelivered === undefined) continue
        for (const answer of entry.view.answers) {
          const question = entry.view.questions.find((candidate) => candidate.id === answer.id)
          const key = `${entry.view.roundID}\u0000${answer.id}`
          if (question && store.drafts[key] === undefined) store.setDraft(key, draftFromAnswer(question, answer))
        }
      }
      setRounds((all) => [...all.filter((entry) => locationKey(entry.location) !== key), ...merged.entries])
    }

    const forSession = (sessionID: string) => rounds().find((entry) => entry.view.sessionID === sessionID)

    const single = (sessionID: string) => inlineEligible(forSession(sessionID)?.view.questions ?? [])

    const openPanel = (sessionID: string, delay = 0) => {
      const roundID = forSession(sessionID)?.view.roundID
      showInline(sessionID, false)
      // Let the route switch before the panel opens in the now-current session.
      void sleep(delay).then(() => {
        if (disposed) return
        const route = context.ui.router.current()
        if (route.type !== "session" || route.sessionID !== sessionID || forSession(sessionID)?.view.roundID !== roundID) return
        if (roundID === undefined) return
        context.ui.panel.open(PANEL, { presentation: "fullscreen" })
      })
    }

    const present = (sessionID: string, automatic = false) => {
      const entry = forSession(sessionID)
      if (!entry) return
      const route = context.ui.router.current()
      const current = route.type === "session" ? route.sessionID : undefined
      if (automatic && !canAutoPresent(sessionID, current, rounds().map((item) => item.view.sessionID))) {
        deferPresentation(sessionID, true)
        if (single(sessionID)) showInline(sessionID, true)
        context.ui.toast.show({ title: "Parley", message: "Questions waiting in another tab", sessionID })
        return
      }
      deferPresentation(sessionID, false)
      const here = route.type === "session" && route.sessionID === sessionID
      if (!here && !context.ui.tabs.focus(sessionID)) context.ui.router.navigate({ type: "session", sessionID })
      // One question shows as a card above the prompt; a larger round takes the screen.
      if (single(sessionID)) {
        const open = context.ui.panel.current()
        if (open?.name === PANEL && open.sessionID === sessionID) context.ui.panel.close()
        showInline(sessionID, true)
      } else {
        const open = context.ui.panel.current()
        // An open panel keeps its presentation (full screen or side) and only takes focus back.
        if (!here || open?.name !== PANEL || open.sessionID !== sessionID) openPanel(sessionID, here ? 0 : 50)
      }
      setFocusRequest((value) => value + 1)
      const count = entry.view.questions.length
      void context.attention
        .notify({
          title: "Parley",
          message: `${count} question${count === 1 ? "" : "s"} waiting${entry.view.title ? `: ${entry.view.title}` : ""}`,
          notification: { when: "blurred" },
          sound: { name: "question", when: "blurred" },
        })
        .catch(() => {})
    }

    let reachable = true
    const heartbeat = async () => {
      if (disposed) return
      const results = await Promise.all(
        locations().map((location) =>
          rpc.attach({ clientID }, { location }).then(
            (reply) => {
              const instance = (reply as { instance?: string } | undefined)?.instance
              // Fetch the restored rounds again. The round ids are unchanged, so drafts are kept.
              if (instanceChanged(instances, locationKey(location), instance)) void refresh(location, true)
              return true
            },
            () => false,
          ),
        ),
      )
      if (disposed) return
      const ok = results.some(Boolean)
      // Reconnected: catch up on rounds opened while we could not hear events.
      if (ok && !reachable) for (const location of locations()) void refresh(location)
      reachable = ok
    }

    const stopEvents = rpc.events.on("round", async (event) => {
      const data = event.data as unknown as RoundEvent
      const location = event.location as LocationRef
      if (data.action === "native") {
        if (data.callID) void fetchNative(data.sessionID, data.callID, location)
        return
      }
      await refresh(location)
      if (disposed) return
      if (data.action === "opened" && data.status === "undelivered") {
        context.ui.toast.show({ title: "Parley", message: data.reason || "Your answers did not reach the agent", variant: "warning", sessionID: data.sessionID })
        present(data.sessionID, true)
      } else if (data.action === "opened") present(data.sessionID, true)
      else if (data.action === "updated") {
        if (inline().has(data.sessionID) && !single(data.sessionID)) {
          openPanel(data.sessionID)
          return
        }
        const open = context.ui.panel.current()
        if (open?.name !== PANEL || open.sessionID !== data.sessionID)
          context.ui.toast.show({ message: "New questions joined the open round", sessionID: data.sessionID })
      } else {
        const open = context.ui.panel.current()
        if (open?.name === PANEL && open.sessionID === data.sessionID && !forSession(data.sessionID))
          context.ui.panel.close()
        if (!forSession(data.sessionID)) { showInline(data.sessionID, false); deferPresentation(data.sessionID, false) }
        if (data.action === "ended" && data.message)
          context.ui.toast.show({ title: "Parley", message: data.message, sessionID: data.sessionID })
        else if (data.reason === "timeout")
          context.ui.toast.show({ message: "The round timed out; the agent goes on without it", variant: "warning", sessionID: data.sessionID })
        else if (data.reason === "aborted")
          context.ui.toast.show({ message: "Round cancelled by the agent", variant: "warning", sessionID: data.sessionID })
      }
    })

    // A `question` call the server hands to the built-in tool opens a form whose events carry no
    // location (the tool runs under parley's wrapper), and the data layer drops those. Fetch the form
    // so it shows, or, for the built-in half of a dismissal, cancel it without a message so the call
    // fails with the built-in dismissal and the turn ends.
    const dismissing = new Set<string>()
    const fetchNative = async (sessionID: string, callID: string, location: LocationRef) => {
      for (const delay of NATIVE_POLL_MS) {
        if (disposed) return
        await sleep(delay)
        if (disposed) return
        context.data.session.form.invalidate(sessionID, location)
        await context.data.session.form.sync(sessionID, location).catch(() => {})
        if (disposed) return
        const form = (context.data.session.form.list(sessionID, location) ?? []).find(
          (candidate) => (candidate.metadata as { tool?: { id?: string } } | undefined)?.tool?.id === callID,
        )
        if (!form) continue
        if (dismissing.delete(callID))
          await context.data.session.form.cancel({ sessionID, formID: form.id }, location).catch(() => {})
        return
      }
      dismissing.delete(callID)
    }

    const stopReconnect = context.data.listen(({ details }) => {
      if (details.type === "server.connected") for (const location of locations()) void refresh(location)
    })

    void heartbeat()
    for (const location of locations()) void refresh(location)
    const timer = setInterval(() => void heartbeat(), HEARTBEAT_MS)

    // One id per round, reused when the user retries, so the server sends the message once.
    const deliveryIDs = new Map<string, string>()
    const submit = async (view: RoundView, answers: SubmittedAnswer[]) => {
      const entry = rounds().find((item) => item.view.roundID === view.roundID)
      if (!entry) return ["This round is no longer open."]
      const problems = await submitRound({
        submit: () => rpc.submit({ roundID: view.roundID, sessionID: view.sessionID, answers, final: true }, { location: entry.location }) as Promise<Outcome>,
        deliver: () =>
          rpc.deliver(
            {
              sessionID: view.sessionID,
              roundID: view.roundID,
              number: view.number,
              questions: [...view.questions],
              answers,
              deliveryID: deliveryIDs.get(view.roundID) ?? deliveryIDs.set(view.roundID, crypto.randomUUID()).get(view.roundID),
            },
            { location: entry.location },
          ) as Promise<Outcome>,
        choose: async () =>
          (await context.ui.dialog.confirm({
            title: view.undelivered === undefined ? "This round is gone" : "Your answers did not reach the agent",
            message:
              view.undelivered === undefined
                ? "The server lost this round. You can still send your answers to the agent as a message."
                : "Sending them as a message failed. You can try again, or dismiss them.",
            label: { confirm: "Send these answers as a message", cancel: "Dismiss" },
          })) === true,
        dismiss: async () => {
          await rpc.cancel({ roundID: view.roundID, reason: "dismissed" }, { location: entry.location }).catch(() => {})
        },
        notify: (message, variant) => context.ui.toast.show({ message, ...(variant ? { variant } : {}), duration: 2000 }),
        settle: async () => {
          lost = new Set([...lost].filter((id) => id !== view.roundID))
          await refresh(entry.location)
          if (disposed) return
          const stillPending = forSession(view.sessionID) !== undefined
          if (canCloseRoundPanel(context.ui.panel.current(), PANEL, view.sessionID, stillPending)) context.ui.panel.close()
          if (!stillPending) showInline(view.sessionID, false)
        },
      })
      return disposed ? [] : problems
    }

    const dismiss = async (view: RoundView) => {
      const entry = rounds().find((item) => item.view.roundID === view.roundID)
      if (!entry) return
      const native = (view.callIDs?.length ?? 0) > 0
      const confirmed = await context.ui.dialog.confirm({
        title: "Dismiss round?",
        message: native
          ? "This ends the agent's turn, like dismissing a question."
          : "The agent gets a cancelled result for every question in this round.",
        label: { confirm: "Dismiss", cancel: "Keep" },
      })
      if (disposed || !confirmed) return
      for (const callID of view.callIDs ?? []) dismissing.add(callID)
      await rpc.cancel({ roundID: view.roundID, reason: "user_closed" }, { location: entry.location }).catch(() => {})
      lost = new Set([...lost].filter((id) => id !== view.roundID))
      await refresh(entry.location)
      if (disposed) return
      const stillPending = forSession(view.sessionID) !== undefined
      if (canCloseRoundPanel(context.ui.panel.current(), PANEL, view.sessionID, stillPending)) context.ui.panel.close()
      if (!stillPending) showInline(view.sessionID, false)
    }

    const directoryOf = (sessionID: string) =>
      forSession(sessionID)?.location.directory ?? context.data.session.get(sessionID)?.location?.directory

    /** Path candidates for a file card: the server's file search under the session directory, or a directory listing for ~ and absolute paths. */
    const find = async (sessionID: string, query: string): Promise<string[]> => {
      if (disposed) return []
      if (query.startsWith("/") || query.startsWith("~")) return listDirectory(query)
      const directory = directoryOf(sessionID)
      const found = await context.client.file.find({
        ...(directory === undefined ? {} : { location: { directory } }),
        query,
        limit: 200,
      } as never)
      if (disposed) return []
      return ((found as { data?: { path: string; type: string }[] }).data ?? []).map((item) =>
        item.type === "directory" && !item.path.endsWith("/") ? `${item.path}/` : item.path,
      )
    }

    const disposeSlot = context.ui.slot({
      append: "session.panel",
      render: (panel) => (
        <Show when={panel.name === PANEL ? forSession(panel.sessionID)?.view.roundID : undefined} keyed>
          {() => <RoundPanel
            store={store}
            context={context}
            panel={panel}
            round={() => forSession(panel.sessionID)?.view}
            syntax={syntax}
            submit={submit}
            dismiss={dismiss}
            focusRequest={focusRequest}
            directory={() => directoryOf(panel.sessionID)}
            find={(query) => find(panel.sessionID, query)}
            inline={() => {
              context.ui.panel.close()
              showInline(panel.sessionID, true)
            }}
          />}
        </Show>
      ),
    })

    const disposeCard = context.ui.slot({
      append: "session.composer.top",
      render: (slot) => (
        <Show when={inline().has(slot.sessionID) && single(slot.sessionID) ? forSession(slot.sessionID)?.view.roundID : undefined} keyed>
          {(_: string) => (
            <InlineCard
              store={store}
              context={context}
              round={() => forSession(slot.sessionID)?.view}
              syntax={syntax}
              submit={submit}
              dismiss={dismiss}
              focusRequest={focusRequest}
              directory={() => directoryOf(slot.sessionID)}
              find={(query) => find(slot.sessionID, query)}
              hide={() => showInline(slot.sessionID, false)}
              expand={() => openPanel(slot.sessionID)}
            />
          )}
        </Show>
      ),
    })

    const currentSession = () => {
      const route = context.ui.router.current()
      return route.type === "session" ? route.sessionID : undefined
    }

    const disposeCommands = context.ui.slot({
      append: "app",
      render: () => {
        createEffect(() => {
          const sessionID = currentSession()
          if (sessionID && deferred().has(sessionID) && forSession(sessionID)) present(sessionID)
        })
        context.keymap.layer(() => ({
          mode: "global",
          commands: [
            {
              id: "parley.open",
              title: "Open parley round",
              description: "Show this session's open question round",
              group: "Parley",
              palette: true,
              slash: { name: "parley" },
              // Always listed, so /parley is there to find; with no open round it says so.
              run: () => {
                const sessionID = currentSession()
                if (sessionID && forSession(sessionID)) present(sessionID)
                else context.ui.toast.show({ message: "No open parley round in this session" })
              },
            },
            {
              id: "parley.focus",
              title: "Return to parley round",
              description: "Move focus back to this session's open question card or panel",
              group: "Parley",
              palette: true,
              bind: "alt+p",
              enabled: () => {
                const sessionID = currentSession()
                return sessionID !== undefined && forSession(sessionID) !== undefined
              },
              run: () => {
                const sessionID = currentSession()
                if (sessionID) present(sessionID)
              },
            },
          ],
        }))
        return null
      },
    })

    return () => {
      if (disposed) return
      disposed = true
      const attachedLocations = locations()
      clearInterval(timer)
      for (const [timer, resolve] of delays) { clearTimeout(timer); resolve() }
      delays.clear()
      stopEvents()
      stopReconnect()
      disposeSlot()
      disposeCard()
      disposeCommands()
      // Best effort: presence expires server-side.
      void Promise.all(
        attachedLocations.map((location) => rpc.attach({ clientID, detach: true }, { location })),
      ).catch(() => {})
      // Don't gate reload on renderer idle.
      void context.renderer.idle().then(() => syntax.destroy()).catch(() => {})
    }
  },
})
