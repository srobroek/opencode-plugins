# repomix

Packs a local directory, or a remote repository at a ref, into one file with
[repomix](https://github.com/yamadashy/repomix), for questions that need many files at
once: an external repo's layout and APIs, a whole module for review, a diff between two
versions, or a doc set. The pack goes to a file and only its path and metrics come back,
so it never lands in the context.

## Install

```sh
opencode plugin add 'github:srobroek/opencode-plugins::path:plugins/repomix'
```

Install repomix globally (`mise use -g npm:repomix@1.18.1` or `npm i -g repomix`). Without
it on PATH, the tool runs `npx --yes repomix@1.18.1` and asks first, because npx downloads
code.

## Tool

`repomix_pack` takes `directory` (default: the session directory) or `remote`
(`owner/repo` or an https URL) with an optional `ref`, plus `include` and `ignore` globs,
`compress`, `style` (`xml`, `markdown` or `plain`), `lineNumbers` and `timeoutSeconds`
(default 300). It writes `repomix-<target>-<id>.<ext>` to `$TMPDIR/opencode/repomix/` and
returns the path, the file, token and character totals, the ten largest files, and the
files the secret scan left out. Packs older than a day are removed on the next run.

Every run:

- passes `--config` an empty JSON file, so neither the target's `repomix.config.*` (a JS
  or TS config is code) nor your global repomix config is loaded. A target's
  `.repomixignore` and `.gitignore` still apply.
- runs in an empty directory under the temp dir.
- never passes `--no-security-check` or `--remote-trust-config`.
- passes `--no-file-summary` and `--no-git-sort-by-changes`, so two packs of one repo at
  different refs diff cleanly.

The tool asks permission as `repomix_pack`, with the absolute directory or `remote@ref` as
the resource. When it would run through npx, an allowed call is turned into a prompt. Set
the plugin option `confirmPack: false` to leave that to your permission rules:

```jsonc
{
  "plugins": [{
    "package": "github:srobroek/opencode-plugins::path:plugins/repomix",
    "options": { "confirmPack": false }
  }]
}
```

The `researcher` agent (agent-researcher, and delivery's fallback copy) and build's
`external-repo-worker` allow `repomix_pack`. Other agents keep your default for it, which
is a prompt unless you configure otherwise. The shipped allowlist agents deny it.

## Skill

`repomix` lists when packing beats grep and read, the recipes for each case, how to read
a pack in slices, and when `compress` loses information. It also carries a CLI recipe,
so it is exported to Claude Code and Codex.

## Optional: the repomix MCP server

The plugin does not configure the repomix MCP server. Its tools add about 1.2k tokens to
every request under Code Mode, and about 1.9k with `codemode: false`, and its read and
grep tools duplicate the built-in ones. If you want it anyway:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      // Not named "repomix": its tools would then be repomix_*, beside repomix_pack.
      "repomix-mcp": {
        "type": "local",
        "command": ["repomix", "--mcp", "--sandbox"],
      },
    },
  },
  "permissions": [{ "action": "repomix-mcp_*", "resource": "*", "effect": "deny" }],
}
```

`--sandbox` confines its file tools to the working directory and drops remote packing and
skill generation. Without it the server can read any path you can and writes
`.claude/skills/`. Remove the deny for the agents that should use it.
