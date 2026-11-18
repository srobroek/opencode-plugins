/**
 * The TUI side of the announcements, apart from the host: it toasts each new finding once per
 * instance, counts the unseen ones for the badge, and marks findings seen. `tui.tsx` only wires
 * it to the RPC, the toast and a signal.
 */

import { type Finding, readFindings, toastKey, toastText, unseen } from "./announce.ts"

export type AnnouncementsPorts = {
  /** The server's unseen findings. */
  fetch: () => Promise<unknown>
  /** Marks one tier and agent seen on the server. */
  seen: (tier: string, agent: string) => Promise<unknown>
  toast: (message: string) => void
}

export function createAnnouncements(ports: AnnouncementsPorts, onChange: (count: number) => void = () => {}) {
  /** Toasted by this instance; a toast marks a finding toasted, never seen. */
  const toasted = new Set<string>()
  let findings: Finding[] = []
  const set = (next: Finding[]) => {
    findings = next
    onChange(unseen(findings).length)
  }
  return {
    /** Fetches the unseen findings and shows one toast per finding not toasted yet. A failed fetch keeps what is shown. */
    async refresh(): Promise<void> {
      let next: Finding[]
      try {
        next = unseen(readFindings(await ports.fetch()))
      } catch {
        return
      }
      set(next)
      for (const f of next) {
        const key = toastKey(f)
        if (toasted.has(key)) continue
        toasted.add(key)
        ports.toast(toastText(f))
      }
    },
    /** Opening a tier's detail, a dismissal or an adoption: the tier's (or one agent's) findings are seen. */
    async markSeen(tier: string, agent?: string): Promise<void> {
      const mine = findings.filter((f) => f.tier === tier && (agent === undefined || f.agent === agent))
      if (mine.length === 0) return
      set(findings.filter((f) => !mine.includes(f)))
      for (const f of mine) await ports.seen(f.tier, f.agent).catch(() => {})
    },
    /** Unseen findings of one tier. */
    forTier: (tier: string) => findings.filter((f) => f.tier === tier),
    count: () => findings.length,
  }
}

export const DISMISS_PREFIX = "\u0000dismiss:"

/** One "Dismiss" row per agent with an unseen finding in the tier. */
export const dismissRows = (agents: readonly string[]) =>
  agents.map((agent) => ({ title: `Dismiss announcement (${agent})`, value: `${DISMISS_PREFIX}${agent}`, description: "Clear it from the tiers badge" }))
