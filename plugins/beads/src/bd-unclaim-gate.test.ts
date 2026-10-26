import { describe, expect, test } from "bun:test"

import { decideBdUnclaim, decideBdUnclaimParsed } from "./bd-unclaim-gate.ts"
import { parse } from "./shell.ts"
import { decideShell } from "./shell-gates.ts"
import { gateDeps } from "./test-support.ts"

const cause = "bd unclaim requires a non-empty --if-assignee compare-and-swap guard"
const resolution = "retry with `bd unclaim <id> --if-assignee <your actor>`"

function decision(command: string) {
  return decideBdUnclaimParsed(parse(command))
}

describe("bd unclaim gate", () => {
  test("refuses unguarded unclaim and force", () => {
    for (const command of ["bd unclaim bead-1", "bd unclaim bead-1 --force", "a && bd unclaim bead-1"]) {
      expect(decideBdUnclaim(command)?.block).toBe(true)
    }
  })

  test("requires a non-empty if-assignee value", () => {
    for (const command of [
      "bd unclaim bead-1 --if-assignee",
      "bd unclaim bead-1 --if-assignee=",
      'bd unclaim bead-1 --if-assignee ""',
    ]) {
      expect(decideBdUnclaim(command)?.block).toBe(true)
    }
  })

  test("allows both guarded spellings", () => {
    expect(decideBdUnclaim("bd unclaim bead-1 --if-assignee omp/main")).toBeUndefined()
    expect(decideBdUnclaim("bd unclaim bead-1 --if-assignee=omp/main")).toBeUndefined()
    expect(decideBdUnclaim("bd unclaim bead-1 --if-assignee omp/main --force")).toBeUndefined()
  })

  test("allows help without a guard", () => {
    expect(decision("bd unclaim --help")).toBeUndefined()
    expect(decision("bd unclaim -h")).toBeUndefined()
  })
  test("matches only the wrapper executable and recurses through nested wrappers", () => {
    expect(decideBdUnclaim("env printf bd unclaim bead-1")).toBeUndefined()
    for (const command of [
      "env -u A command -- bd unclaim bead-1",
      "command env bd unclaim bead-1",
      "env /opt/bin/bd unclaim bead-1",
      "command -- ./bd unclaim bead-1",
    ])
      expect(decideBdUnclaim(command)?.block).toBe(true)
  })

  test("finds wrapped bd unclaim inside command substitution and bash -c", () => {
    for (const command of [
      "echo $(env -u X bd unclaim bead-1)",
      "bash -c 'env -u X bd unclaim bead-1'",
      "sh -c 'command -- bd unclaim bead-1'",
    ])
      expect(decideBdUnclaim(command)?.block).toBe(true)
    expect(decideBdUnclaim("bash -c 'env -u X bd unclaim bead-1 --if-assignee actor/x'")).toBeUndefined()
  })

  test("does not treat a positional help argument after -- as help", () => {
    expect(decideBdUnclaim("bd unclaim bead-1 -- --help")?.block).toBe(true)
  })

  test("allows explicit help flags before the option terminator", () => {
    expect(decideBdUnclaim("bd unclaim --help bead-1")?.block).toBeUndefined()
    expect(decideBdUnclaim("bd unclaim --help -- bead-1")?.block).toBeUndefined()
  })
  test("ignores prose that is not a bd invocation", () => {
    for (const command of ["echo 'bd unclaim bead-1'", "printf '%s\\n' bd unclaim bead-1"]) {
      expect(decideBdUnclaim(command)).toBeUndefined()
    }
  })

  test("refuses malformed parsed command values without throwing", () => {
    for (const value of [null, undefined, {}, { unknown: true }, { unknown: false, commands: [], nested: [] }]) {
      expect(() => decideBdUnclaimParsed(value as never)).not.toThrow()
    }
  })

  test("the shell gate refuses with the standard cause and retry", async () => {
    const result = await decideShell("bd unclaim bead-1", "/tmp", gateDeps())
    expect(result).toEqual({ kind: "block", gate: "bd-unclaim-gate", cause, resolution })
  })
})
