# cad

Agent-assisted mechanical CAD for OpenCode: take a product from a rapid visual concept to a
released, documented design. The endpoint is a STEP AP242 model, drawings, an EBOM, a
verification matrix and design documentation. Parts are designed for FDM or CNC; the workflow
stops before slicer, CAM or machine-tool output.

FreeCAD 1.1.4 is the CAD application. CadQuery 2.8 and build123d 0.13 run as separate kernel
environments. Every script is a PEP 723 script run by [uv](https://docs.astral.sh/uv/).

The skills, the lamp-arm example and the worker agent prompts come from
[srobroek/cad-agent](https://github.com/srobroek/cad-agent), vendored at the tag pinned in
[`cad-agent.json`](cad-agent.json). This plugin adds the OpenCode parts: the `cad_run`,
`cad_stop` and `cad_setup` tools, the agents' OpenCode permissions, and the Beads formulas.

## Install

```sh
opencode plugin add 'github:srobroek/opencode-plugins::path:plugins/cad'
```

Then install FreeCAD 1.1.4 (see the `cad-drawings` skill) and make sure `uv` is on `PATH`. Ask
the agent to "run the CAD design flow"; it loads the `cad-flow` skill, which runs setup and
preflight first:

```text
cad_run cad-flow/scripts/setup.py            # dry run; add --yes to act
cad_run cad-flow/scripts/preflight.py --warm --background
```

The skills write each script command as
`uv run --script "$CAD_SKILLS/cad-flow/scripts/run.py" <skill>/scripts/<script>.py <args>`, where
`$CAD_SKILLS` is the plugin's `skills/` directory. `cad_run` with that `script` and those `args`
runs the same command. Preflight's harness checks look for a cad-agent installer receipt, so they
warn under this plugin; the plugin itself provides the skills and agents.

## Tools

| Tool | What it does |
| --- | --- |
| `cad_run` | Runs `<skill>/scripts/<script>.py` with `args` through cad-flow's `run.py`, from the session directory, in uv's environment for the script's PEP 723 dependencies. Default timeout 20 minutes (at most 60). `background: true` starts a server and returns its pid and first stdout line. Asks permission per script. |
| `cad_stop` | Stops a background script `cad_run` started in this session. It knows only the scripts this OpenCode process started; after OpenCode restarts it refuses an earlier pid (see below). |
| `cad_setup` | Copies the eleven formulas into a beads workspace's `.beads/formulas/`. Identical copies stay; divergent ones need `force=true`; symlinked paths are refused. |

`cad_run` sets `CAD_VIEWER_SESSION_NAME` to the root OpenCode session (a subagent's session
resolves to the session that spawned it), so each session gets its own CAD viewer host and a
worker's capture reaches the lead's viewer. A `--session` argument still wins. Deleting a session
stops its viewer hosts and background scripts; disposing the plugin stops all of them.

After OpenCode restarts, `cad_stop` no longer knows servers started before the restart and
refuses their pids. Stop such a server with its skill's own stop command, such as
`cad_run cad-viewer/scripts/viewer.py stop`, or let its idle timeout end it: the concept server
(`cad-concept/scripts/serve.py`) has no stop command and exits after 30 idle minutes by default.

## Skills

| Skill | Responsibility |
| --- | --- |
| `cad-flow` | Lead procedure: stage loops, delegation, gates and the release boundary |
| `cad-record` | The structured hardware design record, layout API and validation |
| `cad-concept` | Rapid three.js concept variants in a live viewer |
| `cad-model` | Build, check and diff parametric CadQuery/build123d models |
| `cad-design` | F0 to F3 product fidelity and form-check gates |
| `cad-motion` | Pose assemblies, sweep joints with between-sample proofs and subsystem runs, pick worst-case poses, motion renders |
| `cad-render` | three.js PBR version renders and the image gallery |
| `cad-viewer` | Interactive OCP CAD Viewer inspection and Studio look-dev |
| `cad-analysis` | Static FreeCAD finite-element analysis at worst-case poses |
| `cad-bom` | Engineering bill of materials roll-up |
| `cad-drawings` | Engineering drawings from STEP and the design record |
| `cad-fits` | ISO 286 fit limits and tolerance stack-ups |
| `cad-recheck` | Recheck changed parts and dependents at the recheck threshold |
| `cad-review-dfm` | Read-only FDM/CNC manufacturability critique |
| `cad-review-mech` | Read-only mechanical design critique |

## Agents

The lead (your session) dispatches each stage's units to these subagents in one parallel batch,
integrates their results and builds one version per stage. Workers never change the shared
design record, build `hw/versions/`, write the beads ledger or ask the user.

| Agent | Role | Model tier | Permissions |
| --- | --- | --- | --- |
| `cad-concept-designer` (steps 100) | Drafts one L0 concept variant | `standard` | read; edit `.cad-work/*`; `cad_run` |
| `cad-part-designer` (steps 150) | Designs or details one unit's parts in a scratch copy and delivers them | `strong` | read; edit `.cad-work/*`; `cad_run` |
| `cad-sourcing-researcher` (steps 80) | Cited research for one purchased-part family | `standard` | read; web fetch and search |
| `cad-analyst` (steps 100) | Runs one L4 analysis case on an integrated version | `strong` | read; edit `.cad-work/*`; `cad_run` |
| `cad-mech-reviewer` (steps 60) | Read-only mechanical critique | `reviewer` | read |
| `cad-dfm-reviewer` (steps 60) | Read-only FDM/CNC critique | `reviewer` | read |

Each prompt is cad-agent's, with an OpenCode section that names the skills to load and, for the
three workers that run scripts, maps the prompt's `uv run --script` commands to `cad_run`.
cad-agent grants those workers a `uv *` shell prefix, which runs any program; here they have no
shell, and `cad_run` starts only a script under the plugin's `skills/`. Every agent denies
everything else, including spawning subagents, loads only `cad-*` skills, and may read the
installed CAD skills outside the project without a prompt. The model tier is an
`x-opencode-model-role` header; without the model-roles plugin the agents use the session model.
Permissions authorize tools; they are not a sandbox: the scripts `cad_run` starts write where
their documented CLI writes (for example `scratch.py deliver` writes `hw/parts/<PN>/`).

## Formulas

With [beads](../beads/README.md), run `bd init`, then the `cad_setup` tool. The three roots are
poured; the eight `mol-cad-*` molecules are bonded onto a root's fan-out or full-check steps, one
per unit:

```sh
bd mol pour cad-part --var product=lamp --var scope=hw/       # one-part product
bd mol pour cad-product --var product=lamp --var scope=hw/    # multi-part product
bd mol pour cad-touch --var product=lamp --var scope=hw/ ...  # ECO on a released part
```

Worker steps carry `execution_mode = "subagent"` and an `execution_agent_type` naming one of the
agents above, so the beads routing gate admits exactly that agent. Each built version is checked
fail-fast, cheapest first. LAYOUT freeze, PARTS, DETAIL and ANALYSIS each pass two gates; INTENT,
SPECIFY, VARIANT, DESIGN freeze and RELEASE are single human gates. The SPECIFY gate keeps the
concept stage closed until the user approves the requirements and verification plan. The lead
resolves the provisional gate once every fast check passes, which lets the next stage start; the
human gate opens after the full check passes and is resolved only with `bd gate resolve` after
explicit approval. A failed full check, a MAJOR L2 light-review finding or a change the user names
at the human gate voids the provisional approval and reopens the stage and every later step built
on that version. Nothing is frozen or released before the human gates.
[formulas/README.md](formulas/README.md) has the bonding commands;
`formulas/smoke-pour.sh` pours and bonds every formula in a scratch workspace.

## Git hook

`cad_run cad-recheck/scripts/install-hook.py --project <dir>` installs an opt-in pre-commit hook
(`core.hooksPath=.githooks`) that blocks a commit of staged `hw/` changes past the recheck
threshold until they carry a passing recheck stamp. It refuses to replace another hooks path or
an existing hook unless `--force`.

## Vendored files and updates

`skills/`, `examples/` and `agents/` are generated by `scripts/sync-cad.ts` from the cad-agent
tag and commit in `cad-agent.json`; never edit them here. The script copies cad-agent's
`skills/` and `examples/` without their test suites, which cad-agent's CI runs. It shortens the
three skill descriptions that pass this repository's 160-character limit, and builds each
`agents/<id>.md` from cad-agent's `agents/<id>.md`. To take a new cad-agent release:

```sh
bun scripts/sync-cad.ts --tag v0.2.0  # moves the pin in cad-agent.json and vendors that tag
bun run cad:check                  # fails when the vendored files differ from the pinned tag
```

CI runs `cad:check` whenever `plugins/cad` or the script changes. It also fails when the pinned
tag no longer names the pinned commit. A new cad-agent agent needs an entry in the script's
`AGENTS` table. Check the formulas against the new `cad-flow` stages and gates.

## Tests

`bun test plugins/cad scripts/sync-cad.test.ts` covers the tools, the formula routing and the
sync script. The formula ordering tests are Python:

```sh
python3 -m unittest discover -s plugins/cad/formulas -p 'test_*.py' -v
```
