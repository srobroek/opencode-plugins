# cad

Agent-assisted mechanical CAD for OpenCode: take a product from a rapid visual concept to a
released, documented design. The endpoint is a STEP AP242 model, drawings, an EBOM, a
verification matrix and design documentation. Parts are designed for FDM or CNC; the workflow
stops before slicer, CAM or machine-tool output.

FreeCAD 1.1.4 is the CAD application. CadQuery 2.8 and build123d 0.13 run as separate kernel
environments. Every script is a PEP 723 script run by [uv](https://docs.astral.sh/uv/).

Ported from the omp `cad` plugin; [docs/design/cad.md](../../docs/design/cad.md) maps each omp
mechanism to its OpenCode replacement.

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

The skills are OpenCode-only: they run their scripts through `cad_run`, so the plugin is not
exported to Claude Code or Codex.

## Tools

| Tool | What it does |
| --- | --- |
| `cad_run` | Runs `<skill>/scripts/<script>.py` with `args` through cad-flow's `run.py`, from the session directory, in uv's environment for the script's PEP 723 dependencies. Default timeout 20 minutes (at most 60). `background: true` starts a server and returns its pid and first stdout line. Asks permission per script. |
| `cad_stop` | Stops a background script `cad_run` started in this session. It knows only the scripts this OpenCode process started; after OpenCode restarts it refuses an earlier pid (see below). |
| `cad_setup` | Copies the eleven formulas into a beads workspace's `.beads/formulas/`. Identical copies stay; divergent ones need `force=true`; symlinked paths are refused. |

`cad_run` sets `CAD_SESSION_ID` to the root OpenCode session (a subagent's session resolves to
the session that spawned it), so each session gets its own CAD viewer host, and
`CAD_OPENCODE_PLUGIN`, which preflight reports. Deleting a session stops its viewer hosts and
background scripts; disposing the plugin stops all of them.

After OpenCode restarts, `cad_stop` no longer knows servers started before the restart and
refuses their pids. Stop such a server with its skill's own stop command, such as
`cad_run cad-viewer/scripts/viewer.py stop`, or let its idle timeout end it: the concept server
(`cad-concept/scripts/serve.py`) has no stop command and exits after 30 idle minutes by default.

## Skills

| Skill | Responsibility |
| --- | --- |
| `cad-flow` | Lead procedure: stage loops, formula routing, gates and the release boundary |
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
| `cad-concept-designer` | Drafts one L0 concept variant | `standard` | read; edit `.cad-work/*`; `cad_run` |
| `cad-part-designer` | Designs or details one unit's parts in a scratch copy and delivers them | `strong` | read; edit `.cad-work/*`; `cad_run` |
| `cad-sourcing-researcher` | Cited research for one purchased-part family | `standard` | read; web fetch and search |
| `cad-analyst` | Runs one L4 analysis case on an integrated version | `strong` | read; edit `.cad-work/*`; `cad_run` |
| `cad-mech-reviewer` | Read-only mechanical critique | `reviewer` | read |
| `cad-dfm-reviewer` | Read-only FDM/CNC critique | `reviewer` | read |

Every agent denies everything else, including shell and spawning subagents, loads only `cad-*`
skills, and may read the installed CAD skills outside the project without a prompt. The model
tier is an `x-opencode-model-role` header; without the model-roles plugin the agents use the
session model. Permissions authorize tools; they are not a sandbox: the scripts `cad_run` starts
write where their documented CLI writes (for example `scratch.py deliver` writes
`hw/parts/<PN>/`).

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
VARIANT, DESIGN freeze and RELEASE are single human gates. The lead resolves the provisional gate
once every fast check passes, which lets the next stage start; the human gate opens after the full
check passes and is resolved only with `bd gate resolve` after explicit approval. A failed full
check, a MAJOR L2 light-review finding or a change the user names at the human gate voids the
provisional approval and reopens the stage and every later step built on that version. Nothing is
frozen or released before the human gates.
[formulas/README.md](formulas/README.md) has the bonding commands;
`formulas/smoke-pour.sh` pours and bonds every formula in a scratch workspace.

## Git hook

`cad_run cad-recheck/scripts/install-hook.py --project <dir>` installs an opt-in pre-commit hook
(`core.hooksPath=.githooks`) that blocks a commit of staged `hw/` changes past the recheck
threshold until they carry a passing recheck stamp. It refuses to replace another hooks path or
an existing hook unless `--force`.

## Tests

The Python suites live with the skills. Run each file on its own, as CI does:

```sh
for test in $(git ls-files 'plugins/cad/skills/*/test_*.py'); do
  uv run --no-project --with pyyaml==6.0.3 --with jsonschema==4.26.0 --with defusedxml==0.7.1 \
    python -m unittest discover -s "$(dirname "$test")" -p "$(basename "$test")" -v
done
```

FreeCAD tests skip when `freecadcmd` is missing; set `FREECADCMD` or install the macOS app
bundle to run them. The plugin's TypeScript tests run with `bun test plugins/cad`.
