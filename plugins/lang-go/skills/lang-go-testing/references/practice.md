# Go testing practice

Checked 2026-11-12.

Go idioms and tool choices for small, behavior-focused test suites.
Use `quality-testing` for what to test, behavior budgets, same-change maintenance,
double selection and review rules; follow existing package conventions first.

## Layout and naming

**Do:** Put `*_test.go` beside production code. Prefer `package x_test` for exported
contracts; use `package x` when an important internal algorithm needs focused tests.
Name tests for outcomes, such as `TestParseRejectsEmpty`, not just `TestParse`.
Use `ExampleParse` with an `Output:` comment for a small public usage contract.
Examples without `Output:` or `Unordered output:` compile but do not execute.

**Do not:** Treat access to private helpers as a reason to test each helper. Keep
fixtures in `testdata/`, not in a second package tree that duplicates the suite.

## One behavior per test

**Do:** Keep setup, action and the expected outcome visible. Several assertions may
describe one result. Stop on failed prerequisites with `t.Fatal` or `t.Fatalf`.
Use `errors.Is`/`errors.As` for error identity unless text is the contract.

```go
got, err := Parse("5m")
if err != nil {
	t.Fatalf("Parse(%q): %v", "5m", err)
}
if got != 5*time.Minute {
	t.Errorf("Parse(%q) = %v, want %v", "5m", got, 5*time.Minute)
}
```

**Do not:** Copy the implementation into the expected-value calculation. Default
to standard checks; use `go-cmp` `0.7` and `cmp.Diff(want, got)` for compound values.
Handle unexported fields deliberately; broad ignore options can conceal defects.
Keep existing `testify` `1` or `is` `1` conventions rather than adding a second
assertion library. Never call fatal assertions, including `require`, in workers.

## Parametrize instead of copying

**Do:** Use a typed table and named `t.Run` cases when setup and assertion shape match.

```go
for _, tc := range []struct{ name, input string }{
	{"empty", ""}, {"unknown_unit", "5fortnights"},
} {
	t.Run(tc.name, func(t *testing.T) {
		t.Parallel()
		if _, err := Parse(tc.input); !errors.Is(err, ErrInvalid) {
			t.Fatalf("Parse(%q) error = %v, want ErrInvalid", tc.input, err)
		}
	})
}
```

**Do not:** Build giant tables with conditional setup/oracles. Separate materially
different behaviors. Parallelize only isolated cases: `t.Parallel` delays a
subtest until its parent returns. Go `1.22` language semantics give variables
declared with `:=` in loops per-iteration identity; older language versions need
rebinding. Reused `=` variables and shared pointers/maps remain shared.

## Fixtures and builders

**Do:** Use typed literals or small builders with valid defaults and explicit
behavior-bearing overrides. Shared helpers live in `*_test.go`, call `t.Helper`,
and register `t.Cleanup` immediately after acquisition. Use `t.TempDir` for files.
Cleanup runs in reverse registration order after descendant subtests finish.

**Do not:** Hide scenarios in `init` or a global `TestMain` fixture. Allocate mutable
state per test; avoid suites merely to share it. `t.Setenv` and `t.Chdir` affect
process state and cannot be used in parallel tests or under parallel ancestors.

## Doubles and real boundaries

**Do:** Use real deterministic collaborators, then small consumer-owned fakes.
Check a reusable fake against the real implementation's contract. Use `httptest`
recorders for handler results and `httptest.NewServer` for client/transport behavior.
Put `testcontainers-go` `0.45` database/broker checks in an explicit integration
lane with pinned images, readiness checks, isolated data and registered cleanup.

**Do not:** Invent interfaces solely to mock every collaborator. Choose existing
`gomock` (`go.uber.org/mock` `0.6`) or `mockery` `3` only when boundary arguments,
counts or order are contractual. Do not mix generators or script incidental calls.
Driver mocks do not establish real SQL, transaction or broker semantics.

## Async, time and concurrency

**Do:** Await channels/completion signals rather than wall-clock sleeps. On Go
`1.24`+, pass `t.Context()` to lifetime-bound workers and join them in cleanup;
the context is canceled before cleanup, but cancellation alone is not termination.
Send worker errors to the test goroutine for fatal assertions.

Use stable `testing/synctest` on Go `1.25`+ for supported in-process timer tests:

```go
synctest.Test(t, func(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), time.Second)
	defer cancel()
	time.Sleep(time.Second) // Fake time, not a wall-clock synchronization delay.
	synctest.Wait()
	if !errors.Is(ctx.Err(), context.DeadlineExceeded) {
		t.Fatalf("timeout error = %v, want DeadlineExceeded", ctx.Err())
	}
})
```

**Do not:** Assume fake time models external sockets or every blocking operation.
Network I/O and mutex waits are not durably blocking; `synctest` is not exhaustive
schedule exploration. Keep an exercised `-race` lane.

## Property tests

**Do:** Use `rapid` `1` when domain generation and shrinking let one invariant
replace many examples: conservation, idempotence or ordering. Generate valid domain
inputs explicitly. Preserve failing seeds and a readable minimized regression case.

**Do not:** Generate random values without an independent property, or replace
named boundary/error examples with an opaque property campaign.

## Snapshots and golden files

**Do:** Compare small, stable, reviewable outputs; use semantic assertions where
clearer. Store goldens in `testdata/` and implement an explicit update flag:

```go
var update = flag.Bool("update", false, "rewrite golden files")
// Inside the test, after producing got and choosing path:
if *update {
	if err := os.WriteFile(path, got, 0o644); err != nil { t.Fatal(err) }
}
want, err := os.ReadFile(path)
if err != nil { t.Fatal(err) }
if diff := cmp.Diff(string(want), string(got)); diff != "" {
	t.Errorf("golden mismatch (-want +got):\n%s", diff)
}
```

**Do not:** Auto-update in CI or accept bulk diffs without review. Go has no built-in
`-update`; run the project's flag explicitly, for example `go test ./pkg -update`.
Do not snapshot timestamps, random identifiers or incidental object internals.

## Fuzzing, mutation and coverage

**Do:** Use native `FuzzXxx` targets for parsers/codecs with seed inputs and meaningful
no-panic/round-trip invariants. Bound campaigns with `-fuzztime`; ordinary `go test`
replays seeds and committed failures in `testdata/fuzz/<FuzzName>`.
Pilot `gremlins` `0.6` on important pure-logic packages. Scope PR mutation work to
changed packages; verify tool support before promising incremental or in-diff modes.

Read `-coverprofile` and changed-code gaps as prompts for missing behaviors.
Native Go coverage is statement coverage, not branch coverage. Review branch risks
explicitly; changed-line reports need separate diff/coverage processing.
For CLI/integration executions, Go `1.20`+ supports `go build -cover`, `GOCOVERDIR`
and `go tool covdata` to collect/report/merge instrumented process coverage.

**Do not:** Chase a universal percentage or add brittle tests for equivalent mutants.
A clean `-race` run proves only that executed paths exposed no detected race.
Benchmark an actual performance question; on Go `1.24`+, prefer `b.Loop()` with
setup outside the loop. Do not combine it with a `b.N` iteration loop.

## Flaky tests

**Do:** Diagnose with `go test -shuffle=on -count=20 ./pkg`; record the printed seed
and replay with `-shuffle=<seed>`. Use `-count=1` to bypass cached results. Inspect
shared state, resource collisions, goroutine lifetime and races before retrying.
Quarantine only with an owner, issue, expiry and continued diagnostic execution.

**Do not:** Enable retries by default. `gotestsum` `1` reports useful JSON/JUnit
artifacts, but `--rerun-fails` can turn intermittent defects green. Preserve the
initial failure and use reruns for diagnosis, not as a passing gate.

## Bad tests and fixes

See the `quality-testing` skill's `references/bad-tests.md` for language-neutral pairs covering removal checks, copied oracles, call-order mocks, side channels, copies instead of parameters, logic in tests, sleeps, assertion-free tests, eager tests, mystery guests, type re-checks, tampering, and whole-object snapshots.

### Sleeping for a goroutine

Bad:

```go
func TestRefresh(t *testing.T) {
	go refresh()
	time.Sleep(10 * time.Millisecond)
	if got := cachedValue(); got != "fresh" { t.Fatalf("got %q, want fresh", got) }
}
```

The delay neither guarantees completion nor synchronizes the worker's writes with the read.

Fix:

```go
func TestRefresh(t *testing.T) {
	done := make(chan struct{})
	go func() { refresh(); close(done) }()
	<-done
	if got := cachedValue(); got != "fresh" { t.Fatalf("got %q, want fresh", got) }
}
```

### Fatal assertions in a worker

Bad:

```go
func TestSave(t *testing.T) {
	done := make(chan struct{})
	go func() {
		defer close(done)
		if err := save(); err != nil { t.Fatal(err) }
	}()
	<-done
}
```

`t.Fatal` calls `FailNow`, which must run in the test goroutine rather than a spawned worker.

Fix:

```go
func TestSave(t *testing.T) {
	errs := make(chan error, 1)
	go func() { errs <- save() }()
	if err := <-errs; err != nil { t.Fatalf("save: %v", err) }
}
```

### Compound comparisons without a useful diff

Bad:

```go
func TestReceipt(t *testing.T) {
	got, want := receipt(), Receipt{Total: 25, Currency: "USD"}
	if got != want { t.Error("wrong receipt") }
}
```

The failure hides which field differs, and `!=` stops compiling if the struct gains a slice or map.

Fix:

```go
func TestReceipt(t *testing.T) {
	got, want := receipt(), Receipt{Total: 25, Currency: "USD"}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("receipt mismatch (-want +got):\n%s", diff)
	}
}
```

## Do not write

- Reflection checks such as `reflect.TypeOf(service).MethodByName("Removed")` to
  prove a deleted method is gone. Package functions cannot be enumerated that way;
  do not replace this with AST/file checks for a removed function either.
- Runtime interface checks duplicating `var _ Store = (*MemoryStore)(nil)`; the
  compiler already proves implementation. Test the interface's behavior instead.
- Trivial getter tests, private-helper inventories or expected values computed by
  repeating production logic. Delete obsolete tests/fixtures with removed behavior.
- A second copy of an already-protected scenario at another level without a distinct
  risk. Genuine API compatibility/security exclusions need contract tests, not
  memorials to removed internals.

## Defaults by use case

| Use case | Default |
| --- | --- |
| Pure logic | `testing`, named cases, `cmp.Diff`; `rapid` for a strong invariant |
| I/O adapters | Small fake plus real filesystem/service integration checks |
| HTTP handlers | `httptest.NewRecorder`; server when transport matters |
| Async/concurrency | Completion signals, cleanup/join, `synctest`, `-race` |
| CLI | Injected streams/core tests plus a few exit/stdout/stderr subprocess checks |
| Parsers/codecs | Boundary cases plus native fuzzing and retained corpus |
| CI | Fast `go test ./...`, exercised `go test -race ./...`; explicit `go test -tags integration ./...` lane, bounded fuzzing, optional targeted mutation |

Use `//go:build integration` to select integration files; tags are a project
convention. `-short` skips nothing unless tests check `testing.Short()` themselves.

## Sources

- [Testing APIs and examples](https://pkg.go.dev/testing), [Go `1.22` loops](https://go.dev/doc/go1.22), [Go `1.24` lifecycle/benchmarks](https://go.dev/doc/go1.24).
- [Fake-time testing](https://go.dev/blog/testing-time), [HTTP harness](https://pkg.go.dev/net/http/httptest), [fuzzing](https://go.dev/doc/security/fuzz/).
- [Integration coverage](https://go.dev/doc/build-cover), [race detector](https://go.dev/doc/articles/race_detector), [go-cmp](https://pkg.go.dev/github.com/google/go-cmp/cmp), [testify](https://pkg.go.dev/github.com/stretchr/testify), [is](https://pkg.go.dev/github.com/matryer/is).
- [Rapid](https://pkg.go.dev/pgregory.net/rapid), [Uber mocks](https://pkg.go.dev/go.uber.org/mock), [Mockery](https://pkg.go.dev/github.com/vektra/mockery/v3), [Testcontainers](https://pkg.go.dev/github.com/testcontainers/testcontainers-go).
- [Gremlins](https://pkg.go.dev/github.com/go-gremlins/gremlins), [gotestsum](https://pkg.go.dev/gotest.tools/gotestsum).
