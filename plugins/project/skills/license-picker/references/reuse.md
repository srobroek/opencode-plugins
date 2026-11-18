# REUSE: license headers and CI

Use REUSE ([spec 3.3](https://reuse.software/spec-3.3/), tool [`reuse`](https://reuse.readthedocs.io/en/stable/)) for per-file license and copyright data. Do not write a homemade header checker.

## Setup

1. Put the license text in `LICENSES/<SPDX-id>.txt`: `reuse download <SPDX-id>` or `reuse download --all`. The directory holds only license texts the files use ([License Files](https://reuse.software/spec-3.3/#license-files)).
2. Add headers to source files: `reuse annotate --license <SPDX-id> --copyright "<holder>" <files>`. It picks the comment style from the extension and replaces an existing header in place ([reuse-annotate](https://reuse.readthedocs.io/en/stable/man/reuse-annotate.html)). Check the result by hand. The manual warns against running it blindly in automation.
3. Cover files that cannot carry a comment with `[[annotations]]` in a root `REUSE.toml` ([spec](https://reuse.software/spec-3.3/#reusetoml)). Such files are JSON, fixtures, generated files, binaries and lockfiles. A single file can use a `<file>.license` sidecar instead.

   ```toml
   version = 1

   [[annotations]]
   path = ["**/*.json", "tests/fixtures/**", "bun.lock"]
   precedence = "closest"
   SPDX-FileCopyrightText = "2026 <holder>"
   SPDX-License-Identifier = "<SPDX-id>"
   ```

   `closest` lets a header inside a file win; `override` forces the table's data. Do not mix `REUSE.toml` with the deprecated `.reuse/dep5`.
4. Keep a top-level `LICENSE` as well, so GitHub detects the license. REUSE ignores `LICENSE`, `COPYING` and `LICENCE`.
5. Keep a per-file exception, such as a vendored file under another license, in that file's header or a narrow `REUSE.toml` path. Add its license text to `LICENSES/`. Record its origin in `NOTICE`.

## Lint in CI

Run `reuse lint` ([criteria](https://reuse.readthedocs.io/en/stable/man/reuse-lint.html): missing, unused or bad licenses, files without data) in a job that `ci-gate` already requires, so branch protection needs no change. Pin the action to a commit SHA:

```yaml
- uses: actions/checkout@<sha>
- uses: fsfe/reuse-action@676e2d560c9a403aa252096d99fcab3e1132b0f5 # v6.0.0
```

Releases: [fsfe/reuse-action](https://github.com/fsfe/reuse-action/releases). When you add the job, look up the current tag and its commit SHA. Locally, run the same `reuse lint` from `just check`.
