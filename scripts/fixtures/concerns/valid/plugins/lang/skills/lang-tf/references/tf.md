# Terraform

Checked 2026-01-10.

## Concerns

| Concern | Default | Maintenance | Alternatives | Use both when | Run | Avoid |
|---|---|---|---|---|---|---|
| `unit` | Inherits: py | - | None | - | every-pr | - |
| `lint` | Shared: tflint-shared | - | None | - | every-pr | - |
| `types` | N/A: HCL is validated by the provider | - | None | - | - | - |
| `drift` | `tofu` | 1.9.0 · 2026-01-08 · active | None | - | scheduled | - |
