---
name: journeys-guide
description: "Use for user journeys: set up a journeys dir, write, verify all or changed, run campaigns, consolidate checkpoints."
---

# Journeys guide

This guide only routes. Before you answer or act, load the matching skill with the skill
tool, by id, in this same turn, and every other row the task spans. Answer from the loaded
skill, not from this table.

| Situation | Load skill |
| --- | --- |
| The repo has no user-journeys directory yet: investigate, interview, scaffold the format | `journey-init` |
| Authoring or amending journeys from feature evidence | `journey-write` |
| Validating journeys against the running product: drive steps, triage, record results | `journey-verify` |
| Validating only the journeys a diff, PR or branch touches | `journey-verify-changed` |
| Fleet-scale journey or issue validation: fan out validators, fix, re-validate until green | `journey-campaign` |
| Advancing a journey checkpoint with approval: flush delta logs, prune runs, regenerate the index | `journey-consolidate` |
