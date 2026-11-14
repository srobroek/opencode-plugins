import { expect, test } from "bun:test"
import { BASE_MODE, FocusGuard, INPUT_MODE } from "./focus.ts"

/** The host's mode stack (OpenCode keymap.tsx createMode): the newest pushed mode owns input. */
function hostModes() {
  const stack: string[] = []
  return {
    stack,
    current: () => stack.at(-1) ?? BASE_MODE,
    push: (mode: string) => {
      stack.push(mode)
      return () => { stack.splice(stack.lastIndexOf(mode), 1) }
    },
  }
}

test("initial open owns input once, blocking prompt keymaps as well as native focus", () => {
  const modes: string[] = []
  const guard = new FocusGuard((mode) => { modes.push(mode); return () => { modes.pop() } })
  expect(guard.active).toBe(false)
  guard.acquire()
  guard.acquire()
  expect(modes).toEqual([INPUT_MODE])
  expect(guard.active).toBe(true)
  expect(guard.moved(false)).toBe(true)
  expect(guard.moved(true)).toBe(false)
})

test("prompt clicks and keys cannot release an open card's input ownership", () => {
  const guard = new FocusGuard(() => () => {})
  guard.acquire()
  for (const _key of ["down", "up", "tab", "shift+tab", "z", "return", "mouse"]) {
    expect(guard.moved(false)).toBe(true)
    expect(guard.active).toBe(true)
  }
})

test("alt+p recovery renews the lease, and close/submit/dismiss release it exactly once", () => {
  let pushed = 0
  let popped = 0
  const guard = new FocusGuard(() => { pushed++; return () => { popped++ } })
  guard.acquire()
  guard.reclaim()
  expect(pushed).toBe(2)
  expect(popped).toBe(1)
  expect(guard.moved(false)).toBe(true)
  guard.release()
  guard.release()
  expect(popped).toBe(2)
  expect(guard.active).toBe(false)
  expect(guard.moved(false)).toBe(false)
})

test("a host confirmation dialog temporarily owns input, then the surviving card reacquires", () => {
  const stack: string[] = []
  const guard = new FocusGuard((mode) => { stack.push(mode); return () => { stack.pop() } })
  guard.acquire()
  guard.release()
  expect(stack).toEqual([])
  expect(guard.moved(false)).toBe(false)
  guard.acquire()
  expect(stack).toEqual([INPUT_MODE])
  expect(guard.moved(false)).toBe(true)
})

test("another plugin's select dialog owns focus and keys while open, then the card takes focus back", () => {
  const host = hostModes()
  const guard = new FocusGuard(host.push, host.current)
  guard.acquire()
  // The host dialog pushes its modal mode; its search input focuses outside the card.
  const closeDialog = host.push("modal")
  expect(guard.yielding).toBe(true)
  // Typed keys and Esc stay with the dialog: parley neither pulls focus nor holds the active mode.
  expect(guard.moved(false)).toBe(false)
  expect(host.current()).toBe("modal")
  // The card stays shown: its lease waits beneath the dialog, so the prompt never gets the keys.
  expect(guard.active).toBe(true)
  expect(host.stack).toEqual([INPUT_MODE, "modal"])
  closeDialog()
  expect(guard.yielding).toBe(false)
  expect(host.current()).toBe(INPUT_MODE)
  expect(guard.moved(false)).toBe(true)
})

test("a recovery request while a host dialog is open never lifts parley's lease above the dialog", () => {
  const host = hostModes()
  const guard = new FocusGuard(host.push, host.current)
  guard.acquire()
  const closeDialog = host.push("modal")
  guard.reclaim()
  expect(host.stack).toEqual([INPUT_MODE, "modal"])
  closeDialog()
  expect(host.stack).toEqual([INPUT_MODE])
})

test("a surface that mounts under a host dialog takes its lease only after the dialog closes", () => {
  const host = hostModes()
  const closeDialog = host.push("modal")
  const guard = new FocusGuard(host.push, host.current)
  guard.acquire()
  expect(host.stack).toEqual(["modal"])
  expect(guard.moved(false)).toBe(false)
  closeDialog()
  guard.resume()
  guard.resume()
  expect(host.stack).toEqual([INPUT_MODE])
  expect(guard.moved(false)).toBe(true)
})

test("a lease released while a host dialog is open is not taken again when it closes", () => {
  const host = hostModes()
  const closeDialog = host.push("modal")
  const guard = new FocusGuard(host.push, host.current)
  guard.acquire()
  guard.release()
  closeDialog()
  guard.resume()
  expect(host.stack).toEqual([])
})
