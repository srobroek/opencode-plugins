import { describe, expect, test } from "bun:test"
import {
  actorPresent,
  actorValues,
  agentActor,
  bdInvocations,
  decideActorGate,
  decideActorParsed,
  environmentForInput,
  extractCommand,
  firstBdVerb,
  invocationActor,
  isClaimCommand,
  isMutatingBdCommand,
} from "./bd-actor-gate.ts"
import { parse } from "./shell.ts"

const emptyEnv = {} as NodeJS.ProcessEnv
const actorEnv = { BEADS_ACTOR: "omp/GateBuilder/backlog" } as NodeJS.ProcessEnv

describe("extractCommand", () => {
  test("reads command then cmd", () => {
    expect(extractCommand({ command: "bd show x" })).toBe("bd show x")
    expect(extractCommand({ cmd: "bd list" })).toBe("bd list")
    expect(extractCommand({})).toBe("")
  })
})

describe("actorValues / environmentForInput", () => {
  test("returns the tool-level BD_ACTOR used by a claim without an id", () => {
    const env = environmentForInput({ env: { BD_ACTOR: "omp/Main/alias" } }, emptyEnv)
    expect(actorValues("bd ready --claim", env)).toEqual(["omp/Main/alias"])
  })

  test("parses canonical and legacy command-local assignments as one actor", () => {
    expect(
      actorValues("BEADS_ACTOR=omp/Main/release BD_ACTOR=omp/Main/release bd update bead-1 --if-assignee holder", {
        BEADS_ACTOR: "ambient/canonical",
        BD_ACTOR: "ambient/legacy",
      }),
    ).toEqual(["omp/Main/release"])
  })

  test.each([
    ["a backslash", "BEADS_ACTOR='a\\b' bd close x"],
    ["a NUL character", "BEADS_ACTOR=a\0b bd close x"],
    ["a dollar sign", 'BEADS_ACTOR="$WHO" bd close x'],
    ["an empty value", "BEADS_ACTOR= bd close x"],
  ])("does not count an actor holding %s", (_name, command) => {
    expect(actorValues(command, emptyEnv)).toEqual([])
  })

  test("returns each literal actor used by mutating invocations only", () => {
    expect(
      actorValues(
        "BEADS_ACTOR=omp/Main/a bd close a; export BD_ACTOR=omp/Main/b; bd update b --claim; bd show c",
        emptyEnv,
      ),
    ).toEqual(["omp/Main/a", "omp/Main/b"])
  })

  test("explicit --actor wins, then BEADS_ACTOR, then BD_ACTOR", () => {
    const ambient = { BD_ACTOR: "omp/Main/legacy", BEADS_ACTOR: "omp/Main/canonical" } as NodeJS.ProcessEnv
    expect(actorValues("bd --actor omp/Flag/explicit close x", ambient)).toEqual(["omp/Flag/explicit"])
    expect(actorValues("BEADS_ACTOR=omp/Inline/canonical bd close x", { BD_ACTOR: "omp/Main/legacy" })).toEqual([
      "omp/Inline/canonical",
    ])
    // bd 1.3 gives BEADS_ACTOR precedence even over a command-local BD_ACTOR.
    expect(actorValues("BD_ACTOR=omp/Inline/legacy bd close x", { BEADS_ACTOR: "omp/Main/canonical" })).toEqual([
      "omp/Main/canonical",
    ])
    expect(actorValues("bd close x", ambient)).toEqual(["omp/Main/canonical"])
    expect(actorValues("bd close x", { BD_ACTOR: "omp/Main/legacy" })).toEqual(["omp/Main/legacy"])
  })

  test("the invocation helper applies the same 1.3 precedence", () => {
    const invocation = bdInvocations("bd --actor omp/Flag/explicit close x")[0]
    expect(invocation).toBeDefined()
    if (invocation === undefined) return
    expect(invocationActor(invocation, { BEADS_ACTOR: "omp/Env/canonical", BD_ACTOR: "omp/Env/legacy" })).toBe(
      "omp/Flag/explicit",
    )
    expect(
      invocationActor(bdInvocations("BEADS_ACTOR=omp/Inline/canonical bd close x")[0] as never, { BD_ACTOR: "omp/Env/legacy" }),
    ).toBe("omp/Inline/canonical")
  })

  test("distinct invocations still report distinct actors", () => {
    // The plural name stays earned: one command line can carry several writes
    // under different identities. What is gone is two actors for ONE write.
    expect(actorValues("BD_ACTOR=omp/Main/a bd close a; BD_ACTOR=omp/Main/b bd update b --claim", emptyEnv)).toEqual([
      "omp/Main/a",
      "omp/Main/b",
    ])
  })
})

describe("agentActor", () => {
  test("names a subagent by root session, agent and its own session", () => {
    expect(agentActor({ sessionID: "ses_child", parentID: "ses_lead", rootID: "ses_root", agent: "build" })).toBe(
      "opencode/ses_root/build/ses_child",
    )
  })

  test("gives a main session no actor", () => {
    expect(agentActor({ sessionID: "ses_main", rootID: "ses_main", agent: "build" })).toBeUndefined()
    expect(agentActor(undefined)).toBeUndefined()
  })

  test("keeps the same agent distinct across sessions", () => {
    const one = agentActor({ sessionID: "ses_a", parentID: "ses_r", rootID: "ses_r", agent: "general" })
    const two = agentActor({ sessionID: "ses_b", parentID: "ses_r", rootID: "ses_r", agent: "general" })
    expect(one).not.toBe(two)
  })
})

describe("firstBdVerb / isMutatingBdCommand", () => {
  test("mutating verbs from hunt", () => {
    for (const v of [
      "assign x worker",
      "batch operations.json",
      "claim x",
      "close x",
      "comment x -m hi",
      "cook release",
      "create --title t",
      "create-form",
      "defer x",
      "delete x",
      "duplicate a b",
      "edit x",
      "forget foo",
      "import issues.jsonl",
      "link a b",
      "note x hi",
      "priority x 1",
      "promote x",
      "q task",
      "remember foo",
      "rename x y",
      "reopen x",
      "set-state x open",
      "ship capability",
      "supersede a b",
      "tag x blocked",
      "undefer x",
      "update x --status open",
      "comments add x --body hi",
      "dep add a b",
      "label add x foo",
      "mol pour x",
      "audit record --kind tool_call",
    ]) {
      expect(isMutatingBdCommand(`bd ${v}`)).toBe(true)
    }
  })

  test("read-only verbs never trigger", () => {
    for (const cmd of [
      "bd show chezmoi-2ji",
      "bd ready --unassigned --json",
      "bd list",
      "bd where",
      "bd comments chezmoi-7eg",
      "bd swarm validate",
      "echo hello",
      "git status",
    ]) {
      expect(isMutatingBdCommand(cmd)).toBe(false)
    }
  })

  test("grouped read actions and previews never trigger", () => {
    for (const cmd of [
      "bd mol list",
      "bd mol show mol-1",
      "bd mol current mol-1",
      "bd mol progress mol-1",
      "bd mol ready",
      "bd mol stale",
      "bd mol last-activity mol-1",
      "bd mol seed formula",
      "bd mol pour formula --dry-run",
      "bd mol wisp list",
      "bd mol --help",
      "bd dep tree x",
      "bd dep list x",
      "bd dep --help",
      "bd label list x",
      "bd label list-all",
      "bd label --help",
      "bd audit list",
      "bd audit --help",
      "bd gate list",
      "bd gate show gate-1",
      "bd todo list",
      "bd kv get key",
      "bd kv list",
      "bd duplicates",
      "bd duplicates --dry-run",
    ]) {
      expect(isMutatingBdCommand(cmd)).toBe(false)
    }
  })

  test("grouped write actions trigger", () => {
    for (const cmd of [
      "bd mol pour formula",
      "bd mol bond a b",
      "bd mol wisp formula",
      "bd mol wisp create formula",
      "bd mol wisp gc",
      "bd dep add a b",
      "bd dep relate a b",
      "bd dep remove a b",
      "bd label add x foo",
      "bd label propagate x foo",
      "bd label remove x foo",
      "bd audit record --kind tool_call",
      "bd audit label event-1 useful",
      "bd gate check",
      "bd gate resolve gate-1",
      "bd todo add task",
      "bd kv append key value",
      "bd kv delete key",
      "bd kv rm key",
      "bd kv set key value",
      "bd kv update key value",
      "bd duplicates --auto-merge",
      "bd todo done todo-1",
    ]) {
      expect(isMutatingBdCommand(cmd)).toBe(true)
    }
  })

  test("mentions and heredoc bodies are not invocations", () => {
    expect(isMutatingBdCommand("echo 'bd mol pour formula'")).toBe(false)
    expect(isMutatingBdCommand("cat <<'EOF'\nbd close x\nEOF")).toBe(false)
  })

  test("transparent wrappers retain real bd invocations", () => {
    expect(firstBdVerb("command bd close x")).toBe("close")
    expect(firstBdVerb("env FOO=1 bd close x")).toBe("close")
    expect(firstBdVerb("sudo -u build bd close x")).toBe("close")
    expect(isMutatingBdCommand("echo command bd close x")).toBe(false)
  })

  test("recognizes shell control prefixes around bd", () => {
    for (const command of [
      "! bd update bead-1 --claim",
      "time bd update bead-1 --claim",
      "if bd update bead-1 --claim; then :; fi",
      "while bd update bead-1 --claim; do :; done",
      "until bd update bead-1 --claim; do :; done",
    ]) {
      expect(firstBdVerb(command)).toBe("update")
      expect(isClaimCommand(command)).toBe(true)
    }
  })

  test("env child unsets override ambient actor variables", () => {
    for (const command of [
      "env -u BEADS_ACTOR -u BD_ACTOR bd update bead-1 --claim",
      "env --unset=BEADS_ACTOR --unset=BD_ACTOR bd create --title title",
      "env -i bd update bead-1 --claim",
    ]) {
      const decision = decideActorGate(command, actorEnv)
      expect(decision.kind).toBe("block")
      if (decision.kind === "block") expect(decision.reason).toContain("without BEADS_ACTOR or BD_ACTOR")
    }
  })

  test("env assignments after removal restore actor attribution", () => {
    for (const command of [
      "env -i BD_ACTOR=actor/x bd update bead-1 --claim",
      "env -u BEADS_ACTOR BEADS_ACTOR=actor/x bd create --title title",
    ]) {
      expect(decideActorGate(command, actorEnv)).toEqual({ kind: "allow" })
    }
  })

  test("comments without add is read-only", () => {
    expect(firstBdVerb("bd comments chezmoi-7eg")).toBe("comments")
    expect(isMutatingBdCommand("bd comments chezmoi-7eg")).toBe(false)
  })
})

describe("actorPresent", () => {
  test("prefix in command string", () => {
    expect(actorPresent("BEADS_ACTOR=omp/x/y bd update z --claim", emptyEnv)).toBe(true)
  })
  test("process env", () => {
    expect(actorPresent("bd close z", actorEnv)).toBe(true)
  })
  test("absent", () => {
    expect(actorPresent("bd close z", emptyEnv)).toBe(false)
  })
  test("exported earlier on the same command line", () => {
    expect(actorPresent("cd /repo && export BEADS_ACTOR=omp-main && bd close z", emptyEnv)).toBe(true)
  })
  test("an unexported assignment in an earlier segment never reaches bd", () => {
    expect(actorPresent("BEADS_ACTOR=omp-main; bd close z", emptyEnv)).toBe(false)
  })
})

describe("isClaimCommand", () => {
  test("update --claim", () => {
    expect(isClaimCommand("bd update chezmoi-2ji --claim")).toBe(true)
  })
  test("bd claim", () => {
    expect(isClaimCommand("bd claim chezmoi-2ji")).toBe(true)
  })
  test("update without claim flag", () => {
    expect(isClaimCommand("bd update chezmoi-2ji --status open")).toBe(false)
  })
  test("quoted claim text does not turn another write into a claim", () => {
    expect(isClaimCommand("bd create --title 'bd update x --claim'")).toBe(false)
  })
})

describe("decideActorGate", () => {
  test("blocks claim without actor", () => {
    const d = decideActorGate("bd update chezmoi-2ji --claim", emptyEnv)
    expect(d.kind).toBe("block")
  })
  test("blocks boolean claim flags without actor", () => {
    for (const command of ["bd update chezmoi-2ji --claim=true", "bd ready --claim=1"]) {
      expect(decideActorGate(command, emptyEnv).kind).toBe("block")
    }
  })
  test("allows claim with actor env", () => {
    expect(decideActorGate("bd update chezmoi-2ji --claim", actorEnv).kind).toBe("allow")
  })
  test("allows claim with command prefix", () => {
    expect(decideActorGate("BEADS_ACTOR=omp/x/y bd update chezmoi-2ji --claim", emptyEnv).kind).toBe("allow")
  })
  test("advisory for other mutating without actor", () => {
    const d = decideActorGate("bd close chezmoi-2ji", emptyEnv)
    expect(d.kind).toBe("advisory")
  })
  test("blocks create without actor", () => {
    const d = decideActorGate("bd create --title 'new bead'", emptyEnv)
    expect(d.kind).toBe("block")
    if (d.kind === "block") {
      expect(d.reason).toContain("created_by")
      expect(d.reason).toContain("Owner is always")
      expect(d.reason).toContain("<harness>/<agent-name>/<session-id>")
    }
  })
  test("refusal says the plugin supplies a subagent's actor, not that the agent must", () => {
    const d = decideActorGate("BEADS_ACTOR=$A bd create --title x", emptyEnv)
    expect(d.kind).toBe("block")
    if (d.kind === "block") {
      expect(d.reason).toContain("Subagent sessions get BD_ACTOR from the plugin")
      expect(d.reason).not.toContain("Set either variable")
    }
  })
  test("allows create with actor", () => {
    expect(decideActorGate("bd create --title 'new bead'", actorEnv).kind).toBe("allow")
  })
  test("blocks every verb that constructs an issue, not just `create`", () => {
    // `bd create --help` reports "Aliases: create, new", and `create-form` is
    // the interactive form over the same path. Each needs an attributable
    // created_by before the issue is written.
    for (const command of ["bd new --title 'new bead'", "bd create-form"]) {
      const d = decideActorGate(command, emptyEnv)
      expect(d.kind).toBe("block")
      if (d.kind === "block") expect(d.reason).toContain("created_by")
    }
  })
  test("allows `bd new` when an actor is present", () => {
    expect(decideActorGate("bd new --title 'new bead'", actorEnv).kind).toBe("allow")
  })
  test("allow read-only even without actor", () => {
    expect(decideActorGate("bd show chezmoi-2ji", emptyEnv).kind).toBe("allow")
    expect(decideActorGate("bd comments chezmoi-7eg", emptyEnv).kind).toBe("allow")
  })
  test("allow mutating when actor present", () => {
    expect(decideActorGate("bd close x", actorEnv).kind).toBe("allow")
  })
})

describe("integration", () => {
  test("decides claim-shaped bash and advisories without a migrated tool_call registration", () => {
    expect(decideActorGate("bd update chezmoi-2ji --claim", emptyEnv)).toEqual(
      expect.objectContaining({ kind: "block", reason: expect.stringContaining("BEADS_ACTOR") }),
    )
    expect(decideActorGate("bd show x", emptyEnv).kind).toBe("allow")
    expect(decideActorGate("bd close x", { BD_ACTOR: "omp/x/y" } as NodeJS.ProcessEnv).kind).toBe("allow")
    expect(decideActorGate("bd close x", emptyEnv).kind).toBe("advisory")
  })
})

describe("export in an earlier segment", () => {
  test("a mutation after an export raises no advisory", () => {
    expect(
      decideActorGate("cd /repo && export BEADS_ACTOR=omp-main && bd close chezmoi-2ji --reason done", emptyEnv).kind,
    ).toBe("allow")
  })
  test("the legacy actor export also attributes later mutations", () => {
    expect(decideActorGate("export BD_ACTOR=omp/x/y && bd close chezmoi-2ji", emptyEnv).kind).toBe("allow")
  })
  test("a claim after an export is allowed", () => {
    expect(decideActorGate("export BEADS_ACTOR=omp/x/y && bd update chezmoi-2ji --claim", emptyEnv).kind).toBe("allow")
  })
  test("a claim after an export of something else is still blocked", () => {
    expect(decideActorGate("export OTHER=1 && bd update chezmoi-2ji --claim", emptyEnv).kind).toBe("block")
  })
  test("an export after the bd command does not count", () => {
    expect(decideActorGate("bd close chezmoi-2ji && export BEADS_ACTOR=omp-main", emptyEnv).kind).toBe("advisory")
  })
})

describe("here-documents", () => {
  test("a commit message that mentions bd close is not a bd command", () => {
    const command = "git commit -q -F - <<'EOF'\nfix: x\n\nafter that, bd close y and bd update z --claim.\nEOF"
    expect(decideActorGate(command, emptyEnv).kind).toBe("allow")
  })
})

describe("the actor gate reads the parsed command", () => {
  const decide = (command: string, env = emptyEnv) => decideActorParsed(parse(command), env).kind

  test.each([
    ["a brace group", "{ bd create x; }"],
    ["an unset after the export", "export BEADS_ACTOR=x; unset BEADS_ACTOR; bd create y"],
    ["a fabricated export from echo arguments", 'echo ";" export "BEADS_ACTOR=x" ; bd create y'],
    ["a create inside a quoted substitution", 'echo "$(bd create "a (b)")"'],
    ["a create behind command --", "command -- bd create y"],
    ["an expanding export", 'export BEADS_ACTOR="$FOO"; bd create y'],
    ["a quoted heredoc fed to bash", "bash <<'EOF'\nbd create y\nEOF"],
    ["a heredoc fed to bash -s", "bash -s <<'EOF'\nbd create y\nEOF"],
    ["a here-string fed to sh", "sh <<< 'bd create y'"],
    ["a create in a parameter default", `echo "\${X:-'$(bd create y)'}"`],
  ])("refuses a create after %s", (_name, command) => {
    expect(decide(command)).toBe("block")
  })

  test.each([
    ["an export joined by &&", "export BEADS_ACTOR=x && bd create y"],
    ["an export before a subshell", "export BEADS_ACTOR=x; (bd create y)"],
    ["an export before a brace group", "export BEADS_ACTOR=x; { bd create y; }"],
    ["an export on an earlier line", "export BEADS_ACTOR=x\nbd create y"],
    ["an export of a quoted literal", "export BEADS_ACTOR='omp/a b/c'; bd create y"],
    ["an export among other exports", "export FOO=1 BEADS_ACTOR=x; bd create y"],
    ["a legacy export", "export BD_ACTOR=x; bd create y"],
    ["an export that a quoted title mentions", 'export BEADS_ACTOR=x; bd create --title "source and unset"'],
    ["a create in a substitution after an export", "export BEADS_ACTOR=x; id=$(bd create y --json)"],
    ["a prefix assignment after an unset", "unset BEADS_ACTOR; BEADS_ACTOR=x bd create y"],
    ["a prefix assignment behind command --", "BEADS_ACTOR=x command -- bd create y"],
    ["a quoted create in a comment argument", 'BEADS_ACTOR=a/b/c bd comments add p-1 "fix; say retry; bd create x"'],
    ["a quoted create without any actor", 'bd comments add p-1 "bd create foo"'],
    ["a heredoc that bash -c ignores", "bash -c 'true' <<'EOF'\nbd create y\nEOF"],
    ["a heredoc that a script operand ignores", "bash script.sh <<'EOF'\nbd create y\nEOF"],
  ])("allows %s", (_name, command) => {
    expect(decide(command)).not.toBe("block")
  })

  test("an ambient actor attributes the create", () => {
    expect(decide("bd create y", actorEnv)).toBe("allow")
    expect(decide("id=$(bd create y --json)", actorEnv)).toBe("allow")
  })
})

describe("bdInvocations reads substitutions and stdin scripts", () => {
  test("a bd write inside an executable substitution is an invocation", () => {
    expect(bdInvocations("id=$(bd create y --json)").map((invocation) => invocation.verb)).toEqual(["create"])
  })

  test("stdin is a script only when the interpreter reads it", () => {
    const verbs = (command: string) => bdInvocations(command).map((invocation) => invocation.verb)
    expect(verbs("bash <<'EOF'\nbd create y\nEOF")).toEqual(["create"])
    expect(verbs("bash -s -- a <<'EOF'\nbd create y\nEOF")).toEqual(["create"])
    expect(verbs("bash -c 'true' <<'EOF'\nbd create y\nEOF")).toEqual([])
    expect(verbs("bash -lc 'true' <<'EOF'\nbd create y\nEOF")).toEqual([])
    expect(verbs("bash script.sh <<'EOF'\nbd create y\nEOF")).toEqual([])
    expect(verbs("bash -o pipefail <<'EOF'\nbd create y\nEOF")).toEqual(["create"])
  })
})
