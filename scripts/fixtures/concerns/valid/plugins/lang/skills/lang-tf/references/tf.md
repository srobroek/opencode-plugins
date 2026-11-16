# Terraform

Checked 2026-01-10.

## Concerns

| Concern | Default | Maintenance | Install | Alternatives | Use both when | Run | Avoid |
|---|---|---|---|---|---|---|---|
| `unit` | Inherits: py | - | Inherits | None | - | every-pr | - |
| `lint` | Shared: tflint-shared | - | Shared | None | - | every-pr | - |
| `types` | N/A: HCL is validated by the provider | - | - | None | - | - | - |
| `drift` | `tofu` | >= 1.9.0 · 2026-01-08 · active | `tofu version` · `brew install opentofu` | None | - | scheduled | - |
