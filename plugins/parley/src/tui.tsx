import type { LocationRef } from "@opencode/client"
import { Plugin } from "@opencode/plugin/tui"
import { SyntaxStyle } from "@opentui/core"
import { createSignal, Show } from "solid-js"
import type { SubmittedAnswer } from "./answers.ts"
import { createRoundStore, InlineCard, PANEL, RoundPanel } from "./panel.tsx"
import type { RoundView } from "./rounds.ts"
import { ParleyRpc, type RoundEvent } from "./rpc.ts"

const HEARTBEAT_MS = 10_000

interface Entry {
  readonly view: RoundView
  readonly location: LocationRef
}

const locationKey = (location: LocationRef) => `${location.directory}\u0000${location.workspaceID ?? ""}`

export default Plugin.define({
  id: "srobroek.parley",
  setup(context) {
    const rpc = context.client.rpc(ParleyRpc)
    const clientID = `tui_${crypto.randomUUID()}`
    const [rounds, setRounds] = createSignal<Entry[]>([])
    const store = createRoundStore()
    // Sessions whose one-question round shows as the inline card (cleared by esc, kept across round updates).
    const [inline, setInline] = createSignal<ReadonlySet<string>>(new Set())
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

    const refresh = async (location: LocationRef) => {
      const result = (await rpc.pending({}, { location }).catch(() => undefined)) as { rounds?: RoundView[] } | undefined
      if (!result) return
      const key = locationKey(location)
      const open = new Set((result.rounds ?? []).map((view) => view.roundID))
      for (const entry of rounds())
        if (locationKey(entry.location) === key && !open.has(entry.view.roundID)) store.forget(entry.view.roundID)
      setRounds((all) => [
        ...all.filter((entry) => locationKey(entry.location) !== key),
        ...(result.rounds ?? []).map((view) => ({ view, location })),
      ])
    }

    const forSession = (sessionID: string) => rounds().find((entry) => entry.view.sessionID === sessionID)

    const single = (sessionID: string) => forSession(sessionID)?.view.questions.length === 1

    const openPanel = (sessionID: string, delay = 0) => {
      showInline(sessionID, false)
      // Let the route switch before the panel opens in the now-current session.
      setTimeout(() => context.ui.panel.open(PANEL, { presentation: "fullscreen" }), delay)
    }

    const present = (sessionID: string) => {
      const entry = forSession(sessionID)
      if (!entry) return
      const route = context.ui.router.current()
      const here = route.type === "session" && route.sessionID === sessionID
      if (!here && !context.ui.tabs.focus(sessionID)) context.ui.router.navigate({ type: "session", sessionID })
      // One question shows as a card above the prompt; a larger round takes the screen.
      if (single(sessionID)) {
        const open = context.ui.panel.current()
        if (open?.name === PANEL && open.sessionID === sessionID) context.ui.panel.close()
        showInline(sessionID, true)
      } else openPanel(sessionID, here ? 0 : 50)
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
      const results = await Promise.all(
        locations().map((location) =>
          rpc.attach({ clientID }, { location }).then(
            () => true,
            () => false,
          ),
        ),
      )
      const ok = results.some(Boolean)
      // Reconnected: catch up on rounds opened while we could not hear events.
      if (ok && !reachable) for (const location of locations()) void refresh(location)
      reachable = ok
    }

    const stopEvents = rpc.events.on("round", async (event) => {
      const data = event.data as unknown as RoundEvent
      const location = event.location as LocationRef
      await refresh(location)
      if (data.action === "opened") present(data.sessionID)
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
        if (!forSession(data.sessionID)) showInline(data.sessionID, false)
        if (data.action === "ended" && data.message)
          context.ui.toast.show({ title: "Parley", message: data.message, sessionID: data.sessionID })
        else if (data.reason === "aborted")
          context.ui.toast.show({ message: "Round cancelled by the agent", variant: "warning", sessionID: data.sessionID })
      }
    })

    const stopReconnect = context.data.listen(({ details }) => {
      if (details.type === "server.connected") for (const location of locations()) void refresh(location)
    })

    void heartbeat()
    for (const location of locations()) void refresh(location)
    const timer = setInterval(() => void heartbeat(), HEARTBEAT_MS)

    const submit = async (view: RoundView, answers: SubmittedAnswer[]) => {
      const entry = rounds().find((item) => item.view.roundID === view.roundID)
      if (!entry) return ["This round is no longer open."]
      try {
        const result = (await rpc.submit({ roundID: view.roundID, answers, final: true }, { location: entry.location })) as {
          ok: boolean
          errors?: string[]
        }
        if (!result.ok) return result.errors ?? ["Submit failed"]
        context.ui.toast.show({ message: "Answers sent", variant: "success", duration: 2000 })
        await refresh(entry.location)
        if (context.ui.panel.current()?.name === PANEL) context.ui.panel.close()
        showInline(view.sessionID, false)
        return []
      } catch (error) {
        return [error instanceof Error ? error.message : String(error)]
      }
    }

    const dismiss = async (view: RoundView) => {
      const entry = rounds().find((item) => item.view.roundID === view.roundID)
      if (!entry) return
      const confirmed = await context.ui.dialog.confirm({
        title: "Dismiss round?",
        message: "The agent gets a cancelled result for every question in this round.",
        label: { confirm: "Dismiss", cancel: "Keep" },
      })
      if (!confirmed) return
      await rpc.cancel({ roundID: view.roundID, reason: "user_closed" }, { location: entry.location }).catch(() => {})
      await refresh(entry.location)
      if (context.ui.panel.current()?.name === PANEL) context.ui.panel.close()
      showInline(view.sessionID, false)
    }

    const disposeSlot = context.ui.slot({
      append: "session.panel",
      render: (panel) => (
        <Show when={panel.name === PANEL}>
          <RoundPanel
            store={store}
            context={context}
            panel={panel}
            round={() => forSession(panel.sessionID)?.view}
            syntax={syntax}
            submit={submit}
            dismiss={dismiss}
          />
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

    return async () => {
      clearInterval(timer)
      stopEvents()
      stopReconnect()
      disposeSlot()
      disposeCard()
      disposeCommands()
      await Promise.all(
        locations().map((location) => rpc.attach({ clientID, detach: true }, { location }).catch(() => {})),
      )
      await context.renderer.idle().then(() => syntax.destroy())
    }
  },
})
