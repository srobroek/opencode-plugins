---
name: ops-no-global-cargo-target
description: Use when Cargo, shell, mise, or CI configuration would set CARGO_TARGET_DIR or [build].target-dir to a machine-global directory. Worktrunk owns one target directory per repository.
---

Cargo final and link output is deliberately absent from the shared cache policy. Worktrunk creates one absolute `dirname(git-common-dir)/target` per repository, so every worktree of that repository shares it and no two repositories collide.

`CARGO_TARGET_DIR` or a global `[build].target-dir` redirects every repository into one writable directory. Concurrent builds then fight over fingerprints and lock files, cross-repository artifacts can be reused silently, and deleting a checkout no longer frees its build output.

Compiler caching is the supported way to share work across repositories: sccache on the shared cache root. That is content-addressed, so it is safe to share and safe to evict.

Cache roots, eviction, and environment knobs: the `ops-toolchain-cache-policy` skill.
