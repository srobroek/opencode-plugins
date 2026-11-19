# plugin-audit

Audits the OpenCode plugins in this repository in one read-only pass. It reports findings in five
categories:

- `versions`: declared dependencies behind their npm latest stable release. Host modules that AGENTS.md
  pins to the latest release are warned about; a major gap there needs a manual decision.
- `docs`: the `@opencode/plugin` pin behind npm latest (read its release notes), Biome `$schema` URLs
  that name another version than the installed `@biomejs/biome`, and imports of the V1 API.
- `practices`: the packaging and naming conventions in AGENTS.md, exact version pins in skills, and
  shipped agents on an older model generation.
- `bumps`: `package.json` versions that disagree with `.release-please-manifest.json`, plugins missing
  from the release-please files, and commits since each release tag.
- `consistency`: a missing scope, README, CHANGELOG or tests, and the `@opencode/plugin` peer range
  or a devDependency pinned differently across plugins.

## Install

```sh
opencode plugin add 'github:srobroek/opencode-plugins::path:plugins/plugin-audit'
```

## Tools

| Tool | What it does |
| --- | --- |
| `plugin_audit_scan` | Audits the repository and returns findings grouped by category, errors first. Read-only. Input: `path`, `plugins`, `categories`, `offline` (skip npm lookups) and `git` (count commits since release tags). |

The skill `plugin-audit` tells the agent how to triage the report and fix what it finds.
