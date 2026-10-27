---
name: toolchain-guide
description: "Use when choosing a stack, dependency, framework, library, infra tool, logging, scanner, CI or toolchain caches."
---

# Toolchain guide

This guide only routes. Before you answer or act, load the matching skill with the skill
tool, by id, in this same turn, and every other row the task spans. Answer from the loaded
skill, not from this table.

| Situation | Load skill |
| --- | --- |
| Choosing or changing a project stack, package manager or task runner, or adding a dependency | `toolchain-stack-defaults` |
| Picking per-language libraries, or test and lint tools the language does not imply | `toolchain-languages` |
| Choosing a frontend framework, UI kit, or client or server state library | `toolchain-frontend` |
| Choosing Terraform, OpenTofu, CDK, Kubernetes or Helm | `toolchain-infrastructure` |
| Adding logging, tracing or security scanners to a service or worker | `toolchain-quality-observability` |
| Adding or changing agentic assets: where OpenCode config, plugins, skills and agents live | `toolchain-asset-ownership` |
| Writing or changing GitHub Actions workflows: required checks, matrices, caches, action pinning, attestation | `ci-github-actions` |
| Configuring toolchain download or compiler caches, worktree build output, cache roots and sizes | `ops-toolchain-cache-policy` |
| Cargo, shell, mise or CI config would set `CARGO_TARGET_DIR` or `build.target-dir` machine-wide | `ops-no-global-cargo-target` |
