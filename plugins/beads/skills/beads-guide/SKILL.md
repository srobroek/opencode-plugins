---
name: beads-guide
description: "Use for Beads: init, remotes, BEADS_DIR, separate beads repo, ledger outside the checkout, preflight or closing."
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
| Closing or reviewing a bead: the evidence a close needs | `beads-evidence` |
| `lock busy`, `workspace gate busy` or a failed `bd dolt pull`/`push` | `beads-contention-retry` |
