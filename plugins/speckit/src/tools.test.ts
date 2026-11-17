import { expect, test } from "bun:test"
import { readStartParams } from "./tools.ts"

test("speckit_start accepts a run root alone for resume, but needs a spec or a root", () => {
  expect(readStartParams({ root: "bd-1" }, "/w")).toEqual({ root: "bd-1", workspace: "/w" })
  expect(readStartParams({}, "/w")).toBe("spec or root is required")
})
