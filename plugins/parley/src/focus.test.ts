import { expect, test } from "bun:test"
import { DELIBERATE_MS, FocusGuard } from "./focus.ts"

test("focus moved without input is taken back", () => {
  const guard = new FocusGuard()
  expect(guard.moved(1000, false)).toBe(true)
  expect(guard.released).toBe(false)
})

test("focus moved right after a key or click is the user's until reclaimed", () => {
  const guard = new FocusGuard()
  guard.input(1000)
  expect(guard.moved(1000 + DELIBERATE_MS - 1, false)).toBe(false)
  expect(guard.released).toBe(true)
  expect(guard.moved(5000, false)).toBe(false)
  guard.reclaim()
  expect(guard.released).toBe(false)
  expect(guard.moved(9000, false)).toBe(true)
})

test("focus coming back into the card clears the release", () => {
  const guard = new FocusGuard()
  guard.input(0)
  guard.moved(1, false)
  expect(guard.moved(2, true)).toBe(false)
  expect(guard.released).toBe(false)
})
