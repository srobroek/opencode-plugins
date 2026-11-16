# TypeScript quality libraries

Choose lint, format, type, audit, API-break and docs tools by capability; `lang-typescript-quality` owns the check commands. Test tools are in [testing.md](testing.md); crypto, secrets, SBOM and image scanning are in [security.md](security.md).
Follow the install policy in `toolchain-languages` `concerns.md`: detect with the first command, recommend the install command, and ask before you add a dependency. Install commands use `npm i -D`; use the project's package manager equivalent (`bun add -d`, `pnpm add -D`).

Checked 2026-11-16.

## Concerns

| Concern | Default | Maintenance | Install | Alternatives | Use both when | Run | Avoid |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `lint` | `@biomejs/biome` (`biome check`), with import sorting and complexity rules on | >= 2.6.8 · 2026-11-15 · active | `node_modules/.bin/biome --version` · `npm i -D @biomejs/biome` | eslint with typescript-eslint: a named gap such as a wide type-aware rule set, a mature framework plugin (Angular templates, full Vue) or a plugin without a Biome port such as eslint-plugin-security; oxlint: an optional fast second linter with type-aware rules | ESLint with only the gap rules enabled and every overlapping Biome rule off | every-pr | A second linter with the same rules; ESLint added without naming the gap; `biome check --write .` over the whole tree during a task |
| `format` | `@biomejs/biome` (`biome format`) for every language it formats in the installed version | >= 2.6.8 · 2026-11-15 · active | `node_modules/.bin/biome --version` · `npm i -D @biomejs/biome` | prettier: Vue, Angular or HTML where Biome is partial or experimental | - | every-pr | Two formatters on one file type; Prettier for files Biome already formats (Biome is about 97% Prettier-compatible) |
| `types` | Built-in: `tsc --noEmit`, or `tsc -b` when `tsconfig.json` has `references` | - | Built-in | None | `typescript-eslint` type-aware rules only for named gaps | every-pr | Node type stripping or Bun transpilation as type checking; `tsc --noEmit` on a solution file with `"files": []`; tools that need the TypeScript 6 API without an alias |
| `sast` | Shared: semgrep | - | Shared | opengrep: the same rule format from a community fork; eslint-plugin-security: selected JS heuristics in an ESLint stack (4.2.1); codeql: data-flow depth for an eligible repository, run as the Shared `codeql` tool | the Shared `codeql` row on a schedule beside diff-scoped Semgrep on every PR | every-pr + scheduled | Counting Biome as security coverage: it has no security ruleset; lint treated as taint analysis; engine and rule licences confused for Semgrep |
| `memory-safety` | N/A: managed runtime | - | - | None | Native addons: build them with ASan or UBSan and run the addon tests under the sanitizer | - | Reading a pure-TypeScript suite as evidence about native addon memory safety |
| `dep-audit` | Built-in: `bun audit` (Bun 1.4 adds `bun audit fix`) or `npm audit` | - | Built-in | osv-scanner: one report across lockfiles of several ecosystems, run as the Shared `osv-scanner` tool | `osv-scanner` for non-npm manifests in the same repository | every-pr + scheduled | An empty audit as proof of safety; unreviewed `audit fix` major upgrades; `audit-ci` (stale) |
| `dead-code` | `knip` | >= 6.45.1 · 2026-11-11 · active | `node_modules/.bin/knip --version` · `npm i -D knip` | None | - | every-pr | Deleting dynamic-framework entry points on a first run without a Knip config; `ts-prune`, `ts-unused-exports` and `depcheck` (stale); `unimported` (deprecated) |
| `unused-deps` | `knip` | >= 6.45.1 · 2026-11-11 · active | `node_modules/.bin/knip --version` · `npm i -D knip` | None | - | every-pr | `depcheck` (stale); removing a dependency that only a config file or script uses before Knip's plugins cover it |
| `complexity` | `@biomejs/biome` rule `noExcessiveCognitiveComplexity` set to error with `maxAllowedComplexity` 15 | >= 2.6.8 · 2026-11-15 · active | `node_modules/.bin/biome --version` · `npm i -D @biomejs/biome` | lizard: multilingual cyclomatic reports, run as the Shared `lizard` tool | - | every-pr | eslint-plugin-sonarjs: scores differ from Biome's and it ships under the Sonar Source-Available License, a second complexity gate beside Biome; leaving the rule at its default severity, which is information; gating total repository complexity instead of new functions |
| `duplication` | Shared: jscpd | - | Shared | None | - | scheduled | Arbitrary failure thresholds without a baseline; generated code in the scan; mechanical deduplication of coincidentally similar code |
| `api-break` | `@microsoft/api-extractor` with a committed `.api.md` report as the public surface gate | >= 7.60.1 · 2026-10-30 · active | `node_modules/.bin/api-extractor --version` · `npm i -D @microsoft/api-extractor` | None | `@arethetypeswrong/cli` and `publint` on every PR for packaging correctness beside the API report; the Shared `oasdiff` row for an OpenAPI surface | every-pr | Skipping it for a published library; running it in an app with no public surface; API Extractor on TypeScript 7 alone, it needs the TypeScript 6 API; `tsd` (stale), `ts-api-guardian` (dead), `@clerk/break-check` and `ts-semver-checks` (young 0.x tools, not recommended) |
| `docs` | `typedoc` with validation and `treatWarningsAsErrors` | >= 0.28.20 · 2026-07-05 · active | `node_modules/.bin/typedoc --version` · `npm i -D typedoc` | api-documenter: the API Extractor report is the contract, with `@microsoft/api-documenter` (7.30.20) | `typedoc-plugin-markdown` (4.14.1) when the docs go into a Markdown site | every-pr | Generated docs as a substitute for usage guides; `@microsoft/tsdoc` as a generator, it defines comment syntax only; TypeDoc on TypeScript 7 alone, keep the TypeScript 6 alias |

## Tradeoffs

### lint

- **@biomejs/biome**: wins on one fast binary that lints, formats and sorts imports with a single config; costs fewer rules than ESLint, mostly nursery type-aware ones, and no plugin ecosystem.
- **eslint with typescript-eslint**: wins when a rule has no Biome equivalent, such as the wide type-aware set (Biome's `types` domain rules are mostly nursery), Angular templates, full Vue or a plugin without a Biome port; costs a slower run, a second config and a TypeScript 6 API requirement under TypeScript 7.
- **oxlint**: wins as a fast optional second linter with type-aware rules through `oxlint-tsgolint`; costs overlapping findings with Biome, so enable it only for rules Biome lacks.

### sast

- **opengrep**: wins when you want the Semgrep rule format from a community fork with no vendor rule licence; costs a younger project.
- **eslint-plugin-security**: wins when the project already runs ESLint and wants cheap JS heuristics; costs noisy pattern matches and no taint tracking.
- **codeql**: wins when data-flow analysis in CI matters and the repository is eligible; costs a slower run, so keep it scheduled.

### complexity

- **lizard**: wins when several languages need one report; costs cyclomatic metrics only.

## Language-specific

| Topic | Default | Use instead when | Avoid (why) |
| --- | --- | --- | --- |
| Import sorting | Biome `organizeImports` assist | `eslint-plugin-import` rules only for a named gap | A sorter plugin beside Biome's: they fight over order |
| Package correctness | `@arethetypeswrong/cli` (>= 0.18.5) and `publint` (>= 0.3.25) before publishing and on every PR for a library | None | Hand-reviewing `exports` maps only; see `lang-typescript-packaging` |
| TypeScript 6 API alias | A `@typescript/typescript6` alias (or `typescript@^6`) beside `typescript` 7 for typescript-eslint, TypeDoc, API Extractor and the Bun Stryker runner | Drop it once each tool supports the TypeScript 7 API | Pinning the whole project to TypeScript 6 for one tool; TypeScript 7.0 has no stable programmatic API |

## Rules

- One tool per gate. Every finding or suppression needs an owner, reason and expiry; scan periodically because advisories change.
- Biome is the default wherever it can be. Add ESLint or Prettier only for a named gap, and report the gap.
- Treat dead-code and duplication results as review evidence, not deletion authority; exclude generated and vendor output.
- Keep the project's configured checker; new modules stay clean under strict mode.

## Sources

- [Biome](https://biomejs.dev/), [Biome complexity rule](https://biomejs.dev/linter/rules/no-excessive-cognitive-complexity/), [ESLint](https://eslint.org/), [typescript-eslint](https://typescript-eslint.io/), [Oxlint](https://oxc.rs/docs/guide/usage/linter.html), [Prettier](https://prettier.io/).
- [Semgrep licensing](https://semgrep.dev/blog/2024/important-updates-to-semgrep-oss), [Opengrep](https://github.com/opengrep/opengrep), [eslint-plugin-security](https://github.com/eslint-community/eslint-plugin-security).
- [bun audit](https://bun.com/docs/pm/cli/audit), [npm audit](https://docs.npmjs.com/cli/commands/npm-audit), [Knip](https://knip.dev/), [unimported status](https://github.com/smeijer/unimported), [jscpd](https://github.com/kucherenko/jscpd).
- [API Extractor](https://api-extractor.com/), [Are the Types Wrong?](https://github.com/arethetypeswrong/arethetypeswrong.github.io), [publint](https://publint.dev/), [TypeDoc](https://typedoc.org/), [typedoc-plugin-markdown](https://typedoc-plugin-markdown.org/), [Registry metadata](https://registry.npmjs.org/).
