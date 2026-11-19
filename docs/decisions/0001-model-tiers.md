# 0001. Model tiers derived from the catalog

## Context

Agents named a fixed model or a hand-written role map (`smol`, `task`, `slow`,
`reviewer`). Each machine kept its own map, and the maps drifted. On OpenCode
V2 the model catalog already carries what a plugin needs: billing kind through
`cost`, list price, release date, family and variants.

## Decision

`srobroek.model-roles` gives agents four tiers: `cheap`, `standard`, `strong`
and `reviewer`. With no options it builds them from `ctx.model.list()` and the
models.dev reference records that `editor.provider.list()` exposes.

- Billing: empty `cost` means subscription, all entries at zero means free,
  anything else means metered.
- Quality: list price. Subscription models use the matching first-party
  reference price.
- Pruning, in order: eligible (active, tool-capable, family include, name
  excludes), one model per provider, superseded, stale (more than 120 days
  behind the newest), dominated (a newer model within 10% of its price),
  premium (at or above $8 per million input tokens).
- Lineup per vendor sorted by price: `cheap` is the cheapest, `strong` the
  dearest, `standard` the rest. Each tier maps to an effort level.
- `reviewer` is `strong` with the other vendor first, so a review does not
  come from the caller's family.
- Overrides live in `options.tiers`. `roles` and `purposes` remain as
  deprecated aliases. Legacy role names map to tiers: `smol` and `commit` to
  `cheap`, `task` to `standard`, `slow`, `plan`, `architect` and `designer` to
  `strong`, `challenger` and `judge` to `reviewer`.

## Status

Accepted and implemented (`opencode-plugins-4p3.24`), with the `/tiers` TUI
command (`4p3.25`). The subscription soft-quota demotion from response headers
was proposed and is not verified as built.

## Consequences

- Machines need no role maps; new catalog models are picked up without config.
- The guard refuses premium models only. Strong models such as Opus are not
  guarded (user decision, 2026-10-27).
- Model ids and prices in the original analysis are a dated snapshot and are
  not kept here. Read `plugins/model-roles/README.md` for current behaviour.
