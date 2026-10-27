---
name: beads-guide
description: "Use for Beads (bd) work: init, remotes, no beads database found, preflight, creating, planning or closing beads."
---

# Beads guide

This guide only routes. Before you answer or act, load the matching skill with the skill
tool, by id, in this same turn, and every other row the task spans. Answer from the loaded
skill, not from this table.

| Situation | Load skill |
| --- | --- |
| A repo without `.beads/`, ledger clones, git/Dolt remotes, or `no beads database found` | `beads-setup` |
| Starting ledger work, or asked for a beads preflight (read-only readiness checks) | `beads-preflight` |
| Creating, planning or bulk-editing beads: acceptance, metadata, routing, deps | `beads-ledger` |
| Closing or reviewing a bead: the evidence a close needs | `beads-evidence` |
| `lock busy`, `workspace gate busy` or a failed `bd dolt pull`/`push` | `beads-contention-retry` |
