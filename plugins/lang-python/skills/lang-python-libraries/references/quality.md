# Python quality libraries

Choose lint, type, audit and docs tools by capability; `lang-python-quality` owns the check commands. Test tools are in [testing.md](testing.md); crypto, secrets, SBOM and image scanning are in [security.md](security.md).
Follow the install policy in `toolchain-languages` `concerns.md`: detect, recommend the install command, and ask before you add a dependency.

Checked 2026-11-16.

## Concerns

| Concern | Default | Maintenance | Install | Alternatives | Use both when | Run | Avoid |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `lint` | `ruff check` with the project's rule set | >= 0.17 · 2026-11-12 · pre-1.0 | `uv pip show ruff` · `uv add --dev ruff` | pylint: only for checks Ruff lacks | `pylint` with a narrow enabled set for rules Ruff has no equivalent for | every-pr | `ruff check --fix .` on the whole tree during a task; a second linter with the same rules |
| `format` | `ruff format` | >= 0.17 · 2026-11-12 · pre-1.0 | `uv pip show ruff` · `uv add --dev ruff` | black: the project already formats with it | - | every-pr | Two formatters on one tree |
| `types` | `pyright`, or `mypy` when the project configures it; strict for new code | >= 1.1.400 · 2026-09-10 · active | `uv pip show pyright` · `uv add --dev pyright` | mypy: the project already configures it (2.4, 2026-10-28); basedpyright: stricter defaults and baseline files (1.40, 2026-10-04); pyrefly: advisory second checker (1.4, stable since 1.0); ty: advisory second checker, beta (0.0.104) | `pyrefly` or `ty` as a non-blocking second opinion beside the gate | every-pr | Two gating type checkers; making a beta checker the gate; flipping the project's strictness setting instead of keeping new modules strict |
| `sast` | `ruff` `S` rules (flake8-bandit port), configured in `pyproject.toml` | >= 0.17 · 2026-11-12 · pre-1.0 | `uv pip show ruff` · `uv add --dev ruff` | opengrep: reviewed cross-language and taint rules; semgrep: permitted internal use with entitlement checked; bandit: required reporting or plugins | the Shared `opengrep` or `semgrep` row for taint and framework rules beside Ruff `S` | every-pr | Lint treated as assurance; `bandit` as a new default (adds little over Ruff `S`); engine and rule licences are separate for Semgrep |
| `memory-safety` | N/A: managed runtime | - | - | None | Native extensions: Atheris with ASan or UBSan, `memray` (1.20) with `pytest-memray` (1.11), `python -X dev`, `faulthandler` | - | Treating a pure-Python suite as evidence about native extension memory safety |
| `dep-audit` | `pip-audit` | >= 2.10 · 2026-06-10 · active | `uv pip show pip-audit` · `uv add --dev pip-audit` | osv-scanner: broader artifacts and lockfiles, run as the Shared `osv-scanner` tool; uv audit: report-only preview in uv projects | `osv-scanner` for non-Python manifests in the same repository | every-pr + scheduled | Gating on `uv audit` while it is a preview; `safety` (commercial); advisory scans as proof that vulnerabilities are absent |
| `dead-code` | `vulture`, gating only high-confidence findings at first | >= 2.16 · 2026-03-25 · active | `uv pip show vulture` · `uv add --dev vulture` | deadcode: measured pilot after licence review (AGPL) | - | every-pr | Deleting dynamic-framework entry points on heuristic findings; Ruff `F401` and `F841` only cover imports and locals, not whole-project reachability |
| `unused-deps` | `deptry` | >= 0.25 · 2026-03-18 · pre-1.0 | `uv pip show deptry` · `uv add --dev deptry` | None | `import-linter` contracts for layering, not dependencies | every-pr | Whole-program reachability confused with import and dependency checks |
| `complexity` | `complexipy` for cognitive complexity with a snapshot baseline | >= 9.0 · 2026-11-13 · active | `uv pip show complexipy` · `uv add --dev complexipy` | lizard: multilingual reports, run as the Shared `lizard` tool; ruff: cyclomatic `C901` inside the lint run | `ruff` `C901` for cyclomatic beside `complexipy` for cognitive | every-pr | Two mandatory gates on the same metric; `radon` and `xenon` (unmaintained); `flake8-cognitive-complexity` (stale) |
| `duplication` | Shared: jscpd | - | Shared | pylint: `R0801` when pylint already runs | - | scheduled | Arbitrary failure thresholds without a baseline; generated code in the scan |
| `api-break` | `griffe check` (package `griffecli`) against the last release | >= 2.4 · 2026-10-22 · active | `uv pip show griffe` · `uv add --dev griffe` | None | The Shared `oasdiff` row for an OpenAPI surface | every-pr + release | Skipping applications with no public import surface; `aexpy` (stale) |
| `docs` | `sphinx-autoapi` with Sphinx, built with `sphinx-build -W` | >= 9.2 · 2026-10-21 · active | `uv pip show sphinx` · `uv add --dev sphinx sphinx-autoapi` | zensical: new Markdown sites, with `mkdocstrings-python` 2.0 (beta, 0.1); mkdocs: existing sites only, pin `mkdocs<2`; pdoc: small internal references | - | every-pr | New MkDocs or Material for MkDocs adoption (unreleased since 2024-08, Material EOL 2027-05-05); a warning-tolerant docs build; Sphinx 9.2 metadata requires Python 3.13 or later, so build docs in their own environment on older runtimes |

## Tradeoffs

### lint

- **ruff**: wins when speed and one tool for lint, import sort and security rules matter; costs a pre-1.0 rule set that changes between minor releases.
- **pylint**: wins when a check has no Ruff equivalent; costs slower runs and overlapping findings.

### types

- **pyright**: wins when the project has no checker yet or uses VS Code; costs a Node-based wrapper download.
- **mypy**: wins when the project already configures plugins and `mypy.ini`; costs slower runs and differing inference.
- **basedpyright**: wins when baseline files and stricter defaults are wanted; costs a community fork.
- **pyrefly**: wins as an extra fast opinion on a large codebase; costs different inference, so findings can disagree with the gate.
- **ty**: wins as an experimental fast second opinion; costs beta stability.

### sast

- **ruff**: wins when the rule set is already in the lint run; costs no taint analysis.
- **opengrep**: wins when reviewed community rules and taint tracking are needed under an open licence; costs rule curation.
- **semgrep**: wins when its managed rules are permitted for the use; costs rule licence limits.
- **bandit**: wins when a compliance report or plugin requires it; costs duplicated findings.

### dep-audit

- **pip-audit**: wins when the environment or `requirements` export is the audit target; costs Python-only coverage.
- **osv-scanner**: wins when many ecosystems share one report; costs coarser Python resolution.
- **uv audit**: wins when the project is already on uv and a quick report is enough; costs preview status.

### complexity

- **complexipy**: wins when cognitive complexity with a baseline is the goal; costs a Python-only tool.
- **lizard**: wins when several languages need one report; costs cyclomatic metrics only.
- **ruff**: wins when `C901` in the lint run is enough; costs cyclomatic only and no baseline.

### docs

- **sphinx-autoapi**: wins when a library needs generated reference with cross-references; costs reStructuredText tooling and Python 3.13 for Sphinx 9.2.
- **zensical**: wins when a new Markdown site is started with `mkdocstrings-python`; costs beta stability.
- **mkdocs**: wins when an existing site depends on it; costs an unreleased core and a retiring Material theme.
- **pdoc**: wins when a small internal reference is enough; costs few extension points.

## Language-specific

| Topic | Default | Use instead when | Avoid (why) |
| --- | --- | --- | --- |
| Hook runner | `prek` | `pre-commit` for compatible fallback; `lefthook` for an existing setup | Stacking hook frameworks for identical jobs |
| Import contracts | `import-linter` where layers are documented | Ruff `TID` rules for simple bans | Contracts nobody enforces in CI |

## Rules

- One tool per gate. Every finding or suppression needs an owner, reason and expiry; scan periodically because advisories change.
- Treat dead-code and duplication results as review evidence, not deletion authority; exclude generated and vendor output.
- Keep the project's configured checker; new modules stay clean under strict mode.

## Sources

- [Ruff](https://docs.astral.sh/ruff/), [Ruff security rules](https://docs.astral.sh/ruff/rules/#flake8-bandit-s), [pylint](https://pylint.readthedocs.io/), [Black](https://black.readthedocs.io/)
- [Pyright](https://microsoft.github.io/pyright/), [mypy](https://mypy.readthedocs.io/), [basedpyright](https://docs.basedpyright.com/), [pyrefly](https://pyrefly.org/), [ty](https://docs.astral.sh/ty/)
- [Opengrep](https://github.com/opengrep/opengrep), [Semgrep licensing](https://semgrep.dev/blog/2024/important-updates-to-semgrep-oss), [Bandit](https://bandit.readthedocs.io/)
- [pip-audit](https://github.com/pypa/pip-audit), [uv audit](https://docs.astral.sh/uv/reference/cli/#uv-audit), [OSV](https://github.com/google/osv-scanner)
- [Vulture](https://github.com/jendrikseipp/vulture), [deptry](https://github.com/fpgmaas/deptry), [complexipy](https://github.com/rohaquinlop/complexipy), [Griffe](https://mkdocstrings.github.io/griffe/), [Sphinx](https://www.sphinx-doc.org/), [Zensical](https://zensical.org/), [prek](https://github.com/j178/prek), [Package version registry](https://pypi.org/)
