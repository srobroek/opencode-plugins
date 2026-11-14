/** Parley owns keyboard dispatch while its card/panel is shown; base prompt bindings are inactive. */
export const INPUT_MODE = "srobroek.parley"

/** The host's mode when no input mode is pushed: the prompt's own bindings. */
export const BASE_MODE = "base"

/**
 * True when a mode pushed after parley's owns input, such as the `modal` mode an OpenCode
 * dialog pushes while open. Parley's lease then waits beneath it and the dialog's keys stay its own.
 */
export const foreignMode = (current: string) => current !== INPUT_MODE && current !== BASE_MODE

/** One input-mode lease per mounted surface, renewed by the explicit recovery command. */
export class FocusGuard {
  #release: (() => void) | undefined
  #wanted = false

  constructor(
    readonly push: (mode: string) => () => void,
    readonly current: () => string = () => BASE_MODE,
  ) {}

  get active() { return this.#release !== undefined }

  /** A host dialog (or another plugin's input mode) owns input: take neither focus nor the lease. */
  get yielding() { return foreignMode(this.current()) }

  /** A lease pushed under an open dialog would sit above it and take its keys, so it waits for `resume`. */
  acquire() {
    this.#wanted = true
    if (!this.#release && !this.yielding) this.#release = this.push(INPUT_MODE)
  }

  /** Takes the lease a surface asked for while a dialog was open, once nothing owns input above it. */
  resume() {
    if (this.#wanted) this.acquire()
  }

  /** A click on the prompt cannot hand away ownership while the surface is open; a host dialog can. */
  moved(inside: boolean) { return this.active && !inside && !this.yielding }

  /** Under a dialog the lease keeps its place beneath it; re-pushing would lift it above the dialog. */
  reclaim() {
    if (this.yielding) return this.acquire()
    this.release()
    this.acquire()
  }

  release() {
    const release = this.#release
    this.#release = undefined
    this.#wanted = false
    release?.()
  }
}
