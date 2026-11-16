# Concerns

Checked 2026-01-10.

## Concerns

| Id | Name | Group | Definition | N/A allowed for | Run must include |
|---|---|---|---|---|---|
| unit | Unit tests | testing | Fast tests of one unit. | none | every-pr |
| lint | Linting | quality | Static style checks. | none | every-pr |
| types | Type checking | quality | Static type analysis. | shell, iac | every-pr |
| drift | Drift detection | iac | Deployed state matches code. | none | scheduled |

## Surface concerns

| Id | Name | Group | Definition | N/A allowed for | Run must include |
|---|---|---|---|---|---|
| e2e | End-to-end | surface | Whole-flow tests. | none | every-pr + scheduled |
| visual | Visual regression | surface | Screenshot comparison. | none | diff-pr |

## Surfaces

Surfaces file: `plugins/toolchain/skills/toolchain-languages/references/surfaces.md`

| Surface | Id | N/A allowed for |
|---|---|---|
| Web UI | web | none |
| HTTP API | api | visual |

## Kinds

| Kind | Meaning |
|---|---|
| managed | Package-managed language. |
| native | Compiled language. |
| shell | Shell scripts. |
| iac | Infrastructure as code. |

## Languages

| Language | Id | Kind | Skill | Files |
|---|---|---|---|---|
| Python | py | managed | lang-x | `plugins/lang/skills/lang-x/references/testing.md`, `plugins/lang/skills/lang-x/references/quality.md` |
| Shell | sh | shell | lang-sh | `plugins/lang/skills/lang-sh/references/shell.md` |
| Terraform | tf | iac | lang-tf | `plugins/lang/skills/lang-tf/references/tf.md` |

## Run tokens

| Token | Meaning |
|---|---|
| every-pr | Every pull request. |
| diff-pr | Changed files only. |
| bounded-pr | Time-boxed. |
| scheduled | Nightly. |
| release | Before release. |
| on-demand | By hand. |
