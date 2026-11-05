# Choosing OpenCode plugins

All srobroek plugins live in https://github.com/srobroek/opencode-plugins (public).
Pick per project; do not re-add what the host already has globally.

## 1. See what is installed

- Global: `plugins` in `~/.config/opencode/opencode.json`; `opencode plugin list` shows
  installed plugins. Typically global already: `agent-*`, `model-roles`, `safety`,
  `trunk-dev`, `quality`, `architecture`, `toolchain`, `find-tools`, `session`, `parley`,
  `debate`, `chezmoi`, `whats-new`, `dep-update`, `eli5`, `aws`, `docs`, `repomix`,
  `subagent-worktree`, `agent-efficiency`. Trust the file, not this list.
- Project: `plugins` in the project's `opencode.jsonc`, if it exists.

## 2. List every available plugin

Use any of these; the first two give descriptions to match against the project:

1. `find_tools_scan` with a few capability words (for example `rust lint`, `issue tracking`)
   and `sources: ["local", "catalog"]`. `local` is what is installed; `catalog` is this
   repository's `.claude-plugin/marketplace.json`. Read-only; it never installs.
2. The repository itself (covers plugins the marketplace omits, which only lists plugins
   with skills):

   ```sh
   gh api repos/srobroek/opencode-plugins/contents/plugins --jq '.[] | select(.type=="dir") | .name'
   gh api repos/srobroek/opencode-plugins/contents/plugins/<name>/package.json --jq .content | base64 -d | jq -r .description
   ```

   The root `README.md` also has the plugin list and a Claude Code / Codex table.
3. Marketplace file, exported plugins only:

   ```sh
   gh api repos/srobroek/opencode-plugins/contents/.claude-plugin/marketplace.json --jq .content | base64 -d | jq -r '.plugins[] | "\(.name)\t\(.description)"'
   ```

`lib` is not a plugin. Other registries (npm, MCP registry, awesome-opencode) are
`find-tools`' job when this repository has no fit.

## 3. Typical per-project picks

| Plugin | Add when |
| --- | --- |
| `lang-rust`, `lang-python`, `lang-go`, `lang-typescript` | the project uses that language (quality, testing, packaging skills) |
| `beads` | work is tracked with beads (`bd`) |
| `speckit` | spec-driven development on beads |
| `journeys` | user journeys are written and verified |
| `delivery` | PR landing with merge proof, worktree cleanup |
| `worktrunk` | worktrees via `wt` |
| `design` | a UI: design system, accessibility, browser checks |
| `ast-grep` | structural search or rewrites in a large codebase |
| LSP plugin (`plugins/lsp`) | edit results should carry new language-server errors |
| `cad` | mechanical CAD work |
| `goal` | `/goal` and `/loop` modes |

Ask before adding any plugin that is not obviously needed. Plugins with MCP servers
(`ast-grep`, `design`, `aws`, `docs`) start them only where their marker check matches.

## 4. Install into the project

Spec: `github:srobroek/opencode-plugins::path:plugins/<name>`; append `#<tag>` (for example
`#lang-rust--v0.2.0`, see `git ls-remote --tags` on the repository) to pin, which stops
automatic updates. Check `opencode plugin add --help`: in OpenCode 2.2.5 it writes the
global configuration, so for a project edit the project's `plugins` array instead:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "github:srobroek/opencode-plugins::path:plugins/lang-rust",
    "github:srobroek/opencode-plugins::path:plugins/beads"
  ]
}
```

Plugin options use the object form (`{ "package": "...", "options": {} }`). Then
`opencode plugin list` to confirm they load, and mention that a restart may be needed.
