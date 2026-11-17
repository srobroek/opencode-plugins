# Formatter config

The global OpenCode config disables the built-in formatters that run without project opt-in
(`uv`, `shfmt`, `rubocop` and the like). The config-gated built-ins run only when the project
configures them (https://opencode.ai/docs/formatters/):

| Formatter | Runs when the project has |
| --- | --- |
| `ruff` | a Ruff config (`[tool.ruff]`, `ruff.toml`, `.ruff.toml`) or a `ruff` dependency |
| `biome` | `biome.json` or `biome.jsonc` and an installed `@biomejs/biome` |
| `oxfmt` | an `oxfmt` dependency in `package.json` |
| `prettier` | a `prettier` dependency in `package.json` |
| `pint` | `laravel/pint` in `composer.json` |
| `clang-format`, `ocamlformat` | `.clang-format`, `.ocamlformat` |

So every project gets an explicit formatter config. Without one, OpenCode formats with tool
defaults that may not match the code, and every agent edit rewrites lines it did not touch.

## Python: Ruff

Put the config in `pyproject.toml`. In a `ruff.toml` (only when there is no `pyproject.toml`),
drop the `tool.ruff` prefix: settings sit at the root and the tables are `[format]` and `[lint]`.

```toml
[tool.ruff]
line-length = 100          # measured from the existing code, see below
target-version = "py312"   # match requires-python

[tool.ruff.format]
quote-style = "double"
indent-style = "space"
docstring-code-format = true

[tool.ruff.lint]
select = ["E", "F", "I", "N", "W", "UP", "B", "SIM", "TC", "ANN", "RUF", "PERF", "C4", "PT", "S"]

[tool.ruff.lint.per-file-ignores]
"tests/**" = ["S101", "ANN"]
```

- Greenfield: take Ruff's default `line-length` (88) unless the user picks another.
- Existing code: measure, do not impose 88. Run `ruff format --diff --line-length <n> .` for
  a few candidate widths and pick the one with the smallest diff, or read the longest
  common line length. Copy the quote style the code already uses.
- `lint.select` lists the rules the project enforces; for an existing project start from
  what its CI already checks.

## JS and TS: Biome or oxfmt

Pick one formatter per file type. Never configure two formatters for the same files: OpenCode
runs the first matching built-in that succeeds, and the gate and the agent then disagree.

- Biome (default): one tool for lint and format, and it covers JSON, CSS and GraphQL too.
  Add `@biomejs/biome` as a dev dependency and commit `biome.json`:

  ```json
  {
    "$schema": "https://biomejs.dev/schemas/2.0.0/schema.json",
    "vcs": { "enabled": true, "clientKind": "git", "useIgnoreFile": true },
    "formatter": { "enabled": true, "indentStyle": "space", "lineWidth": 100 },
    "linter": { "enabled": true, "rules": { "recommended": true } },
    "javascript": { "formatter": { "quoteStyle": "double" } }
  }
  ```

  Match the `$schema` version to the installed Biome (`bunx biome --version`).
- oxfmt: choose it when the project lints with Oxlint, or needs Prettier-compatible output
  without Prettier. Add `oxfmt` as a dev dependency and commit `.oxfmtrc.json` (`oxfmt --init`
  writes one; `.oxfmtrc.jsonc`, `oxfmt.config.ts` and `oxfmt.config.mts` also work):

  ```json
  {
    "$schema": "./node_modules/oxfmt/configuration_schema.json",
    "printWidth": 100,
    "singleQuote": false
  }
  ```

  If Biome stays for linting, set `"formatter": { "enabled": false }` in `biome.json` and add
  `"biome": { "disabled": true }` to the project's OpenCode `formatter` block, so Biome does
  not also format the JS and TS files.
- Prettier stays off globally. A project that wants it adds `prettier` as a dev dependency,
  re-enables it with `"prettier": { "disabled": false }` in its OpenCode `formatter` block,
  and disables Biome and oxfmt for the same files.

## Existing code

Commit the config together with a one-time format pass (`just fmt`) in its own commit, for
example `style: adopt ruff format config`, with no other change in it. Later edits then produce
one-line diffs. List that commit in `.git-blame-ignore-revs` so `git blame` skips it.

## Opting out

A project that does not want OpenCode to format a language disables those built-ins in its
`.opencode/opencode.json`:

```json
{
  "formatter": {
    "ruff": { "disabled": true },
    "uv": { "disabled": true }
  }
}
```
