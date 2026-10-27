/** Parley owns keyboard dispatch while its card/panel is shown; base prompt bindings are inactive. */
export const INPUT_MODE = "srobroek.parley"

/** One input-mode lease per mounted surface, renewed by the explicit recovery command. */
export class FocusGuard {
  #release: (() => void) | undefined

  constructor(readonly push: (mode: string) => () => void) {}

  get active() { return this.#release !== undefined }

  acquire() {
    if (!this.#release) this.#release = this.push(INPUT_MODE)
  }

  /** A click on the prompt cannot hand away ownership while the surface is open. */
  moved(inside: boolean) { return this.active && !inside }

  reclaim() {
    this.release()
    this.acquire()
  }

  release() {
    const release = this.#release
    this.#release = undefined
    release?.()
  }
}
