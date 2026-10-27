---
name: ast-grep-search
description: "Use for structural code search with ast-grep (call sites, API usage, code shapes) and previewed codemods or LSP CLI checks."
---

# ast-grep structural search

ast-grep matches code by syntax tree, not text. A match ignores whitespace, comments and
formatting, and a pattern never hits a string, comment or identifier that only contains
the name.

## Structural search or grep

| Question | Use |
| --- | --- |
| Every call of `foo`, every `new Client(...)`, `await` inside a loop, a function with a given shape | ast-grep |
| A literal string, a config key, a log message, a file name, prose, code inside a Rust macro | grep |
| A name across languages or file types the pattern does not parse | grep |
| Definition, references or type of one symbol in a language with an LSP | the LSP tools, or the CLI checks below |

Grep first when a word is enough to find it; reach for ast-grep when grep returns too
many false hits or misses multi-line code.

## Where it runs

- MCP server `ast-grep`: `find_code` (pattern), `find_code_by_rule` (YAML rule),
  `dump_syntax_tree` (debug a pattern) and `test_match_code_rule` (check a rule on a
  snippet). `project_folder` must be an absolute path. In OpenCode Code Mode:
  `tools["ast-grep"].find_code({ project_folder, pattern, language })`.
- CLI, when the server is missing: `ast-grep run -p '<pattern>' -l <lang> <path>`, with
  `--json=compact` for machine-readable output, and
  `ast-grep scan --inline-rules '<yaml>' <path>` for a rule.

Search once per language the project has, and check the file extensions first (`glob`):
`typescript` does not parse `.tsx`, so a TypeScript project needs both `typescript` and
`tsx`. The CLI without `-l` infers each file's language from its extension.

## Pattern essentials

- The pattern must parse as code in that language: `foo($A)`, `class $NAME`, `await $X`.
- `$NAME` matches exactly one node. `$$$ARGS` matches zero or more nodes, as in
  `foo($$$ARGS)`. `foo($A)` misses `foo(1, 2)`. A rewrite can reuse only named
  metavariables: an anonymous `$$$` or `$_` comes out literally.
- Repeating a name means the same code: `$A == $A` matches `x == x` only. `$_` matches
  without capturing.
- A metavariable is a whole node: `$OBJ.save()` works, `save$SUFFIX()` does not.
- A bare call pattern misses method calls: `foo($$$)` does not match `obj.foo()`. Search
  `$O.foo($$$)` too, and grep the name for aliases, re-exports and references passed as
  values.
- For context (inside a loop, not in a test, has a child), write a YAML rule with
  `inside`/`has` and `stopBy: end`:

  ```yaml
  id: await-in-loop
  language: typescript
  rule:
    pattern: await $X
    inside:
      any: [{ kind: for_in_statement }, { kind: for_statement }, { kind: while_statement }]
      stopBy: end
  ```

- When a pattern finds nothing, run `dump_syntax_tree` with `format: pattern` (CLI:
  `--debug-query=pattern`) to see how it parsed, and `format: cst` on the target code to
  get node kinds.

## Language gotchas

- Rust: macro arguments are token trees, so `helper($A)` misses `println!("{}", helper(2))`
  and `vec![helper(3)]`. Grep for calls inside macros.
- A fragment that does not parse on its own (a class field, an object key, a Go struct
  field) matches nothing. Wrap it in a rule:
  `pattern: { context: 'class C { $F = $V }', selector: public_field_definition }`.
- Python: `def $F($$$)` matches the whole function. Capture a body with `$$$BODY` after
  the colon instead of writing statements out, since multi-line patterns follow
  indentation.

## Rewrites: preview, then apply with the edit tool

Never let a tool write files. Run the rewrite without `-U` (or `--update-all`) and never
with `-i`; ast-grep then only prints a diff:

```sh
ast-grep run -p 'foo($$$A)' -r 'bar($$$A)' src
```

Read the diff, then make each change with the edit tool, so hooks, formatters and
permissions run on it. For many sites, change a few, re-run the preview to confirm the
rest, and continue.

## Language-server CLI checks

Use these where no LSP tool is connected. Each reads only:

| Need | Command |
| --- | --- |
| Go rename as a diff (apply with the edit tool; never `-w`) | `gopls rename -d path/file.go:<line>:<col> NewName` |
| TypeScript type errors | `tsc --noEmit -p .` |
| Python type errors as JSON | `pyright --outputjson` |
| Rust diagnostics | `rust-analyzer diagnostics .` |
