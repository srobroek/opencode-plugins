# repomix: evaluation and packaging

Status: evaluated in bead `opencode-plugins-6z9.14`, built in `opencode-plugins-4p3.49` as
`plugins/repomix` (see "As built" at the end). Measured with repomix 1.18.0 (the mise global
install; npm latest is 1.18.1) and OpenCode 2.1.4.

## TL;DR

- **Use it for bulk, many-file context, not single lookups.** It helps in four cases:
  understanding an external repo, a review pack for a whole module, a diff between two
  versions for whats-new, and feeding in a doc set. For "where is X", grep/read/explore is
  still better.
- **Don't ship the MCP server by default.** It adds about 3.3k tokens to every request when
  exposed directly, about 1.2k under Code Mode, and about 1.9k with `--sandbox` exposed
  directly. Its `read`/`grep` tools duplicate the built-in ones.
- **Ship a small `repomix` plugin instead:** one `repomix_pack` tool that writes the pack to
  the temp dir and returns only the path and metrics, plus a `repomix` skill with recipes.
  Agents read slices of the pack with the built-in `read`/`grep`. An MCP snippet stays in
  the README as an optional extra.

## Measurements

### Request cost

Method: a private `opencode serve` with HOME and all XDG dirs isolated, pointed at a local
OpenAI-compatible capture endpoint. Each figure is from the second turn, because MCP
connects lazily and the first request goes out before the catalog exists. Token figures
are chars/4.

| Config | Added per request | ≈ tokens |
|---|---|---|
| `codemode: false` (6 tools) | 12,572 chars of tool schemas + 695 of instructions | 3.3k |
| `--sandbox`, `codemode: false` (5 tools) | 7,034 + ~650 | 1.9k |
| Code Mode (default) | 3,966 of catalog + ~700 of instructions; the catalog also changes from "complete" to "partial" and gains a `search()` preamble | 1.2k |

The direct schemas per tool are: `pack_remote_repository` 3.6k chars, `pack_codebase` 3.5k,
`generate_skill` 2.1k, `grep_repomix_output` 1.2k, `attach_packed_output` 1.2k and
`read_repomix_output` 0.9k. Under Code Mode the catalog shows the first three tools
alphabetically (attach, generate_skill, read). Neither pack tool is shown, so the model has
to `search()` before it can pack. The catalog and instructions arrive as a mid-session
`<system-update>` user message.

### Output sizes (this repo; `dist/` and CHANGELOGs ignored)

| Scope | Files | Tokens | Notes |
|---|---|---|---|
| whole repo | 714 | 1.11M (4.3 MB) | 1.2 s; can never go in context |
| `plugins/{build,lib}/src/**/*.ts` | 39 | 59.7k → 17.3k with `--compress` | −71% |
| `plugins/**/*.md` | — | 210k → 210k with `--compress` | 0%, as the omp rule found |
| remote `yamadashy/repomix` `src/mcp/**`, `--compress`, v1.17.0 / v1.18.0 | — | 4.5k / 7.4k | 3.4 s each |

An MCP `pack_codebase` call returns about 3 KB of text: metrics, `outputId` and the file
path. It does not return the pack itself. The pack goes to
`$TMPDIR/repomix/mcp-outputs/<rand>/` and **is not deleted when the server exits**.

### `--compress` quality

Tree-sitter keeps imports, exported signatures, types and doc comments, and replaces bodies
with `⋮----`. That works well for an API or architecture overview. It is lossy for tests:
the `describe`/`test` calls disappear, so a compressed test file is only its imports. Keep
tests and markdown uncompressed. `outputPatterns` (MCP) or `output.patterns` (config) can
set compression per glob.

### Security

- **Secretlint is on by default**, and a flagged file is dropped from the pack entirely. It
  caught a realistic `AWS_SECRET_ACCESS_KEY` and a `ghp_` token. It missed an
  `AKIA…EXAMPLE` key pair and a truncated PEM, so treat it as a heuristic.
  `--no-security-check` turns it off; never pass it. `.env` was left out by the default
  ignore patterns.
- **Remote packs** run a temp clone. They don't load the remote's `repomix.config.*` unless
  `--remote-trust-config` is passed, and never pass it.
- **Local packs load a `repomix.config.*`, and a config file is code.** That is true of the
  CLI and of MCP without `--sandbox`. The CLI looks for the config in its working directory
  (not the packed directory) and then in the global `$XDG_CONFIG_HOME/repomix/`. Verified
  with repomix 1.18.0: a target `repomix.config.js` that writes a marker file ran when
  repomix ran inside the target, and did not run with `-c <empty json>`, nor when repomix
  ran elsewhere with the target as an absolute path. `-c <empty json>` also kept a global
  config from loading, which running elsewhere alone did not. The tool does both: it runs
  repomix in an empty temp directory with `--config=<empty json>`. A target's
  `.repomixignore` and `.gitignore` still apply; they only exclude files.
- **MCP without `--sandbox` can read any path** the user can, and `generate_skill` writes
  `.claude/skills/`. `--sandbox` keeps only the root-confined read tools, and
  `file_system_read_file`/`_directory` exist only in sandbox mode.

## Where it beats grep/read/explore

| Use case | Recipe | Consumer |
|---|---|---|
| Learn an external repo's layout and APIs | `--remote owner/repo --remote-branch <ref> --compress --include "src/**"`, then grep the pack for `<file path=` | researcher, external-repo-worker (before cloning) |
| Review a whole module | `<dir> --include "<module>/**" --ignore "**/dist/**"`, uncompressed, `--output-show-line-numbers` | reviewer, as a subagent brief attachment |
| Compare two versions (whats-new) | the same remote pack at two tags with `--compress --no-file-summary --no-git-sort-by-changes`, then `diff` | whats-new via researcher |
| Feed in a doc set | `--remote … --include "docs/**/*.md"`, uncompressed, `--style markdown` | researcher |

Without `--no-git-sort-by-changes`, files are ordered by churn, which makes a diff between
two versions noisy (inference; I always set it).

## Keeping packs out of the main context

1. Always write the pack to a file under the OpenCode temp dir. Never use `--stdout`, and
   never read the whole file.
2. The pack tool returns only the path, total files and tokens, and the top files (the
   `--token-count-tree <N>` view as a cheaper index).
3. Navigate with the built-in `grep` (`<file path="…">` anchors) and `read` with
   offset/limit.
4. For packs above about 50k tokens, have a subagent (researcher) read the pack and report
   back. The main agent sees only the conclusions.
5. `--split-output 500kb` is only for handing chunks to separate subagents.

## Install

repomix is a global install (`mise use -g npm:repomix@1.18.1`, as on this host). The tool
resolves `repomix` on PATH first. If it isn't there, the tool falls back to
`npx --yes repomix@<pinned>`, and that fallback **always asks first**, like
`design_impeccable_scan`, because npx downloads code. `confirmPack: false` opts out.

## Recommended packaging

A new plugin, `plugins/repomix` (`srobroek.repomix`).

- **Tool `repomix_pack`** (codemode default): `{ directory? | remote + ref?, include?,
  ignore?, compress?, style?, lineNumbers? }`. It writes to `<opencode tmp>/repomix/<id>.xml`
  and returns `{ path, files, tokens, topFiles, suspiciousExcluded }`, never the content. It
  never passes `--remote-trust-config` or `--no-security-check`. It asks permission
  (`repomix_pack`), and also asks every time it falls back to npx. The decision logic
  (argument building, choosing PATH or npx, parsing metrics) goes in pure functions. Setup
  stays a thin adapter.
- **Skill `repomix`**: the recipes table above, the out-of-context rules, the compression
  rules per language, and "prefer grep/read for a single lookup".
  `opencode/autoinvoke: false` would hide it, so keep it auto-invokable with a short
  description: "Packs a local or remote repo into one file for bulk context; external
  repos, module packs, version diffs."
- **README**: an optional MCP snippet for users who want the server anyway.
- **Not in whats-new/researcher/build directly**: the tool needs its own permission and
  binary policy, and several agents share it. whats-new's `references/recipes.md` gets a
  one-line pointer to the `repomix` skill for source-level version diffs.

## As built

`plugins/repomix` (`srobroek.repomix`, 0.1.0) follows the packaging above, with these
decisions:

- **Input**: `directory` (default the session directory) or `remote` (`owner/repo` or an
  https URL) with `ref`; `include` and `ignore` as glob arrays; `compress`, `style`
  (`xml`, `markdown`, `plain`), `lineNumbers`, `timeoutSeconds` (default 300, max 900).
  `json` style is left out: every file is one JSON string, so grep and sliced reads don't
  work on it. Refused before any prompt: both targets at once, `ref` without
  `remote`, a remote that is not shorthand or https, a ref starting with `-` or holding
  `..`, a glob with a comma (repomix splits on commas), a missing local directory.
- **Command**: `--config=<empty json> --output=<pack> --style=<s> --no-file-summary
  --no-git-sort-by-changes --top-files-len=10`, then the options and either the absolute
  directory or `--remote=… --remote-branch=…`. Values use `--flag=value`. It runs in a fresh
  `run-*` directory that is removed afterwards, detached and killed as a process group on
  timeout through `supervise()`. Never `--stdout`, `--no-security-check` or
  `--remote-trust-config`.
- **Output**: `$TMPDIR/opencode/repomix/repomix-<dir or repo-ref>-<id>.<ext>`. Packs and
  run directories older than 24 hours are pruned before each pack.
- **Result**: the path, files, tokens and chars, the top ten files and the files the secret
  scan dropped, parsed from repomix's summary (ANSI stripped; missing fields become null),
  plus the grep anchor for the style and, above 50k tokens, advice to hand the path to a
  researcher. The same fields are in the tool metadata, with `runner`.
- **Permission**: action `repomix_pack`, resource the absolute directory or `remote@ref`,
  metadata `runner: path|npx`. An `evaluate` hook turns an allowed npx run into a prompt
  (`confirmPack: false` disables it). npx runs `repomix@1.18.1`.
- **Skill**: exported to Claude Code and Codex, with a CLI recipe that keeps the same rules
  for hosts without the tool. Description: "Use to pack a repo into one file with repomix
  for bulk context: external repo APIs, module review, version diffs, docs."
- **Agents**: `repomix_pack` is allowed for `researcher` (agent-researcher and delivery's
  fallback copy) and `external-repo-worker`, each with one prompt line on when to use it.

Live check (private `opencode serve`, HOME and every XDG dir isolated, Bedrock Haiku 5.5):
`plugins/lib` with `compress` packed 40 files to 17.7k tokens, and the model found the 40
files by grepping the anchors; `yamadashy/repomix@v1.17.0` `src/mcp/**` compressed packed 11
files, 4.5k tokens; asked how `--compress` works, `researcher` packed the repo at v1.18.0
with `repomix_pack` and answered from that pack, citing its files. With `repomix` off PATH, the npx
fallback ran repomix 1.18.1.

### Agent allowlists

| Agent | `repomix_pack` | Why |
|---|---|---|
| `researcher` (agent-researcher) | allow | Its job is read-only research, and the shell rule "no command that writes" forbids the CLI. The tool is a scoped, safe exception. |
| `external-repo-worker` (build) | allow | Orientation before cloning, or inside the clone. |
| main/build agent | default (ask) | Usually delegates to researcher. |
| reviewer agents | deny (default `*` deny) | Reviews get the diff and paths. A module pack should arrive as a path in the brief, which reviewers can `read`. |
| coder/mechanic/explore | deny | Single-lookup work. grep/read is cheaper. |

Allow entry, added to the agent's `permissions` after the `*` deny:

```yaml
  - action: repomix_pack
    resource: "*"
    effect: allow
```

### Optional MCP snippet (README only)

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      // Not named "repomix": the server's tools would then be repomix_*, the same
      // namespace as the plugin's repomix_pack.
      "repomix-mcp": {
        "type": "local",
        "command": ["repomix", "--mcp", "--sandbox"],
        // Code Mode (the default) costs ~1.2k tokens per request; codemode: false ~1.9k.
      },
    },
  },
  "permissions": [
    { "action": "repomix-mcp_*", "resource": "*", "effect": "deny" },
  ],
}
```

With `--sandbox`, `pack_remote_repository` is gone. Remote packs need the CLI or tool, or
the server run without `--sandbox`, which can read anything and writes skill files.
Remove the deny per agent if you use this.
