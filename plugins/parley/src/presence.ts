const DEFAULT_WINDOW_MS = 30_000

interface Client {
  lastSeen: number
  sessionIDs?: readonly string[]
}

/** Heartbeat bookkeeping: which TUI clients have checked in recently at this location. */
export class Presence {
  readonly #clients = new Map<string, Client>()

  constructor(readonly windowMs = DEFAULT_WINDOW_MS) {}

  attach(clientID: string, now: number, sessionIDs?: readonly string[]) {
    this.#clients.set(clientID, sessionIDs === undefined ? { lastSeen: now } : { lastSeen: now, sessionIDs })
    this.prune(now)
  }

  detach(clientID: string) {
    this.#clients.delete(clientID)
  }

  /** A client counts when it was seen within the window and either lists no sessions or lists this one. */
  attached(now: number, sessionID?: string): boolean {
    for (const client of this.#clients.values()) {
      if (now - client.lastSeen > this.windowMs) continue
      if (sessionID === undefined || client.sessionIDs === undefined || client.sessionIDs.includes(sessionID))
        return true
    }
    return false
  }

  prune(now: number) {
    for (const [id, client] of this.#clients) if (now - client.lastSeen > this.windowMs) this.#clients.delete(id)
  }

  get size() {
    return this.#clients.size
  }
}
