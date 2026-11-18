import { expect, test } from "bun:test"
import { parseCommand } from "./command.ts"

test.each([
  ["", { kind: "status" }],
  ["   ", { kind: "status" }],
  [undefined, { kind: "status" }],
  ["off", { kind: "off" }],
  [" acme ", { kind: "bind", customer: "acme" }],
  ["acme-corp.eu_1", { kind: "bind", customer: "acme-corp.eu_1" }],
])("parses %p", (text, expected) => {
  expect(parseCommand(text)).toEqual(expected as never)
})

test.each(["--help", "-x", "a b", "acme; rm", "$(id)"])("rejects %p", (text) => {
  expect(parseCommand(text).kind).toBe("invalid")
})
