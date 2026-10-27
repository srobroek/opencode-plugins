---
name: repomix
description: "Use to pack a repo into one file with repomix for bulk context: external repo APIs, module review, version diffs, docs."
---

# repomix

repomix packs many files into one file. Use it when the question needs a lot of files at
once. For a single lookup ("where is X", "what does this function do"), use grep and read
instead: they cost less.

## When it helps

| Use case | Pack | Then |
| --- | --- | --- |
| Learn an external repo's layout and APIs | `remote: "owner/repo"`, `ref: "<tag>"`, `compress: true`, `include: ["src/**"]` | grep the pack for file anchors, read the slices you need |
| Review a whole module | `directory: "<repo>"`, `include: ["<module>/**"]`, `ignore: ["**/dist/**"]`, `lineNumbers: true`, no compress | pass the pack path to the reviewer in its brief |
| Compare two versions | the same `remote` and `include` at two `ref`s, `compress: true` | `diff` the two pack files and read only the changed hunks |
| Read a doc set | `remote: "owner/repo"`, `include: ["docs/**/*.md"]`, `style: "markdown"`, no compress | grep for `## File: ` and read the relevant pages |

## Keep the pack out of your context

1. `repomix_pack` writes the pack to a file under the temp dir and returns only its path,
   file and token totals, the top files by tokens, and any files the secret scan left out.
   It never returns the pack itself.
2. Never read the whole pack. Grep it for the file anchor (`<file path="` for xml,
   `## File: ` for markdown, `File: ` for plain) to list the files with their line numbers,
   then read one file's slice with offset and limit.
3. If a pack is over about 50k tokens, give its path to a researcher subagent with the
   question, and work from its answer.
4. Narrow with `include` before you compress. A pack of `src/**` is often a tenth of the
   whole repo.

## Compression

`compress` keeps imports, exported signatures, types and doc comments, and drops function
bodies. That suits an API or architecture overview of code (about 70% smaller for
TypeScript). Don't compress:

- Tests: the `describe`/`test` calls are dropped, so a compressed test file is only its
  imports. Leave tests out (`ignore: ["**/*.test.*"]`) or pack them separately.
- Markdown and other prose: compression saves nothing there.
- Code you need to review line by line: pack it uncompressed with `lineNumbers`.

## Safety

- The target's `repomix.config.*` is never loaded. A JS or TS config is code, so packing a
  third-party checkout is safe. A `.repomixignore` in the target still applies.
- The secret scan always runs. A flagged file is left out of the pack and named in the
  result. The scan is a heuristic, so don't paste pack contents anywhere public.
- When repomix is not on PATH, the tool runs a pinned version through npx and asks first,
  because npx downloads code.

## Without the tool

Where `repomix_pack` is not available, run the CLI with the same rules. Write to a temp
file, never to stdout. Point `--config` at an empty JSON file so no config is loaded, and
never pass `--no-security-check` or `--remote-trust-config`:

```sh
dir=$(mktemp -d) && echo '{}' > "$dir/empty.json"
repomix --config="$dir/empty.json" --output="$dir/pack.xml" --no-file-summary \
  --no-git-sort-by-changes --compress --include='src/**' \
  --remote=owner/repo --remote-branch=v1.2.0
grep -n '<file path="' "$dir/pack.xml"
```

Without `--no-git-sort-by-changes`, repomix orders files by git churn, so two packs of
different versions diff noisily. Delete the temp directory when you are done.
