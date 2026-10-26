# chezmoi

Refuses edits and shell writes to chezmoi-managed live files under `$HOME`, because
the next `chezmoi apply` overwrites them from source. The refusal names the source
path to edit instead (`chezmoi source-path <target>`).

Ported from the omp-plugins `chezmoi` plugin.

## Install

```sh
opencode plugin add 'github:srobroek/opencode-plugins::path:plugins/chezmoi'
```

Claude Code and Codex install the skill from this repository's marketplace:

```sh
claude plugin install chezmoi@srobroek-opencode
codex plugin add chezmoi@srobroek-opencode
```

There the skill has no guard behind it.

## Guard

A `tool.hook("execute.before")` throws when a call writes a managed target. It reads
the write targets statically:

- `edit` and `write`: `path`.
- `patch`: every `*** Add File:`, `*** Update File:`, `*** Delete File:` and
  `*** Move to:` header.
- `shell`: `>`, `>>` and `>|` redirects, `tee`, `cp`/`mv` destinations (including
  `-t DIR` and an existing destination directory), `sed -i`/`gsed -i` and `perl -i`.
  Leading `sudo`, `doas`, `env` (including `env -S`), `nice`, `timeout`, `stdbuf`,
  `command`, `exec`, `nohup`, `time` and `VAR=value` prefixes are skipped with their
  options. Relative paths resolve against the call's `workdir` and a literal
  `cd DIR` earlier in the same command; a `cd` inside `( … )` ends with the group.
  A wrapped command's own paths resolve against its `env -C DIR` or `sudo -D DIR`,
  while its redirects stay in the shell's directory.

Only paths under `$HOME` are checked. Symlink aliases of a managed target count as
the target. Writes inside the chezmoi source directory are allowed.

The guard reads the managed set from `chezmoi managed --path-style=absolute` and
caches it. It re-reads the list after 5 seconds, after a write inside the source
directory, and after any `shell` command that runs `chezmoi` (for example
`chezmoi add`).

The guard allows the call when `chezmoi` is missing, fails or times out (2 seconds),
and for unmanaged paths. It reads literal words only; it is not a shell sandbox. It
does not see writes behind variables other than `$HOME`, command substitution
results, `sh -c`/`eval` strings, scripts, or other tools (`install`, `rsync`, `dd`,
editors).

## Skill

The plugin registers the `chezmoi-editor` skill from
`skills/chezmoi-editor/SKILL.md`, unless a skill with that id already exists. It
links to `references/conventions.md` for source-file name prefixes.
