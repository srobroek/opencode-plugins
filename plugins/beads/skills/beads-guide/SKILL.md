---
name: beads-guide
description: "Use for Beads: planning beads or dependencies, stubs, init, remotes, BEADS_DIR, separate ledger, preflight, closing."
---

# Beads guide

This guide only routes. Before you answer or act, load the matching skill with the skill
tool, by id, in this same turn, and every other row the task spans. Answer from the loaded
skill, not from this table.

| Situation | Load skill |
| --- | --- |
| A repo without `.beads/`, ledger clones, git/Dolt remotes, or `no beads database found` | `beads-setup` |
| `BEADS_DIR` or a ledger outside the checkout ([Project ledger store](../../README.md#project-ledger-store)) | `beads-setup` |
| Starting ledger work, or asked for a beads preflight (read-only readiness checks) | `beads-preflight` |
| Creating, planning or bulk-editing beads: acceptance, metadata, routing, deps | `beads-ledger` |
| A task that depends on another workstream's unfinished work: contracts, stubs, swap beads, soft blocks | `beads-ledger` |
| Closing or reviewing a bead: the evidence a close needs | `beads-evidence` |
| `lock busy`, `workspace gate busy` or a failed `bd dolt pull`/`push` | `beads-contention-retry` |

When a `bd` command is refused, the ledger is busy, a claim lapses or a bead lands in the wrong ledger, read [references/pitfalls.md](references/pitfalls.md).

## Actor attribution

The beads plugin starts every subagent shell call with `unset BEADS_ACTOR; export BD_ACTOR='opencode/<root-session>/<agent>/<session>'`. Run `bd` bare; the actor is already yours. Main sessions get no prefix and set `BEADS_ACTOR` themselves. An actor you set later in the command wins (`--actor`, then `BEADS_ACTOR`, then `BD_ACTOR`). The actor gate only warns when a command ends with no actor.
