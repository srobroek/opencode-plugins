---
name: design-upstream-preflight
description: Use before a design skill or agent routes to an upstream skill or CLI, to install and probe only what that route needs.
---

# Design Upstream Preflight

Run this when a design skill or agent is loaded, before its first routed step.
Check only the rows the current route reaches. The `design` package bundles none of these;
each comes from its upstream author.

| Routed name | Upstream repo | Marketplace | Install address | Prerequisite probe | Needed when |
|---|---|---|---|---|---|
| `impeccable` skill; `impeccable detect` CLI | `pbakaus/impeccable` | `impeccable` | `impeccable@impeccable` | `npx --version` | design workflow; critique steps run the CLI |
| `ss-lint`, `ss-review`, `ss-tokens`, `ss-score`, `ss-motion` | `bitjaru/styleseed` | `styleseed` | `styleseed@styleseed` | `node --version` | `design-system-audit` StyleSeed route, only after the user opts in; `motion-design` React `motion.X` authoring |
| `accessibility` | `addyosmani/web-quality-skills` | `addy-web-quality-skills` | `web-quality-skills@addy-web-quality-skills` | none | `accessibility-audit` |
| `html-wireframe`, `html-prototype` | `plannotator/effective-html` | `effective-html` | `plannotator-effective-html@effective-html` | `python3 --version` to serve | `design-prototype` |
| `frontend-slides` | `zarazhangrui/frontend-slides` | `frontend-slides` | `frontend-slides@frontend-slides` | `python-pptx`, only for PPT conversion | `design-prototype` deck row |
| `web-asset-generator` | `alonw0/web-asset-generator` | `web-asset-generator-marketplace` | `web-asset-generator@web-asset-generator-marketplace` | `Pillow` | `design-prototype` asset row |
| `superdesign` | `superdesigndev/superdesign-skill` | `superdesign` | `superdesign@superdesign` | authenticated account with credits | `design-prototype` hosted row, after the user confirms |

## Procedure

1. Check what is installed. -> a row is installed when its routed skill appears in your
   available skills list, or its CLI answers its prerequisite probe.
2. Install each missing row the route needs, from its listed repo, with the harness's own
   route:
   - Claude Code: `claude plugin marketplace add OWNER/REPO` when `claude plugin
     marketplace list` does not name the marketplace, then
     `claude plugin install ADDRESS`.
   - OpenCode: clone the repo once with
     `git clone --depth 1 "https://github.com/OWNER/REPO" "$HOME/.local/share/design-upstream/REPO"`,
     then add the clone's skills directory to the `skills` array of the global OpenCode
     config. OpenCode reloads skills after the config is saved.
   - Another harness: its own plugin or skill install route for the listed repo.
3. Probe each prerequisite. -> the probe exits zero. Python packages: run
   `python3 -c 'import PIL'` or `python3 -c 'import pptx'`; on failure run the upstream
   script through `uv run --no-project --with pillow python SCRIPT` or
   `--with python-pptx`. With no `uv`, STOP and report the missing prerequisite.
4. Load the routed skill. -> a skill in your available skills list loads by name. When
   the harness lists a newly installed skill only from the next session, find
   `skills/NAME/SKILL.md` under the install path and read that file.
5. Report each install, its path, and any prerequisite still missing. -> the user knows
   whether the skill loads natively now or from the next session.

## Rules

MUST Install only the rows in the table, from the listed repo and address.
MUST STOP and report when an install or probe fails. Never substitute your own guidance
  for the routed upstream.
ASK Before adding the `superdesign` marketplace or installing it: it needs an account and
  spends credits.
NOT Install a row the current route does not reach.
NOT Install a Python package globally with `pip`.
