# Contracts, stubs and swaps

When workstreams run in parallel and one task needs another workstream's
unfinished work, use this pattern. The commands and edge directions match
bd 1.3.1.

A `blocks` edge hides its dependent from `bd ready`. When every cross-workstream
dependency is a hard edge, the programme runs one step at a time. Split each
dependency by what it needs:

- A dependency on a contract stays a hard `blocks` edge. No stub can replace a contract.
- A dependency on an implementation behind a contract becomes a soft `related`
  link. A stub that passes the contract's conformance runner stands in for the
  implementation, and a swap bead tracks its replacement.

At planning time, wire the beads this way. Never file T with a hard edge on B
and convert the edge later. The retrofit steps below are only for a plan that
already has the hard edge.

## What a contract is

A contract bead is done when all six of these exist:

1. **The specification.** A machine-readable schema (for example JSON Schema,
   Protobuf or an IDL), a typed interface in the shared language, or a written
   spec for behavior that a schema cannot express.
2. **Conformance fixtures.**
   - Valid cases that every implementation accepts.
   - Invalid cases that every implementation rejects. Map each case to the
     place where it fails, for example a JSON pointer or an error code.
   - For behavior, input and expected-output pairs.
   Example: `fixtures/valid/*.json` and `fixtures/invalid/*.json`, each invalid
   file paired with the JSON pointer its validator must report.
3. **Interaction transcripts, for a protocol** (RPC, messages, CLI to plugin,
   client to server). Record request and response or message sequences as
   fixtures in the repository. Replay each one against the provider to check its
   responses, and against the consumer to check the requests it sends. Example:
   a JSON-RPC transcript of `initialize`, one call and `shutdown`, stored as
   newline-delimited JSON. This needs no contract broker.
4. **A conformance runner.** One test entry point. It accepts any implementation
   (a stub, the real one, or another language's SDK) and runs every fixture and
   transcript against it. Every implementation runs this same runner.
5. **Shared types, where the language allows.** Generate types from the schema,
   or keep one shared types module that both sides import. Stubs and real code
   use these types. Local copies are not allowed.
6. **A staleness check.** CI fails when anything generated from the contract
   (types, docs, fixtures) is out of date with it. Example: regenerate the types,
   then fail on `git diff --exit-code`.

## The four beads

| Bead | What it is | Owner |
| --- | --- | --- |
| **C**, contract | The six items above, for one schema. | The producer's workstream |
| **B**, producer | The real implementation of C. It passes C's conformance runner. | The producer's workstream |
| **T**, consumer | The task that needs B, built against a stub that passes C's runner. Label: `soft-blocked`. | The consumer's workstream |
| **S**, swap | Replaces T's stub with the real B. Label: `stub`. Parent: the consumer's epic. | The consumer's workstream |

## The edges

`bd dep add X Y` means X depends on Y. Y blocks X, and X stays out of `bd ready`
until Y closes. With no `--type`, the edge is `blocks`.

Add exactly these five edges:

| # | Edge | Type | Command | Reason |
| --- | --- | --- | --- | --- |
| 1 | T depends on C | hard | `bd dep add T C` | T needs the contract and its runner to build a conforming stub. |
| 2 | B depends on C | hard | `bd dep add B C` | B implements C and must pass its runner. |
| 3 | S depends on B | hard | `bd dep add S B` | S has nothing to swap in until B is real. |
| 4 | S depends on T | hard | `bd dep add S T` | S has nothing to replace until T's stub lands. |
| 5 | T related to B | soft | `bd dep add T B --type related` | Records the link and keeps T in `bd ready`. |

T and B have no hard edge between them. If a hard edge exists, run
`bd dep remove T B` first. Use `--type related`, not `bd dep relate`: that command
writes a different type, `relates-to`.

```text
                 C  contract (spec + fixtures + transcripts + runner + types)
               /    \
       hard (1)      hard (2)
             v        v
   consumer  T ······ B  producer
                (5) related, soft
             |        |
       hard (4)      hard (3)
             v        v
                 S  swap (label: stub)
```

C lands first. Then T and B run in parallel, and both run C's runner. S becomes
ready when T and B both close.

## Plan the pattern in one graph

File the four beads and five edges in one `bd create --graph` plan, under the
BATCHED CREATION and GRAPH PLAN SCHEMA rules in `SKILL.md`. Replace the parent
ids with your epics and add the acceptance and metadata that `SKILL.md` requires:

```json
{
  "nodes": [
    {"key": "C", "parent_id": "<producer-epic>", "type": "task", "priority": 1, "labels": ["contract"],
     "title": "Contract: <schema, protocol or interface>",
     "acceptance_criteria": "Spec; valid and invalid fixtures with failure locations; transcripts for each protocol exchange; one conformance runner that accepts any implementation; shared or generated types; a CI staleness check.",
     "metadata": {"execution_agent_type": "implementer-high"}},
    {"key": "B", "parent_id": "<producer-epic>", "type": "task", "title": "<real implementation>",
     "acceptance_criteria": "Passes C's conformance runner in CI.",
     "metadata": {"execution_agent_type": "implementer"}},
    {"key": "T", "parent_id": "<consumer-epic>", "type": "task", "labels": ["soft-blocked"], "title": "<consumer task>",
     "acceptance_criteria": "Built against a stub that uses C's types and passes C's runner; each stub carries a STUB(<S-id>) marker.",
     "metadata": {"execution_agent_type": "implementer"}},
    {"key": "S", "parent_id": "<consumer-epic>", "type": "task", "labels": ["stub"], "title": "Replace <stub> with <real B>",
     "acceptance_criteria": "Real B wired in place of the stub; B passes C's runner; T's tests pass against B; git grep 'STUB(<S-id>)' is empty.",
     "metadata": {"execution_agent_type": "implementer"}}
  ],
  "edges": [
    {"from_key": "T", "to_key": "C", "type": "blocks"},
    {"from_key": "B", "to_key": "C", "type": "blocks"},
    {"from_key": "S", "to_key": "B", "type": "blocks"},
    {"from_key": "S", "to_key": "T", "type": "blocks"},
    {"from_key": "T", "to_key": "B", "type": "related"}
  ]
}
```

The dry run reports `would create 4 issue(s) and 5 edge(s) (4 parent-child link(s))`.
S's id exists only after the create, so write the stub markers when T's work starts.

## Step by step

**When no contract exists:**

- File C under the producer's epic. Its acceptance is the six items in
  "What a contract is". Its runner must accept more than one implementation.
- Keep each C to one schema, protocol or interface, at high priority. Contract
  beads gate the most parallel work.
- A consumer with no contract to use can write C as a proposal. The
  producer's owner signs it off.

**When you start T:**

1. Check that edge 1 exists and that `bd show C` reports `closed`. If C is open, T cannot start.
   Work on C or on other ready work.
2. Build T against a stub. The code-level rules for writing and testing it
   (shared types, conformance runner) are in the `quality-code-design` and
   `quality-testing` skills.
3. Mark every stub with a greppable marker that names S:
   `// STUB(<S-id>): what this fakes`. Use `#` in Python, TOML and YAML.
   A real marker holds a bead id, so `git grep -E 'STUB\([A-Za-z0-9._-]+\)'`
   finds real markers and skips placeholders such as `STUB(<S-id>)` in docs.

**When the plan wired T to B with a hard edge (retrofit only):**

1. Check that `bd dep list T` and `bd dep list B` both show C `via blocks`. Add a
   missing edge with `bd dep add T C` or `bd dep add B C`.
2. Run `bd dep remove T B`.
3. File S:
   `bd create "Replace <stub> with <real B>" --type task --labels stub --parent <consumer-epic> --metadata '{"execution_agent_type":"implementer"}' --description "<where the stub lives, what it fakes, which runner covers it>" --acceptance "Real B wired in place of the stub; B passes C's runner; T's tests pass against B; no STUB(<S-id>) markers remain."`
4. Add edges 3, 4 and 5: `bd dep add S B`, `bd dep add S T`,
   `bd dep add T B --type related`.
5. Run `bd label add T soft-blocked` and
   `bd comments add T "Soft-blocked on B; built against STUB(<S-id>), conforming to C"`.

When you retrofit more than one pair, put the edge changes in one `bd batch`.
Put the new swap beads in one graph plan, as `SKILL.md` requires.

**When T's PR lands:** close T and keep its `soft-blocked` label. S tracks the rest.

**When B closes:** check that B's PR ran C's conformance runner. After T also
closes, S is ready. At that point, start S (see "Keep swaps moving").

**When S's PR lands:**

1. Check that `git grep 'STUB(<S-id>)'` returns nothing and that T's tests passed
   against the real B.
2. Close S.
3. Run `bd label remove T soft-blocked`.

The stub and B passed the same runner, so the swap changes only wiring. If it
needs more, C had a gap. Fix C with a fixture that captures the gap.

**Release gate:**

- `bd list --label stub --status open,in_progress,blocked,deferred` is empty.
  The list covers every status except `closed`, and it includes split stub
  beads that leave no marker in code.
- `git grep -E 'STUB\([A-Za-z0-9._-]+\)'` finds no marker.
  Check both: a closed swap bead can leave a marker behind.
- The staleness check of every contract passes.
- A release-gate bead queries the `stub` label. Do not give it hard edges to each
  S: a hand-kept list goes stale.

## Rules

- **Stub only against a closed contract bead (edge 1).** With no contract, write C first.
- **Code-level stub rules live in the quality skills.** See `quality-code-policy`
  (when to stub, never across a recorded decision) and `quality-code-design`.
- **Each marker names exactly one swap bead.** One swap bead covers one or more markers.
- **Point edge 3 at the bead that delivers what S needs.** When S needs one
  specific change, point edge 3 at that change's bead, not at a broad epic.
  An example is a schema update that accepts a new value. A broad edge makes S
  ready before it can work. Re-point it with `bd dep remove S <old>` and `bd dep add S <new>`.
- **Split acceptance across workstreams.** When part of a bead's acceptance needs
  feature F from another workstream:
  1. Move that part to a new `stub` bead S′.
  2. Add `bd dep add S′ F` and `bd dep add S′ <original>`. The second edge
     keeps S′ out of `bd ready` until the original bead closes.
  3. Close the original bead on the rest of its acceptance.
- **Respect ownership.** One workstream owns the shared core types. One
  workstream owns the CLI or entry point. Other workstreams expose library
  functions, plus a small entry hook where the framework needs one. The owner
  wires them in. To change a shared type, a workstream codes against a local
  interface and files a `stub` bead. The workstream sends the owner the change
  as a contract change.

## Contract changes

- **Make additive changes only, with the owner's sign-off.** Every existing valid
  fixture and transcript stays valid. Add fixtures for each new field or message.
  Regenerate the generated outputs in the same PR. The staleness check enforces this.
- **File a breaking change as a new contract bead C2.** Do not edit C in place.
  File one swap bead S2 for each affected stub, with `bd dep add S2 C2` and edges
  3 and 4 as before. Run every implementation, stubs included, against C2's runner.
- **When only one implementation passes a fixture, compare the fixture with C's
  specification.** If the fixture matches the specification, fix the failing
  implementation. If it does not, fix C. Never special-case one implementation.

## Keep swaps moving

- **After you close any C, B or T, run `bd ready --label stub`** for the affected
  workstreams. Then start each ready swap bead. In one programme of about 15
  parallel epics, 24 swap beads became ready together. They stayed idle while
  orchestrators with free writer slots ended their turns to wait on CI.
- **Before you end a turn, give ready work to each idle writer.** While CI runs
  or a review is open, start ready work.
- **When another workstream blocks you, keep one long-interval background watch**
  on the blocking PR or bead. The watch wakes the agent when the blocker lands.
- **Track the trend of open stubs, not only the count.** The count can rise while
  swaps land, because new work files new stubs. Record the count from
  `bd list --label stub --status open,in_progress,blocked,deferred --limit 0 --json | jq length` for each workstream in its readiness note.
  Without `--limit 0`, `bd list` returns at most 50 beads.

When a stub, swap or contract misbehaves, read [pitfalls.md](pitfalls.md).
