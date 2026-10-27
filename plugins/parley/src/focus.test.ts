import { expect, test } from "bun:test"
import { FocusGuard, INPUT_MODE } from "./focus.ts"

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
