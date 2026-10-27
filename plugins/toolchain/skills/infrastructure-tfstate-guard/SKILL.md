---
name: infrastructure-tfstate-guard
description: Use before any Terraform/OpenTofu state operation (state rm, mv, push) or *.tfstate edit; never hand-edit state.
---

Never hand-edit Terraform or OpenTofu state files.

Use the owning CLI's `terraform state` or `tofu state` subcommands (`list`, `show`, `mv`, `rm`, `push`) only after
a backup of the current state. Plan first; do not `state rm`/`mv`/`push` as the
opening move.

`*.tfstate` and `*.tfstate.*` are not source. Edit HCL and let the owning CLI update
state. If a remote backend owns state, operate through that backend — do not
write a local copy over it.
