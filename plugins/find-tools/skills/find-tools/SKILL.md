---
name: find-tools
description: Use when asked to find a tool, or whether to adopt, reject or build a plugin, skill or MCP server for a capability.
---

# Find Tools

Discovery and vetting for reusable agent capabilities. Check what is already
installed before searching public sources. Discovery never installs anything:
installing is a separate step the user approves.

## References

- `references/discovery-sources.md`: the eight sources `find_tools_scan`
  queries, what each status means, and what is deliberately left out.
- `references/adoption-policy.md`: the decision vocabulary, install scopes and
  the vetting rubric.

## Workflow

1. **Clarify the capability**: task, artifact type (plugin, skill, MCP server),
   constraints (license, local or hosted, secrets, network access, writes).
2. **Scan**: call `find_tools_scan` with a short query of a few specific words
   (`browser automation`, `postgres schema`), not a sentence. Read every
   source's status and the gap list. `empty` means the source answered with
   nothing; `skipped` and `failed` mean it was not searched. Say which sources
   you could not search instead of calling the search complete.
3. **Check local coverage**: if a `plugin:` or `skill:` entry under `local`
   already covers the need, recommend `Use existing` and stop. Local MCP
   inventory is status counts only; ask the user which servers they have
   rather than reading their configuration.
4. **Vet serious candidates** with the rubric in `references/adoption-policy.md`.
   Open the source: repository, license, last release or commit, maintainer,
   the actual `SKILL.md`, plugin entry point or MCP tool list, and what it
   needs (binaries, API keys, network, file writes). A registry or list entry
   is a lead, not verification. `awesome_opencode` entries are unvetted.
5. **Decide** per candidate with the vocabulary below and present the table.
6. **Ask before installing.** Present the install hint, the scope and what it
   runs, then wait for the user's answer. See *Installing* below.

## Rules

- `find_tools_scan` and this workflow never install, add or run a discovered
  package. Install hints in the scan are text for the user.
- Do not run the skills CLI (`npx skills find`, `npx skills add`) or the
  Smithery CLI during discovery; both download and run package code. The
  `skills_cli` gap stays a gap.
- Never pipe a downloaded script into a shell (`curl … | sh`). Read the script
  first and give the user the reviewed command.
- Do not request or print MCP server configuration, headers or environment to
  fill the local gap.
- A `failed` or `skipped` source is not evidence that nothing exists.

## Installing

Only after the user picks a candidate:

- **Project scope is the default.** Plugins go in the project's
  `opencode.json` `plugins` list, MCP servers through `opencode mcp add <name> …`
  without `--global`, skills under the project's `.opencode/skills/<name>/`.
- **User-wide needs its own confirmation.** `opencode plugin add …` (writes the
  global config), `opencode mcp add --global …` and `~/.config/opencode/skills/`
  change every project. Ask separately and name the file that changes.
- **Package code needs its own confirmation.** A hint marked
  *runs package code* (`npx -y`, `bunx`, `uvx`, `docker run`) downloads and
  executes third-party code on every start. Name the package and version, and
  ask separately even if the user already agreed to the install.
- With the plugin's install guard on (the default), skills CLI, Smithery CLI
  and pipe-to-shell commands prompt again at the permission layer. That prompt
  does not replace asking first.

## Output

Lead with one decision: `Use existing`, `Adopt`, `Trial`, `Reject` or `Build`.
Then list the sources searched and the gaps, the candidate table, verification
notes, overlap with what is installed, the proposed install (scope and what it
runs) and caveats.

One row per serious candidate:

| name | type | source URL | license | last activity | overlap with installed | install (scope) | verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |
