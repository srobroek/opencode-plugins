/** How recently the user must have pressed a key or clicked for a focus move to count as theirs (ms). */
export const DELIBERATE_MS = 400

/**
 * Keeps a parley card focused. The host can move focus to the prompt on its own (a session update,
 * a route change); such a move comes with no user input and is undone. A move right after a key or
 * click is the user's: the card lets go and shows how to come back until `reclaim`.
 */
export class FocusGuard {
  #lastInput = Number.NEGATIVE_INFINITY
  #released = false

  /** Records a key press or mouse event. */
  input(now: number) {
    this.#lastInput = now
  }

  get released() {
    return this.#released
  }

  /** Focus moved; `inside` says whether it is still in the card. Returns true to take it back. */
  moved(now: number, inside: boolean): boolean {
    if (inside) {
      this.#released = false
      return false
    }
    if (this.#released) return false
    if (now - this.#lastInput < DELIBERATE_MS) {
      this.#released = true
      return false
    }
    return true
  }

  /** The user asked to return (alt+p, /parley). */
  reclaim() {
    this.#released = false
  }
}
