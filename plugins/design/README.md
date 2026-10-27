# design

UI and UX design for OpenCode: eight workflow skills, five design rules as skills,
four design subagents, nine beads formulas with a `design_setup` tool that installs
them, and a `design_impeccable_scan` tool that runs impeccable's detector.

## Skills

| Skill | Phase | When |
| --- | --- | --- |
| `design-system-audit` | GROUND | Inventory existing tokens, scales and primitives before UI work |
| `design-md` | SPECIFY | Write or update `DESIGN.md` from the audit, then lint it |
| `design-prototype` | SPECIFY | Route a wireframe, mockup, prototype or deck request to the right producer |
| `wireloom` | SPECIFY | A wireframe as a fenced `wireloom` block rendered to SVG (vendored) |
| `motion-design` | BUILD | Durations, easings and reduced-motion branches from the project scale |
| `ui-microcopy` | BUILD | Errors, empty states, CTAs, confirmations and onboarding copy (vendored guidance) |
| `ui-review` | VERIFY | Drive the rendered surface: ARIA snapshot, computed styles, keyboard walk, three widths |
| `accessibility-audit` | CRITIQUE | WCAG 2.2 AA with measured values |

On omp these five were rules; here they are skills the workflow skills and agents
load by name:

| Skill | When |
| --- | --- |
| `design-token-discipline` | Styling a component or editing tokens: named tokens only, approval for new scales |
| `design-no-slop` | Critiquing or building a rendered UI: generated-UI tells and missing states |
| `design-component-truth` | Passing component props or writing stories: verify every prop against its docs |
| `design-evidence` | Any claim about a rendered surface: ARIA, computed style or screenshot, plus the width |
| `design-upstream-preflight` | Before routing to an upstream skill or CLI: install and probe only what the route needs |

## Agents

| Agent | Role | Permissions |
| --- | --- | --- |
| `ui-ux-specialist` | Leads multi-component UI work through GROUND, GATE INTENT, SPECIFY, BUILD, VERIFY, CRITIQUE, RECONCILE, GATE ACCEPT | may spawn only `design-critic`, `a11y-auditor`, `explore` and `general` |
| `ui-implementer` | Builds one UI unit on existing tokens and components, verified at 1440, 768 and 375 px; escalates anything bigger | no web search or fetch, no subagents |
| `design-critic` | Read-only critique for hierarchy, rhythm and generated-UI tells | no edit, shell or subagents |
| `a11y-auditor` | Read-only WCAG 2.2 AA audit with measured values | no edit or subagents; shell only for preflight probes and the axe CLI fallback, by prompt |

All four are `subagent` agents converted with `scripts/convert-agent.ts`. Rules are
added after any you configure for an agent with the same id. `ui-ux-specialist`
spawning children while it runs as a subagent needs `experimental.subagent_depth`
of 2 or more. `ui-ux-specialist` runs at most 400 steps. The agents pin no model;
each declares a model tier through the `x-opencode-model-role` request header, so
with the model-roles plugin that tier picks its model, and without it the agent
inherits the caller's model:

| Agent | Model tier |
| --- | --- |
| `ui-ux-specialist` | `strong` |
| `ui-implementer` | `strong` |
| `design-critic` | `reviewer` |
| `a11y-auditor` | `reviewer` |

The browser steps need a browser the agent can drive: the OpenCode desktop browser
tools, a browser MCP server, or Playwright through the shell. The `ui-review` skill's
`references/tools.md` maps each step to both.

## Tools

| Tool | What it does |
| --- | --- |
| `design_setup` | Copies the nine formulas into a beads workspace's `.beads/formulas/`. Identical copies stay; a divergent copy is refused unless `force=true`; a symlinked `.beads` or formulas path is refused. The workspace needs `.beads/` already (`bd init`). |
| `design_impeccable_scan` | Runs `npx --yes impeccable detect --json` over files, directories or a URL (optional `viewport`, `noConfig`, `timeoutSeconds`) and returns the JSON. Exit 0 is clean, 2 is findings, 1 is a target it could not scan. |

Both ask permission. `design_impeccable_scan` asks before every run even when a rule
allows it, because npx may download impeccable and its engine; set the plugin option
`confirmScan: false` to leave it to your permission rules:

```jsonc
{
  "plugins": [{
    "package": "github:srobroek/opencode-plugins::path:plugins/design",
    "options": { "confirmScan": false }
  }]
}
```

Detector findings are a coarse corroborating signal: HTML-engine findings can carry
`"line": 0`, so the critique confirms each one on the rendered surface.

## Formulas

Install them with the `design_setup` tool, or copy `formulas/*.formula.toml` into
`<repo>/.beads/formulas/` (or `~/.beads/formulas/`) yourself; `bd formula list` then
shows them. They need bd 1.3 and the beads plugin.

Three tiers are poured, one molecule per piece of work:

```sh
bd mol pour design-touch --var surface=<route> --var scope=<paths>    # 8 steps, 1 human gate
bd mol pour design-surface --var surface=<route> --var scope=<paths>  # 15 steps, 3 human gates
bd mol pour design-system --var surface=<route> --var scope=<paths>   # 22 steps, 3 human gates
```

Optional vars: `platform` (default `web`), `want_design_md` (default `false`), and on
`design-system` `themes` and `density`.

Six sub-processes are bonded onto the step whose result called for them:

| Formula | Bond it when | Extra vars |
| --- | --- | --- |
| `mol-design-a11y` | an accessibility audit returned MAJOR | `round` |
| `mol-design-component` | a primitive needs its own isolated build | `component` |
| `mol-design-iterate` | the user wants another round of visual intent | `round` |
| `mol-design-motion` | motion or reduced-motion needs a pass | |
| `mol-design-responsive` | reflow or target size failed | |
| `mol-design-tokens` | the system audit returned ABSENT or PARTIAL | |

```sh
bd mol bond mol-design-iterate <step-id> --var surface=<route> --var node=<step-id> --var round=2
```

Every var of a `mol-` formula is required: `bd mol bond` does not apply var defaults.
The critique and audit steps carry `execution_agent_type` `design-critic` or
`a11y-auditor` with `execution_mode` `subagent`, so the beads plugin's routing gate
admits a spawn of that agent and blocks a spawn of any other.

## MCP servers

The plugin adds no MCP servers. Add the ones you use to `opencode.json`:

```jsonc
{
  "mcp": {
    "servers": {
      "accessibility-scanner": {
        "type": "local",
        "command": ["npx", "-y", "accessibility-scanner-mcp@0.2.3"]
      },
      "wire-dsl": {
        "type": "local",
        "command": ["npx", "-y", "@wire-dsl/mcp-server@0.1.3"]
      },
      "storybook": {
        "type": "remote",
        "url": "http://localhost:6006/mcp",
        "oauth": false,
        "disabled": true
      }
    }
  }
}
```

- `accessibility-scanner` is the primary measurement route of `accessibility-audit`
  and `a11y-auditor`. It needs a local Google Chrome or `CHROME_PATH`.
- `wire-dsl` renders vector wireframes for `design-prototype`.
- `storybook` serves component documentation for `design-component-truth` and
  `ui-review`. Enable it while `storybook dev` runs with `@storybook/addon-mcp`.

On omp the plugin declared these servers itself; the reasons for keeping them in
config are the same as for the aws plugin: a global plugin would start them in every
project, and config keeps versions and flags visible.

## Changes from omp

- Rules became skills, and `skill://` and `rule://` references name the skill or use
  a relative path.
- Browser steps no longer use the omp `browser`/`computer` helpers through `eval`
  (`tab.ariaSnapshot()`, `tab.emulate`, `tab.diffScreenshot`, Tern and relay modes).
  They name what each step measures; `ui-review/references/tools.md` maps each step to
  the OpenCode desktop browser tools and to Playwright, and the console and viewport
  probes use Playwright's API. Native surfaces use a desktop accessibility inspector.
- Dev servers run as background shell processes instead of omp's named `bash`
  services and `proc://` listing.
- The accessibility scanner is an MCP tool call instead of an `xd://` device write;
  image generation and `inspect_image` are described as harness tools when present.
- `design-upstream-preflight` installs an upstream skill through Claude Code
  (`claude plugin install`) or, for OpenCode, a clone added to the `skills` config,
  instead of `omp plugin install`. `a11y-auditor` reports a missing upstream instead
  of installing it.
- The agents' `autoloadSkills` became a "load these skills" line; `scout` became
  `explore`; the delivery `researcher` and `operator` children became a web search and
  the built-in `general` agent.
- The beads formulas name skills instead of `skill://` and `rule://` URIs, the browser
  tools or a desktop accessibility inspector instead of `browser` and `computer`, an
  LSP rename instead of the `lsp` tool, and Playwright's `page.emulateMedia` instead of
  `tab.emulate`. Their critique steps run `design_impeccable_scan` instead of npx.
- `mol-design-a11y` and `mol-design-iterate` make `round` required: it had a default,
  and `bd mol bond` fails on a var it was not passed even when the formula declares a
  default.
- The impeccable `PostToolUse` hook became the `design_impeccable_scan` tool. The hook
  ran impeccable's launcher after every UI file write, which fetches the engine from
  the network unasked; impeccable itself tells a harness without its hook to run
  `detect` once the changed UI is finished, which is where the formulas and
  `ui-ux-specialist` run the tool. The launcher-path note for
  `impeccable-asset-producer` is dropped with it: that agent is not registered here.

## Attribution

`design-md`, `ui-microcopy` and `wireloom` carry vendored upstream material; each
skill directory has its LICENSE and NOTICE. The other upstream skills the workflow
routes to are installed from their authors, never bundled; see
`design-upstream-preflight`.

## Install

```sh
opencode plugin add 'github:srobroek/opencode-plugins::path:plugins/design'
```

Claude Code and Codex install the skills, not the agents, from this repository's
marketplace:

```sh
claude plugin marketplace add srobroek/opencode-plugins
claude plugin install design@srobroek-opencode

codex plugin marketplace add srobroek/opencode-plugins
codex plugin add design@srobroek-opencode
```
