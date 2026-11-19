---
name: plugin-audit
description: "Use to audit our OpenCode plugins: outdated versions, docs drift, best practices, pending bumps, cross-plugin consistency."
---

# Plugin audit

Run `plugin_audit_scan` from the repository root. Use `offline: true` when the network is unavailable, and `categories` or `plugins` to narrow the scan.

Triage the report in this order:

1. `error` lines first: a broken convention, a V1 import, a version that disagrees with the release manifest, or a missing release-please entry. Fix each at its source (`plugins/<name>/package.json`, `src/`, or the release files).
2. `warn` lines next: stale pins, stale models, host modules behind latest, and missing README, CHANGELOG or tests.
3. `info` lines last: routine bumps and unreleased commits.

For dependency bumps, use the `dep_scan` and `dep_apply` tools when dep-update is installed. Apply one bump at a time. For a major bump, or any change to the `@opencode/plugin` API, read the release notes first: use the `whats-new` skill when it is available, or context7 `/sst/opencode`.

Never edit `dist/`, `index.js` or the composed `agents/` files. Change the source and rebuild. After a change, run `bun run build`, `bun run marketplaces`, `bun run plugin-table`, then `bun run check`.
