import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { writeExecutable } from "@srobroek/opencode-lib/executable-fixture"
import { withActorPrefix } from "./shell-gates.ts"

const ACTOR = "opencode/ses_root/general/ses_child"

// A stand-in `bd` that prints the actor it resolves with bd's precedence: --actor, BEADS_ACTOR, BD_ACTOR.
const STUB_BD = `#!/bin/sh
actor="\${BEADS_ACTOR:-\${BD_ACTOR:-}}"
for arg in "$@"; do
  case "$prev" in --actor) actor=$arg ;; esac
  prev=$arg
done
printf 'actor=%s\\n' "$actor"
`

let bin: string
beforeAll(() => {
  bin = mkdtempSync(join(realpathSync(tmpdir()), "beads-stub-bd-"))
  writeExecutable(join(bin, "bd"), STUB_BD)
})
afterAll(() => rmSync(bin, { recursive: true, force: true }))

/** Run the prefixed command in a real /bin/sh whose server environment may carry an actor. */
function resolved(command: string, env: Record<string, string> = {}): string[] {
  const run = Bun.spawnSync(["/bin/sh", "-c", withActorPrefix(command, ACTOR)], {
    env: { PATH: `${bin}:${process.env.PATH}`, ...env },
  })
  expect(run.exitCode).toBe(0)
  return run.stdout
    .toString()
    .trim()
    .split("\n")
    .map((line) => line.replace("actor=", ""))
}

describe("the subagent actor prefix, run by a real shell", () => {
  test.each([
    ["a plain bd create", "bd create --title t", ACTOR],
    ["a later export BD_ACTOR", "export BD_ACTOR=x; bd create --title t", "x"],
    ["an assignment BD_ACTOR=x; export BD_ACTOR", "BD_ACTOR=x; export BD_ACTOR; bd create --title t", "x"],
    ["a command-local BEADS_ACTOR", "BEADS_ACTOR=y bd create --title t", "y"],
    ["a later export BEADS_ACTOR", "export BEADS_ACTOR=y; bd create --title t", "y"],
    ["an --actor flag", "bd --actor z create --title t", "z"],
    ["a shell function", "mk() { bd create --title \"$1\"; }; mk t", ACTOR],
    ["a pipeline", "bd create --title t | tail -1", ACTOR],
    ["a cd prefix", "cd / && bd create --title t", ACTOR],
  ])("%s", (_name, command, expected) => {
    expect(resolved(command)).toEqual([expected])
  })

  test("an inherited BEADS_ACTOR in the server environment does not beat the subagent actor", () => {
    expect(resolved("bd create --title t", { BEADS_ACTOR: "server/me" })).toEqual([ACTOR])
  })

  test("an inherited BD_ACTOR is replaced by the subagent actor", () => {
    expect(resolved("bd create --title t", { BD_ACTOR: "server/me" })).toEqual([ACTOR])
  })

  test("an actor with a quote survives", () => {
    const run = Bun.spawnSync(["/bin/sh", "-c", withActorPrefix("bd create", "it's")], {
      env: { PATH: `${bin}:${process.env.PATH}` },
    })
    expect(run.stdout.toString().trim()).toBe("actor=it's")
  })
})
