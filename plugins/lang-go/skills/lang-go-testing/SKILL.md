---
name: lang-go-testing
description: Use to write or fix Go tests (table tests, subtests, -race, golden files, fuzzing, httptest, synctest, testify).
metadata:
  opencode/autoinvoke: false
---

# Go Testing

Sources: [`testing`](https://pkg.go.dev/testing), `go help testflag` (Go 1.27), [Go fuzzing](https://go.dev/doc/security/fuzz/), [`testing/synctest`](https://pkg.go.dev/testing/synctest), [go-cmp](https://pkg.go.dev/github.com/google/go-cmp/cmp).

What to test and which double to use is the `quality-testing` skill. This skill is the
Go idioms. Follow the existing tests' style first: if the package uses testify, keep
using it; do not add it to a package that does not.

## Table tests with subtests

```go
func TestParseDuration(t *testing.T) {
	tests := []struct {
		name    string
		in      string
		want    time.Duration
		wantErr bool
	}{
		{name: "minutes", in: "5m", want: 5 * time.Minute},
		{name: "empty", in: "", wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got, err := ParseDuration(tt.in)
			if (err != nil) != tt.wantErr {
				t.Fatalf("ParseDuration(%q) error = %v, wantErr %v", tt.in, err, tt.wantErr)
			}
			if got != tt.want {
				t.Errorf("ParseDuration(%q) = %v, want %v", tt.in, got, tt.want)
			}
		})
	}
}
```

- Since Go 1.22 each loop iteration has its own `tt`; drop the old `tt := tt` copy.
- Messages read `Func(input) = got, want want`. `t.Fatalf` stops this subtest,
  `t.Errorf` keeps checking.
- Compare structs and slices with `cmp.Diff(want, got)` from go-cmp
  (`if d := cmp.Diff(want, got); d != "" { t.Errorf("mismatch (-want +got):\n%s", d) }`),
  not `reflect.DeepEqual`, which says only that they differ. Check errors with
  `errors.Is` / `errors.As`, not by string.
- Helpers call `t.Helper()` first so failures point at the caller. Use `t.TempDir()`,
  `t.Cleanup`, `t.Context()` (Go 1.24+, cancelled before cleanups run) and
  `t.Chdir` (Go 1.24+). `t.Setenv` and `t.Chdir` cannot be combined with `t.Parallel()`.
- Black-box tests live in `package foo_test` and use only the exported API; keep
  `package foo` tests for internals that cannot be reached otherwise.
- `func ExampleParse()` with an `// Output:` comment runs as a test and renders as
  documentation.

## Running

```sh
go test -race ./...                         # default; see lang-go-quality
go test -run 'TestParseDuration/empty$' ./internal/timeparse
go test -count=1 ./...                      # bypass the test result cache
go test -shuffle=on -count=5 ./pkg          # flush out order dependence; prints the seed
go test -failfast ./...                     # stop after the first failing test
go test -coverprofile=cover.out ./... && go tool cover -func=cover.out
```

## Golden files

Store large expected outputs under `testdata/` (the go tool ignores it as a package)
and regenerate them behind a flag:

```go
var update = flag.Bool("update", false, "rewrite golden files")

golden := filepath.Join("testdata", tt.name+".golden")
if *update {
	os.WriteFile(golden, got, 0o644)
}
want, _ := os.ReadFile(golden)
```

Run `go test ./pkg -update`, then review the golden diff like code before committing.

## Fuzzing

```go
func FuzzParse(f *testing.F) {
	f.Add("5m")                              // seed corpus
	f.Fuzz(func(t *testing.T, in string) {
		d, err := ParseDuration(in)
		if err != nil {
			return                           // rejecting input is fine; panicking is not
		}
		again, err := ParseDuration(d.String())  // assert an invariant, not an exact value
		if err != nil || again != d {
			t.Errorf("round trip of %q: %v -> %v, %v", in, d, again, err)
		}
	})
}
```

```sh
go test -run='^$' -fuzz='^FuzzParse$' -fuzztime=60s ./internal/timeparse   # one package at a time
```

A failing input is written to `testdata/fuzz/FuzzParse/`; commit it. Plain `go test`
replays the seeds and that corpus as regular tests, so the bug stays fixed.

## Time, concurrency and I/O

- Code that sleeps, uses timers or tickers, or waits on goroutines: test it inside
  `synctest.Test(t, func(t *testing.T) { … })` (Go 1.25+). Time is fake and advances
  only when every goroutine in the bubble is blocked, so a 30 s timeout test runs
  instantly. `synctest.Wait()` waits for the bubble to go idle.
- HTTP clients: point them at `httptest.NewServer(handler)`; HTTP handlers: call
  them with `httptest.NewRecorder()` and `httptest.NewRequest`.
- Slow or external integration tests go behind `//go:build integration` (run with
  `go test -tags integration ./...`) or skip under `testing.Short()`.
