# C and C++ testing and quality tooling

C and C++ have no language plugin yet. A project researches commands and versions before it adopts a tool here, and follows the install policy in [concerns.md](concerns.md): detect a tool, recommend the install command and ask before you install it. Maintenance cells give a minimum version; use the latest release the manager offers. Shared tools are in [shared-tools.md](shared-tools.md).

Checked 2026-11-16.

## Concerns

| Concern | Default | Maintenance | Install | Alternatives | Use both when | Run | Avoid |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `test-runner` | `GoogleTest` | >= 1.18.0 · 2026-08-10 · active | `grep -rli gtest CMakeLists.txt conanfile.txt vcpkg.json` · `CMake FetchContent, conan gtest/1.18.0 or vcpkg install gtest` | `Catch2`: nested sections and one header set (3.16.1, BSL-1.0); `doctest`: the fastest compile times of the three (2.5.3, MIT) | - | every-pr | No XML output in CI (use `--gtest_output=xml`); tests registered outside CTest |
| `assertions` | Built-in: GoogleTest `EXPECT_*` and `ASSERT_*` (Catch2: `REQUIRE`, `CHECK`) | - | Built-in | None | - | every-pr | `ASSERT_*` in helper functions that return a value, which skips the failure |
| `watch` | `watchexec` | >= 2.8.0 · 2026-10-06 · active | `watchexec --version` · `mise use watchexec` | None | - | on-demand | Watching the build directory, which retriggers the run; use `watchexec -e cpp,h -- ctest --test-dir build` |
| `property` | `RapidCheck` | >= main · 2026-10-05 · active | `grep -rl rapidcheck CMakeLists.txt conanfile.txt vcpkg.json` · `CMake FetchContent pinned to a commit, or vcpkg install rapidcheck` | None | - | every-pr | Floating on `main`: it has no tagged releases, so pin a commit (the date here is the last commit); unseeded runs with no saved failing seed |
| `fuzz` | `libFuzzer` | >= 23.1.5 · 2026-11-03 · maintenance | `clang --version` · `brew install llvm or apt install clang` | `AFL++`: fork-server fuzzing with strong mutators and no recompile of tests (v5.03c, AGPL-3.0 on GitHub); `LibAFL`: a Rust library for custom fuzzers | `libFuzzer` in pull requests with `AFL++` in scheduled campaigns | bounded-pr | Fuzzing without sanitizers; AFL++ in shipped tooling before you check its AGPL-3.0 licence; libFuzzer is in maintenance mode |
| `fuzz-continuous` | Shared: clusterfuzzlite | - | Shared | `oss-fuzz`: an open-source project that wants Google-run campaigns | `clusterfuzzlite` on pull requests with `oss-fuzz` for long campaigns | scheduled | Discarding the corpus between runs |
| `mutation` | `Mull` | >= 0.38.0 · 2026-11-11 · active | `command -v mull-runner-19` · `apt-get install mull-19 (match the major version of your clang)` | None | - | diff-pr + scheduled | Running without debug info and optimisation off; a Mull build for a different LLVM than your compiler |
| `snapshot` | `ApprovalTests.cpp` | >= 10.14.0 · 2026-11-12 · active | `grep -rl ApprovalTests CMakeLists.txt conanfile.txt vcpkg.json` · `CMake FetchContent, or vcpkg install approvaltests-cpp` | None | - | every-pr | Approving a received file without reading it; non-deterministic output in the golden file |
| `component` | N/A: C++ has no default UI component model | - | - | None | - | - | - |
| `concurrency` | Built-in: ThreadSanitizer (`-fsanitize=thread`) | - | Built-in | `Helgrind`: Valgrind's lock-order and race checker for binaries you cannot instrument | - | scheduled | Combining `thread` with the `address` sanitizer; ignoring reports through broad suppressions |
| `coverage` | `gcovr` | >= 8.8 · 2026-10-27 · active | `gcovr --version` · `uv tool install gcovr` | `llvm-cov`: Clang source-based coverage with region data, shipped with LLVM | - | every-pr | Coverage thresholds as the goal; mixing gcc and clang instrumentation in one build |
| `benchmark` | `Google Benchmark` | >= 1.10.0 · 2026-10-14 · active | `grep -rE "benchmark" CMakeLists.txt conanfile.txt vcpkg.json` · `CMake FetchContent, conan benchmark/1.10.0 or vcpkg install benchmark` | `nanobench`: single header with a fast setup (4.6.0, MIT) | - | on-demand | Debug builds; benchmarks that the optimiser removes (use `DoNotOptimize`) |
| `flaky-order` | Built-in: GoogleTest `--gtest_shuffle`, `--gtest_random_seed` and `--gtest_repeat`, and CTest `--schedule-random` | - | Built-in | None | - | scheduled | Fixed ordering that hides a dependency between tests; retries without an owner |
| `integration` | No maintained tool: service containers in CI or a compose file started before the tests; `testcontainers-native` has no release that was verified | - | - | None | - | every-pr | Mocked databases standing in for the real engine |
| `contract` | Shared: contracts | - | Shared | `pact_verifier_cli`: two or more services you own call each other and deploy independently (Pact Broker required) | - | every-pr | Verifying a provider only against a mock; the shared library table has no C++ row, so provider verification uses `pact_verifier_cli` |
| `api-schema` | Shared: schemathesis | - | Shared | None | - | bounded-pr | Running against production |
| `load` | Shared: k6 | - | Shared | None | - | scheduled | Load tests against an environment not sized for them |
| `lint` | `clang-tidy` | >= 23.1.5 · 2026-11-03 · active | `clang-tidy --version` · `brew install llvm or apt install clang-tidy` | `cppcheck`: no compile database needed (2.22.0, GPL-3.0); `include-what-you-use`: include hygiene tied to a Clang version (0.27) | `clang-tidy` with `cppcheck` for a second set of checks | every-pr | A `.clang-tidy` that enables every check; running without `compile_commands.json` |
| `format` | `clang-format` | >= 23.1.5 · 2026-11-03 · active | `clang-format --version` · `brew install clang-format or apt install clang-format` | None | - | every-pr | Mixed `.clang-format` versions between developers and CI |
| `types` | Built-in: compiler warnings (`-Wall -Wextra -Wconversion -Werror`, `/W4 /WX` on MSVC) and `-Wthread-safety` on Clang | - | Built-in | None | - | every-pr | Warnings disabled per file to get a green build |
| `sast` | Shared: semgrep | - | Shared | `opengrep`: a community fork with no vendor rule licence; `codeql`: data-flow analysis in CI; `clang static analyzer`: path-sensitive checks through `clang-tidy` | `semgrep` with `codeql` in CI where licensed | every-pr | Unreviewed rule packs; CodeQL builds that do not match the real build |
| `memory-safety` | Built-in: AddressSanitizer and UndefinedBehaviorSanitizer (`-fsanitize=address,undefined`) | - | Built-in | `MemorySanitizer`: uninitialised reads on Clang, needs an instrumented libc++; `Valgrind`: no recompile on Linux, much slower | AddressSanitizer with `MemorySanitizer` in separate runs | every-pr | Combining `address` and `memory` sanitizers in one binary; sanitizers on release-only builds |
| `dep-audit` | Shared: osv-scanner | - | Shared | `conan audit`: Conan's built-in vulnerability scan (2.34.0) | `osv-scanner` on `conan.lock` with `conan audit` for a second source | every-pr + scheduled | Assuming vcpkg manifests are read: `osv-scanner` lists `conan.lock`, not `vcpkg.json` |
| `dead-code` | No maintained tool: compiler `-Wunused` warnings and linker `--gc-sections` with `--print-gc-sections` to list unreferenced sections | - | - | None | - | on-demand | Treating unused exported symbols as dead in a library |
| `unused-deps` | Built-in: CMake `LINK_WHAT_YOU_USE` (runs `ldd -u -r` on Linux) | - | Built-in | None | - | on-demand | Expecting it on macOS or Windows; header-only dependencies are not reported |
| `complexity` | Shared: lizard | - | Shared | `clang-tidy`: the `readability-function-cognitive-complexity` check you already run | - | every-pr | Blanket thresholds as correctness rules |
| `duplication` | Shared: jscpd | - | Shared | None | - | on-demand | Generated-code and vendored-code noise in the report |
| `api-break` | `libabigail` | >= 3.0 · 2026-10-12 · active | `abidiff --version` · `apt install abigail-tools` | None | - | every-pr | `abi-compliance-checker`, which is unmaintained; the release date here is approximate (the sourceware tag page shows only a relative age); running it for applications |
| `docs` | `Doxygen` | >= 1.18.0 · 2026-08-13 · active | `doxygen --version` · `brew install doxygen or apt install doxygen` | None | - | every-pr | `WARN_AS_ERROR` off, which hides undocumented or broken references |

## Tradeoffs

### test-runner

- **GoogleTest**: wins on mocking with GoogleMock, CTest discovery and broad CI support; costs slower compile times and more boilerplate.
- **Catch2**: wins on nested sections and readable output; costs heavier compile times than doctest.
- **doctest**: wins on compile speed and tests next to the code; costs a smaller feature set.

### fuzz

- **libFuzzer**: wins as the in-process engine bundled with Clang and used by ClusterFuzzLite; costs maintenance mode and a harness per target.
- **AFL++**: wins on mutation strategies and fork-server speed for whole programs; costs AGPL-3.0 on GitHub and a separate build mode.
- **LibAFL**: wins when you need a custom fuzzer with your own feedback; costs building and maintaining that fuzzer in Rust.

### coverage

- **gcovr**: wins with gcc and clang through gcov and one report format; costs line and branch data only, not regions.
- **llvm-cov**: wins on exact source-based region coverage with Clang; costs Clang only and a profile merge step.

### lint

- **clang-tidy**: wins on deep checks with a compile database; costs a long run on a large codebase.
- **cppcheck**: wins on a quick run with no compile database; costs more false positives and a GPL-3.0 licence.
- **include-what-you-use**: wins on trimming includes; costs a build tied to one Clang version.

### sast

- **opengrep**: wins on a community-owned rule format with no vendor rule licence; costs a younger project and a smaller rule set.
- **codeql**: wins on data-flow depth for C and C++ in CI; costs a traced build, slower runs and GitHub licensing terms.
- **clang static analyzer**: wins on path-sensitive checks inside the toolchain; costs a slower run and the noise that comes with it.

### memory-safety

- **AddressSanitizer and UndefinedBehaviorSanitizer**: win on fast, precise checks for memory errors and undefined behaviour in tests; cost a recompile and a slowdown.
- **MemorySanitizer**: wins on uninitialised reads; costs Clang only and an instrumented libc++.
- **Valgrind**: wins when you cannot recompile; costs a much slower run and Linux only.
