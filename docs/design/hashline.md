# Hashline edits on OpenCode V2 (opencode-plugins-4p3.2, phase 2)

Status: design only. Phase 1 (`plugins/lsp`) shipped; this records what a
`plugins/hashline` needs and what was measured.

## Format

Oh My Pi's hashline: `read` returns a `[PATH#TAG]` header (4-hex file tag,
xxhash32 of the text) and `N:TEXT` lines. `edit` takes a patch addressed by
that header and line numbers; a stale tag rejects the write. The engine also
repairs swallowed or echoed block boundaries (with a tree-sitter probe), keeps
a cut/paste clipboard and guards against editing lines a read never showed.

## Engine: @hy-sde-org/dsh-hashline

- MIT, zero runtime deps, ~300 KB JS, only rc/alpha releases
  (latest `0.2.1-rc.3`). Port of omp `packages/hashline`.
- Exports `formatHashlineHeader`, `computeFileHash`, `formatNumberedLines`,
  `parsePatch`, `applyEdits`, `Patcher`, snapshot store and recovery helpers.
- Parity against omp `crates/pi-edit/tests/fixtures/hashline/parity_*.json`
  (omp 011ab73, 2026-10-26), parse and apply cases only: 503 pass, 38 fail.
  Clean: block, core_contracts, file_ops, format_v2, leniency, patcher,
  recovery_session_chain. Failures: boundary_repair 30/153, landing_shift 6/44,
  clipboard 2/39, mostly syntax-aware closer repair. The scenario fixtures
  (seen-line guard, streaming preview, coding-agent hashline, snapshots) need
  a host harness and were not run. Harness: `$TMPDIR/opencode/hashline/parity.mjs`.
- Vendor a pinned copy into `plugins/hashline/vendor/` with its LICENSE and the
  omp notice, and run the parity fixtures in `bun test` with the 38 known
  failures listed as expected, so an engine bump shows the delta.

## V2 plumbing

Reference: `@glaicer/supercode-hashline-editing` 1.2.0 (its own small engine,
not omp's). It replaces `read`, `edit` and `write` through `tool.transform`
(keeping the native `read` for non-text files), and uses session hooks
`context`, `compaction` and `generate` to drop `patch` from `event.tools` and
pin the edit/write schemas the model sees.

Per-model allowlist, which glaicer lacks:

- `SessionContext` carries `model`, `sessionID` and a mutable `tools` record of
  `{ description, input }`. The `context` hook can show the hashline
  `read`/`edit` schemas only to allowlisted models and leave `patch` alone for
  the rest.
- Tool execution is by name, so the `read`/`edit` overrides must dispatch at
  run time: the `context` hook records `sessionID -> model`, and `execute`
  picks hashline or the native tool (kept from `editor.get`) from that.
- A model switch mid-session leaves earlier hashline reads in history; the
  edit tool should accept a plain native edit input too, or reject with a
  re-read hint.

## Open questions

- Whether `context` fires before every request, including subagents, so the
  session-to-model map is never stale.
- Output budget: glaicer assumes a 50 KiB host tool-output cap and truncates
  tagged reads at 40 KiB; not verified here.
- Interaction with `plugins/lsp`: the hashline `edit` input has no `path`;
  `touchedFiles` needs the patch headers (`[PATH#TAG]`) to find targets.
