---
name: terraform-language
description: "Use when writing or reviewing Terraform, OpenTofu or HCL: stacks, environments, modules, providers, state, conventions."
---

# Terraform And HCL

Keep environments and stacks explicit.

Evaluate vendor modules, maintained community modules, and thin custom wrappers
for maintenance, quality, support, compatibility, and security. Prefer a
maintained module that fits the project; document the rationale when bypassing
an official or community module.

## Workflow

1. Find the binary the project uses (`terraform` or `tofu`) from its lock file,
   `required_version` and CI. Use that one for every command.
2. Run the checks from [references/concerns.md](references/concerns.md) before
   hand-off: `fmt -check -recursive`, `init -backend=false` then `validate`,
   `tflint`, `checkov`, and `test`.
3. Put tests in `tests/*.tftest.hcl`. Use `command = plan` with `mock_provider` for unit
   tests and `expect_failures` for validations and conditions. Keep apply runs for a
   sandbox account.
4. Commit `.terraform.lock.hcl` made for every platform in use. Never hand-edit state.
5. Render the saved plan on the PR. Schedule `plan -detailed-exitcode -lock=false` for
   drift. Run cost estimates only when the owner opts in.
6. Install policy: detect each tool with the Install cell's first command. When it
   is missing, recommend the install command and ask permission before you run it.
   Report any check you could not run, never as a pass.
