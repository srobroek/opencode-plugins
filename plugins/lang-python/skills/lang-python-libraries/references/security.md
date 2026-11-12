# Python security and code audits

Choose security controls and optional audit tools by capability; check commands remain in `lang-python-quality` and `lang-python-testing`.

Checked 2026-11-12.

| Concern | Default | Use instead when | Avoid (why) |
| --- | --- | --- | --- |
| Cryptographic primitives | `cryptography` `50` | Existing audited protocol/library implementation | Homemade algorithms or protocol compositions |
| Password storage | `pwdlib` `0.3` with `argon2-cffi` `25` | Legacy hash verification only for migration | New `passlib` default: stale release evidence; never encrypt passwords for storage |
| JWT | `PyJWT` `2` with explicit algorithm/issuer/audience/time policy | `joserfc` `1` for broader JOSE; `Authlib` `1` for OAuth/OIDC | Token-selected algorithm; signature verification alone as authorization; `python-jose` `3` is not archived, do not invent that claim |
| Secret values | Deployment secret store; `pydantic-settings` `2` for validated settings | Powertools Parameters/agent for AWS retrieval/cache | Committed `.env`, secret logging, secrets in exception messages; settings models are not a vault |
| SSRF | Explicit destination policy with `httpx` `0.28`, address checks, redirect controls and egress restrictions | Dedicated fetch proxy for arbitrary external URLs | URL parser/client alone is not SSRF protection; DNS rebinding and metadata/private destinations need controls |
| Input/HTML | `pydantic` `2` validation, contextual escaping; `nh3` `0.3` for accepted HTML | Format-specific allowlists and bound SQL parameters | One universal sanitizer; archived `bleach`; Markdown rendering as sanitization |
| Security lint | Configured `ruff` `0.17` `S` rules | `bandit` `1` for required reporting/plugins/checks not covered by configured rules | Treating lint as assurance or claiming exact Ruff/Bandit parity |
| SAST | `opengrep` `1` with reviewed rules | `semgrep` `1` CE for permitted internal use; eligible CI analysis where entitlement is checked | Engine license and rule license are separate; Semgrep-maintained rules restrict some competing/SaaS uses |
| Secret scanning | Offline `betterleaks` `1` or `gitleaks` `8` hooks; server push protection | `trufflehog` `3` history/verification scan; `detect-secrets` `1` for baseline workflow | Verified-only discards unverifiable secrets; overlapping mandatory scanners without distinct coverage |
| Dependency audit/SCA | `uv` `0.13` audit in uv projects after pinned-version preview-policy check | `pip-audit` `2` for environments/requirements; `osv-scanner` `2` for broader supported artifacts | Claiming uv audit is absent; advisory scans do not prove vulnerability absence |
| Updates/provenance | One updater, cooldowns, reviewed locks and PyPI Trusted Publishing/attestations | `renovate` `44` where its workflow is required | Duplicate update bots; signatures/attestations as proof of harmless code |
| Python SBOM | `cyclonedx-bom` `8` with `cyclonedx-py` from supported inputs/deployed environment | `syft` `1` for images/artifacts; `cdxgen` `13` for source dependencies | Assuming direct `uv.lock` ingestion is explicitly supported by CycloneDX Python |
| License inventory | `pip-licenses` `5` with project allow/deny policy | `licensee` `10` for repository license detection | Repository license detection is not dependency compliance; metadata alone is not legal review |
| Unused dependencies | `deptry` `0.25` in the project's quality stack | Existing dependency analysis with equivalent checks | Whole-program reachability confused with import/dependency checks |
| Dead code | `vulture` `2`, initially report/gate only high-confidence findings | `skylos` `5` or `deadcode` `2` in a measured pilot with license review | Deleting dynamic-framework entry points on heuristic findings; Ruff `F401`/`F841` are not whole-project reachability |
| Duplication | Optional `jscpd` `5` report, excluding generated code | `PMD` `7` CPD for existing multilingual tooling | Arbitrary failure thresholds without baseline/review |
| Complexity | `complexipy` `8` for cognitive complexity (threshold 15, snapshot baseline, SARIF); Ruff `C901` in `ruff` `0.17` for cyclomatic | `lizard` `1` for supplemental multilingual reports; `flake8-cognitive-complexity` is stale and not faithful to the metric | Duplicate mandatory gates; `radon` `6`/`xenon` `0.9` as new defaults have stale activity evidence |
| Images/Dockerfiles | `grype` `0.121` plus `syft` `1`; `hadolint` `2` | `trivy` `0.76` only with verified artifacts/transitive-action review | Trivy had a documented supply-chain compromise in March `2026`; pinning a wrapper alone is insufficient |
| Workflow security | `zizmor` `1`, `actionlint` `1`, `pinact` `5` when GitHub workflows exist | Selected runner network monitoring/scheduled assessment | Treating action SHA pinning as verification of downloaded transitive tools |
| Hook runner | `prek` `0.5` | `pre-commit` `4` for compatible fallback; `lefthook` `2` for an existing alternative | Stacking hook frameworks for identical jobs |

## Rules

- Authorize tenant, object, action and fields in business/repository boundaries; gateways and JWT libraries cannot supply domain authorization.
- Use least-privilege credentials with rotation and bounded cache lifetimes. Redact source data before logs/traces/cassettes/SBOM diagnostics can expose it.
- Every finding/suppression needs an owner, reason and expiry; scan periodically as advisories change. Treat dead-code results as review evidence, not automatic deletion authority.
- Pin scanner binaries/actions and review downloaded artifacts. Check engine, rule and dependency licences separately.
- Keep one tool per distinct gate and exclude generated/vendor output where appropriate. Load `project-secrets` for actual credential handling.

## Sources

- [FastAPI auth/password guidance](https://fastapi.tiangolo.com/tutorial/security/oauth2-jwt/), [Passlib registry](https://pypi.org/project/passlib/), [cryptography](https://github.com/pyca/cryptography)
- [OWASP SSRF](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html), [URL parser warning](https://docs.python.org/3/library/urllib.parse.html), [nh3](https://nh3.readthedocs.io/)
- [Ruff security rules](https://docs.astral.sh/ruff/rules/#flake8-bandit-s), [Bandit](https://bandit.readthedocs.io/), [Opengrep](https://github.com/opengrep/opengrep), [Semgrep rule licensing changes](https://semgrep.dev/blog/2024/important-updates-to-semgrep-oss)
- [Betterleaks](https://github.com/betterleaks/betterleaks), [Gitleaks](https://github.com/gitleaks/gitleaks), [TruffleHog](https://github.com/trufflesecurity/trufflehog), [push protection](https://docs.github.com/en/code-security/secret-scanning/introduction/about-push-protection)
- [uv audit preview](https://astral.sh/blog/uv-audit), [uv audit](https://docs.astral.sh/uv/reference/cli/#uv-audit), [pip-audit](https://github.com/pypa/pip-audit), [OSV](https://github.com/google/osv-scanner)
- [CycloneDX supported inputs](https://github.com/CycloneDX/cyclonedx-python), [PyPI attestations](https://docs.pypi.org/attestations/), [pip-licenses](https://github.com/raimon49/pip-licenses)
- [Vulture limitations](https://github.com/jendrikseipp/vulture), [deptry registry](https://pypi.org/project/deptry/), [jscpd](https://github.com/kucherenko/jscpd)
- [Trivy incident](https://github.com/aquasecurity/trivy/security/advisories/GHSA-69fq-xp46-6x23), [Grype](https://github.com/anchore/grype), [prek](https://github.com/j178/prek), [Package version registry](https://pypi.org/)
