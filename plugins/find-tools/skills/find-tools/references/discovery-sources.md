# Discovery Sources

`find_tools_scan` queries these sources in parallel, each with a 10-second
deadline. One failing source never fails the scan.

| Source | What it searches | Notes |
| --- | --- | --- |
| `local` | Installed plugins and skills (`ctx.plugin.list`, `ctx.skill.list`), MCP servers (`ctx.mcp.list`) | MCP appears as status counts only: no names, commands, URLs or environment |
| `catalog` | This repository's `.claude-plugin/marketplace.json` and the `skillCatalogs` from the plugin options | Lists only plugins whose skills work outside OpenCode |
| `mcp_registry` | Official MCP Registry, `/v0.1/servers?search=…&version=latest` | Matches a name substring, so the scan searches the query's most specific words and ranks the union |
| `npm` | Keywords `opencode-plugin`, `mcp-server`, `agent-skill`, `claude-skill` | Query trimmed to npm's 64-character search text; deduplicated, ranked, capped at 20 |
| `github` | `gh api`: code search for `.claude-plugin/marketplace.json` and `SKILL.md`, repositories with topic `opencode-plugin` | Skipped without `gh`; GitHub ANDs every word, so the scan sends the three most specific |
| `awesome_opencode` | The awesome-opencode README | Community list: every hit is marked unvetted |
| `smithery` | Smithery registry | Skipped unless `SMITHERY_API_KEY` is set |
| `skills_cli` | Nothing | Always a gap: the skills CLI runs package code, so discovery never calls it |

## Statuses

- `ok`: answered with hits.
- `empty`: answered with nothing. That is a result, not a gap.
- `partial`: some sub-requests failed; the hits that did arrive are kept.
- `skipped`: not searched (missing tool or key, or not requested).
- `failed`: searched and could not answer (HTTP error, invalid response, timeout).

`skipped`, `partial` and `failed` sources are listed under `gaps`.

## Install hints

A hit may carry an install hint: the project-scope command or config change,
and for plugins also the user-wide command. Hints marked *runs package code*
start a package runner (`npx -y`, `uvx`, `docker run`). The scan never runs a
hint.

## Deliberately excluded

- Glama, PulseMCP, MCP.Directory, SkillsGate: HTML aggregators that overlap the
  MCP Registry and Smithery.
- Other awesome lists: prose, scrape-only, high recall and low precision.
  awesome-opencode is the exception because it is OpenCode-specific.
