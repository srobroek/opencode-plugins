# design

UI and UX design content: eight workflow skills, five design rules as skills, and
four design subagents. Content only; the impeccable detector hook is separate work.

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
each declares a model role through the `x-opencode-model-role` request header, so
with the model-roles plugin that role picks its model, and without it the agent
inherits the caller's model:

| Agent | Model role |
| --- | --- |
| `ui-ux-specialist` | `designer` |
| `ui-implementer` | `designer` |
| `design-critic` | `reviewer` |
| `a11y-auditor` | `reviewer` |

The browser steps need a browser the agent can drive: the OpenCode desktop browser
tools, a browser MCP server, or Playwright through the shell. The `ui-review` skill's
`references/tools.md` maps each step to both.

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

## Not ported

- The nine beads formulas (`design-touch`, `design-surface`, `design-system` and the
  `mol-design-*` sub-processes). They need the formula tooling of the beads plugin.
- The `impeccable detect` hook. `ui-ux-specialist` still runs `impeccable detect`
  itself at CRITIQUE.

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
