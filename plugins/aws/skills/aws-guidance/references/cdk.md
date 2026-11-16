# AWS CDK testing and quality concerns

Checked 2026-11-16.

Rows follow the spec in
[concerns.md](../../../../toolchain/skills/toolchain-languages/references/concerns.md). Shared
tools are in
[shared-tools.md](../../../../toolchain/skills/toolchain-languages/references/shared-tools.md).
Rows below assume a TypeScript CDK app, which most projects use; `Inherits: typescript` takes
that language's tool for the row. In a Python app use pytest with `aws_cdk.assertions`, and in
a Go app `awscdk/v2/assertions` with `go test`.

Versions: `aws-cdk-lib` 2.277.0 (2026-11-13) and CLI `aws-cdk` 2.1148.1 (2026-11-11). The CLI
is decoupled from the library: keep the CLI at or above the library release and update it
freely. Pin `aws-cdk-lib` and every `-alpha` package to one version in the project lockfile.

## Concerns

| Concern | Default | Maintenance | Install | Alternatives | Use both when | Run | Avoid |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `test-runner` | `vitest` with `aws-cdk-lib/assertions` (`Template.fromStack`, `hasResourceProperties`, `Match`, `Capture`, `resourceCountIs`, `Annotations.fromStack`) | >= 5.0.0 · 2026-11-02 · active | `node_modules/.bin/vitest --version` · `npm install --save-dev vitest` | `jest`: the project already runs it, since it is AWS's documented path and ships `aws-cdk-lib/testhelpers/jest-autoclean` | - | every-pr | Synthesizing to the default temp `outdir` under Vitest without cleanup: set an explicit `outdir` or call `CloudAssembly.cleanupTemporaryDirectories()` in `afterAll` |
| `assertions` | Built-in: `aws-cdk-lib/assertions` (`Template`, `Match`, `Capture`) with the runner's `expect` | - | Built-in | None | - | every-pr | Asserting on the whole template instead of resources by name and property |
| `watch` | N/A: the synth-and-assert loop uses the TypeScript watch (`Inherits: typescript`) | - | - | None | - | - | - |
| `property` | Inherits: typescript | - | Inherits | None | - | - | Property tests over whole stacks: synth is slow, so test pure prop-mapping helpers only |
| `fuzz` | N/A: no untrusted input parser in an IaC app | - | - | None | - | - | - |
| `fuzz-continuous` | N/A: no untrusted input parser in an IaC app | - | - | None | - | - | - |
| `mutation` | Inherits: typescript | - | Inherits | None | - | diff-pr + scheduled | Mutating whole stacks: declarative mutants are hard to judge; scope it to pure helpers |
| `snapshot` | Built-in: the test runner's snapshot of `Template.fromStack(stack).toJSON()` for stable L3 constructs, with asset hashes normalised | - | Built-in | None | - | every-pr | Snapshots as the only test: CDK upgrades change templates; assert IAM, encryption and public access by name first |
| `component` | N/A: no UI | - | - | None | - | - | - |
| `concurrency` | N/A: synth is single-process and holds no shared state | - | - | None | - | - | - |
| `coverage` | N/A: coverage of declarative construct code says little; assertions on the template are the measure | - | - | None | - | - | - |
| `benchmark` | N/A: infrastructure is not benchmarked | - | - | None | - | - | - |
| `flaky-order` | N/A: tests share no state beyond the temp-dir cleanup under `test-runner` | - | - | None | - | - | - |
| `integration` | `@aws-cdk/integ-runner` with `@aws-cdk/integ-tests-alpha` (`integ.*.ts` apps with `IntegTest`, committed `*.snapshot` directories) for construct libraries; apps run a deploy-and-assert pipeline stage | >= 2.207.0 · 2026-11-11 · preview | `node_modules/.bin/integ-runner --version` · `npm install --save-dev @aws-cdk/integ-runner @aws-cdk/integ-tests-alpha` | None | - | scheduled | `--update-on-failed` against a shared or production account: it deploys real stacks, so use a sandbox account |
| `contract` | N/A: constructs have no independently deployed consumers | - | - | None | - | - | - |
| `api-schema` | N/A: no API schema | - | - | None | - | - | - |
| `load` | N/A: infrastructure code is not load tested | - | - | None | - | - | - |
| `lint` | Inherits: typescript | - | Inherits | `eslint-plugin-awscdk`: you want CDK rules and run ESLint, since the plugin is third-party and ESLint only; `awslint`: you ship a jsii construct library, though it is a developer preview | Biome or the project linter for general rules, `eslint-plugin-awscdk` for CDK rules | every-pr | Adding ESLint only for CDK rules in a Biome project without a reason |
| `format` | Inherits: typescript | - | Inherits | None | - | every-pr | - |
| `types` | Inherits: typescript | - | Inherits | `cfn-lint`: you want the synthesized template checked against the CloudFormation spec, see Language-specific | `tsc --noEmit` for the code, `cfn-lint` for `cdk.out` | every-pr | - |
| `sast` | `cdk-nag` v3 packs on the app (AwsSolutions, HIPAA, NIST 800-53 r4 and r5, PCI DSS 3.2.1, Serverless) | >= 3.0.2 · 2026-08-04 · active | `npm ls cdk-nag --depth=0` · `npm install --save-dev cdk-nag` | `@cdklabs/cdk-validator-cfnguard`: you want Control Tower rules in the synth step, though it is experimental; `cfn-guard`: you write your own Guard rules for the template; `checkov`: you scan `cdk.out` and want one scanner with other IaC | `cdk-nag` for the pack and `cfn-guard` for org rules | every-pr | cdk-nag v3 below `aws-cdk-lib` 2.257 (stay on 2.x); the unscoped `cdk-validator-cfnguard` package, which is stale; several broad scanners at once |
| `memory-safety` | N/A: no memory model in constructs | - | - | None | - | - | - |
| `dep-audit` | Inherits: typescript | - | Inherits | `osv-scanner`: you want one scanner across lockfiles of several languages | - | every-pr + scheduled | - |
| `dead-code` | Inherits: typescript | - | Inherits | None | - | - | - |
| `unused-deps` | Inherits: typescript | - | Inherits | None | - | - | - |
| `complexity` | N/A: constructs are declarative | - | - | None | - | - | - |
| `duplication` | Inherits: typescript | - | Inherits | None | - | - | - |
| `api-break` | `jsii-diff` against the last published version, for construct libraries | >= 1.142.0 · 2026-10-20 · active | `node_modules/.bin/jsii-diff --version` · `npm install --save-dev jsii-diff` | None | - | every-pr | Running it in an app: apps publish no API; jsii 6 compatibility is unverified |
| `docs` | `jsii-docgen` for construct libraries; `projen` scaffolds the library | >= 10.12.9 · 2026-11-09 · active | `node_modules/.bin/jsii-docgen --version` · `npm install --save-dev jsii-docgen` | None | - | every-pr | Hand-edited `API.md` |
| `iac-plan` | Built-in: `cdk diff --method=change-set --fail-on=broadening` through a read-only role, plus `--fail-on=destructive` for stateful stacks | - | Built-in | `cdk-notifier`: you want the diff posted as a PR comment; `cdk refactor`: run with `--unstable=refactor --dry-run` when you move constructs and want the logical-ID mapping checked, though it is experimental | `cdk diff` for the gate, `cdk-notifier` for the comment | every-pr | Moving or renaming a construct without a refactor dry run or `overrideLogicalId`: it replaces the resource |
| `iac-drift` | Built-in: a scheduled `cdk drift --fail` | - | Built-in | None | - | scheduled | Running it with a role that can write |
| `iac-cost` | `infracost` on `cdk.out` after `cdk synth` (needs an API key; opt-in) | >= 2.19.1 · 2026-11-12 · active | `infracost --version` · `brew install infracost` | `aws-pricing-mcp`: you want a manual estimate through the `aws-pricing` server | - | on-demand | Enabling it without an account and the owner's consent; the Go CDK is unstated in its docs |

## Tradeoffs

### test-runner

- **vitest**: wins on fast runs, native TypeScript and one runner shared with the rest of a TypeScript repo; costs AWS documents Jest, and the temp-directory leak under Vitest is unverified
- **jest**: wins on AWS's documented path and `jest-autoclean`; costs a second runner in a Vitest repo

### lint

- **eslint-plugin-awscdk**: wins on CDK-specific rules; costs ESLint, and a third-party maintainer
- **awslint**: wins on construct-library conventions; costs a developer preview and jsii libraries only

### types

- **tsc --noEmit**: wins on type errors in the CDK code; costs it never reads the synthesized template
- **cfn-lint**: wins on template errors the types miss; costs a Python tool and a synth first

### sast

- **cdk-nag**: wins on compliance packs and per-construct acknowledgements with a reason; costs v3 needs `aws-cdk-lib` 2.257 or newer
- **@cdklabs/cdk-validator-cfnguard**: wins on Control Tower rules at synth time; costs it is experimental
- **cfn-guard**: wins on your own Guard rules for the template; costs you write and own them
- **checkov**: wins on one scanner for `cdk.out` and other IaC; costs noisy findings that need a baseline

### dep-audit

- **bun or npm audit**: wins because it needs no extra install; costs one ecosystem
- **osv-scanner**: wins across several lockfiles; costs less fix guidance

### iac-plan

- **cdk diff**: wins because it ships with the CLI; costs reviewers read long output
- **cdk-notifier**: wins on a PR comment with the diff; costs a CI secret for the comment
- **cdk refactor**: wins on checking construct moves before deploy; costs it is experimental

### iac-cost

- **infracost**: wins on a cost diff per change; costs an API key and an account
- **aws-pricing-mcp**: wins on a one-off manual estimate; costs it is not repeatable in CI

## Language-specific

| Topic | Tool | Note |
| --- | --- | --- |
| CloudFormation lint | `cfn-lint` (>= 1.60.1 · 2026-11-12, MIT-0) | Run on `cdk.out/*.template.json` after `cdk synth`; install with `pip install cfn-lint` or `mise use pipx:cfn-lint` |
| Version pinning | `package.json` and lockfile | Pin `aws-cdk-lib` and each `-alpha` package to one version; the CLI is at or above it |

### Assertions test

Assert resources by name and property, not by the whole template:

```ts
import { App } from "aws-cdk-lib"
import { Match, Template } from "aws-cdk-lib/assertions"
import { test } from "vitest"
import { BucketStack } from "../lib/bucket-stack"

const app = new App({ outdir: "cdk.out.test" })
const template = Template.fromStack(new BucketStack(app, "Test"))

test("bucket is encrypted and blocks public access", () => {
  template.hasResourceProperties("AWS::S3::Bucket", {
    BucketEncryption: Match.objectLike({}),
    PublicAccessBlockConfiguration: Match.objectLike({ BlockPublicAcls: true }),
  })
  template.resourceCountIs("AWS::S3::Bucket", 1)
})
```

With Vitest set an explicit `outdir` as above, git-ignore it, or call
`CloudAssembly.cleanupTemporaryDirectories()` in `afterAll`.

### cdk-nag v3 wiring

```ts
import { App, Validations } from "aws-cdk-lib"
import { AwsSolutionsChecks } from "cdk-nag"

const app = new App()
Validations.of(app).addPlugins(new AwsSolutionsChecks(app))
// Per construct, with a reason:
Validations.of(bucket).acknowledge({ id: "AwsSolutions-S1", reason: "Access logs go to the central log bucket" })
```

v3 replaces `NagSuppressions`. Below `aws-cdk-lib` 2.257 stay on cdk-nag 2.x.

### Snapshot normalisation

Replace asset hashes before the comparison, so a rebuilt asset does not change the golden file:

```ts
const json = JSON.stringify(template.toJSON()).replace(/[0-9a-f]{64}/g, "HASH")
expect(JSON.parse(json)).toMatchSnapshot()
```

Also normalise `AssetParameters` keys. Snapshot only stable L3 constructs.
