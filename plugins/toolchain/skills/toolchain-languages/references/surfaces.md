# Surface concerns

Checked 2026-11-16.

End-to-end, visual, accessibility and journey checks depend on the product surface, not the
language. Each section below covers one surface and lists the four surface concerns from
[concerns.md](concerns.md) in order. Format rules are in "Surface file format" there.

Journeys stay the agent-validated source of truth; a passing journey's stable steps may become
a deterministic `e2e` spec tagged with the journey id (see the `journeys-guide` skill).

## web

Playwright downloads browsers once per Playwright version into a shared cache that every
project reuses: `~/Library/Caches/ms-playwright` on macOS, `~/.cache/ms-playwright` on Linux
and `%USERPROFILE%\AppData\Local\ms-playwright` on Windows; `PLAYWRIGHT_BROWSERS_PATH`
overrides it. Run `npx playwright install` again only after a Playwright upgrade.
`playwright install --dry-run` downloads nothing and prints each browser's install location;
the browsers are present when that directory exists. In CI, cache that directory keyed on the
Playwright version, or run in the official image `mcr.microsoft.com/playwright:v<version>`,
which ships the browsers.

| Concern | Default | Maintenance | Install | Alternatives | Use both when | Run | Avoid |
|---|---|---|---|---|---|---|---|
| `e2e` | `@playwright/test` | >= 1.65.1 · 2026-11-13 · active | `node_modules/.bin/playwright install --dry-run` · `npm i -D @playwright/test && npx playwright install --with-deps` | `Cypress`: the team already uses it (16.3.0), Cypress Cloud is paid for parallelism; `WebdriverIO`: one WebDriver and BiDi stack including real devices (10.2.0); `Selenium`: an existing grid (4.52.0) | - | every-pr + scheduled | TestCafe and Nightwatch for new work; Puppeteer as a test framework; Playwright needs Node 22, 24 or 26, so run it under Node even in a Bun repository |
| `visual` | `@playwright/test` `toHaveScreenshot` | >= 1.65.1 · 2026-11-13 · active | `node_modules/.bin/playwright install --dry-run` · `npm i -D @playwright/test && npx playwright install --with-deps` | `Chromatic`: Storybook components and a hosted review UI (18.14.4, paid); `Argos`: hosted review UI for Playwright runs (6.11.0); `Percy`: hosted review UI across browsers (1.32.12) | - | diff-pr | Baselines made on a different OS or browser build (run in the pinned Playwright Docker image), `--update-snapshots` set to `changed` or `all` overwrites baselines silently (bug #44128), so review the image diff; Lost Pixel (archived); BackstopJS (no release since 2024-09) |
| `a11y` | `@axe-core/playwright` with `toMatchAriaSnapshot` | >= 4.14.0 · 2026-10-15 · active | `npm ls @axe-core/playwright --depth=0` · `npm i -D @axe-core/playwright` | `Lighthouse CI`: only with performance budgets (0.16.1); `pa11y`: crawling a static site (10.0.0) | - | every-pr | Treating a clean automated run as WCAG conformance: automated rules catch only part of the issues, so keep manual keyboard and screen-reader checks |
| `journey` | Built-in: journeys plugin (`journeys-guide` skill: `journey-verify`, `journey-verify-changed`) driving the running app with `@playwright/mcp` (0.0.85) or `chrome-devtools-mcp` (1.13.0) | - | Built-in | `@playwright/mcp`: drive by accessibility snapshot, the default driver; `chrome-devtools-mcp`: the step needs DevTools data such as network, console or performance traces | - | release + on-demand | Running a journey on a page you did not start; hand-editing a journey to match a stale selector |

### Tradeoffs

#### e2e

- **@playwright/test**: wins on auto-waiting, traces, multi-origin and parallel runs across Chromium, Firefox and WebKit in one runner; costs a browser download and a Node runtime.
- **Cypress**: wins when the team already has a suite and wants its time-travel debugger; costs a paid cloud for parallelism and weaker multi-tab and multi-origin support than Playwright.
- **WebdriverIO**: wins when one stack must cover browsers and real mobile devices; costs a heavier setup and slower runs.
- **Selenium**: wins when an existing grid or a language binding Playwright lacks is fixed; costs more flake handling by hand.

#### visual

- **@playwright/test**: wins on `toHaveScreenshot` beside the e2e specs with no extra service; costs baselines that differ per OS and browser, so record them in CI.
- **Chromatic**: wins for Storybook-based component review with a hosted baseline store; costs a paid service and a Storybook dependency.
- **Argos**: wins when you keep Playwright specs and want hosted review and baseline history; costs a hosted service.
- **Percy**: wins for cross-browser rendering in hosted review; costs a paid service.

#### a11y

- **@axe-core/playwright**: wins on axe rules run inside existing Playwright specs, with `toMatchAriaSnapshot` for structure; costs automated coverage that finds only part of the WCAG issues.
- **Lighthouse CI**: wins when you also enforce performance budgets; costs a shallow accessibility rule set compared with axe.
- **pa11y**: wins for crawling a static site without writing specs; costs no interaction coverage.

#### journey

- **@playwright/mcp**: wins as the default driver, working from accessibility snapshots; costs a pre-1.0 version.
- **chrome-devtools-mcp**: wins when a step needs network, console or trace evidence; costs a Chrome-only runtime.

## mobile

| Concern | Default | Maintenance | Install | Alternatives | Use both when | Run | Avoid |
|---|---|---|---|---|---|---|---|
| `e2e` | `maestro` | >= 2.12.1 · 2026-11-02 · active | `maestro --version` · `brew install mobile-dev-inc/tap/maestro` | `Detox`: React Native with gray-box synchronization (20.51.4), `Patrol`: Flutter (4.11.0); `XCUITest`: an iOS-only app that already uses it; `Espresso`: an Android-only app that already uses it; `Appium`: one WebDriver stack across platforms (current major version unverified) | - | every-pr + scheduled | Fixed sleeps instead of Maestro's built-in waiting; running the full device matrix on every PR |
| `visual` | Built-in: the platform's snapshot tests (iOS swift-snapshot-testing, Android Paparazzi), both unverified | - | Built-in | `Maestro`: screenshot assertions inside the e2e flow (support unverified) | - | diff-pr | Baselines recorded on a different simulator, device model or OS version |
| `a11y` | Built-in: XCUITest `performAccessibilityAudit` on iOS and the Android Accessibility Test Framework through Espresso (both unverified) | - | Built-in | None | - | every-pr | Treating an automated audit as conformance: it misses labels that exist but mislead |
| `journey` | Built-in: journeys plugin (`journeys-guide` skill: `journey-verify`, `journey-verify-changed`) driving the simulator or device through a mobile MCP server (none verified) | - | Built-in | None | - | release + on-demand | Running against a build older than the journey's surfaces |

### Tradeoffs

#### e2e

- **maestro**: wins on short YAML flows for iOS and Android with built-in waiting and no code build step; costs less control than a native framework and a flow language to learn.
- **Detox**: wins for React Native apps that need fast, synchronized gray-box tests; costs a React Native-only scope.
- **Patrol**: wins for Flutter apps that need native dialogs and permissions; costs a Flutter-only scope.
- **XCUITest**: wins when the iOS team owns the suite and needs the audit APIs; costs one platform and Xcode only.
- **Espresso**: wins when the Android team owns the suite; costs one platform and in-process limits.
- **Appium**: wins when one WebDriver stack must cover both platforms; costs slower, flakier runs and heavier setup.

## desktop

| Concern | Default | Maintenance | Install | Alternatives | Use both when | Run | Avoid |
|---|---|---|---|---|---|---|---|
| `e2e` | `@playwright/test` with `_electron` (experimental) for Electron | >= 1.65.1 · 2026-11-13 · active | `node_modules/.bin/playwright install --dry-run` · `npm i -D @playwright/test && npx playwright install --with-deps` | `WebdriverIO`: Tauri through `tauri-driver` and `@wdio/tauri-service` (1.5.1) | - | every-pr + scheduled | `_electron` is experimental, so pin the Playwright version; Playwright needs Node 22, 24 or 26 |
| `visual` | `@playwright/test` `toHaveScreenshot` on the Electron window | >= 1.65.1 · 2026-11-13 · active | `node_modules/.bin/playwright install --dry-run` · `npm i -D @playwright/test && npx playwright install --with-deps` | None | - | diff-pr | Baselines made on a different OS or scaling factor; a Tauri app has no matching tool here (unverified) |
| `a11y` | `@axe-core/playwright` on the Electron window | >= 4.14.0 · 2026-10-15 · active | `npm ls @axe-core/playwright --depth=0` · `npm i -D @axe-core/playwright` | None | - | every-pr | Treating axe as a check of native menus and dialogs: it sees only the web content |
| `journey` | Built-in: journeys plugin (`journeys-guide` skill: `journey-verify`, `journey-verify-changed`) driving the app through the surface's driver MCP (none verified) | - | Built-in | None | - | release + on-demand | Running against a build that is not the one under release |

## http-api

| Concern | Default | Maintenance | Install | Alternatives | Use both when | Run | Avoid |
|---|---|---|---|---|---|---|---|
| `e2e` | `hurl` | >= 8.1.0 · 2026-10-28 · active | `hurl --version` · `brew install hurl` | `Bruno`: GUI-managed collections with a CLI (4.3.0); `Newman`: existing Postman collections only (6.2.3) | - | every-pr + scheduled | Step CI (stale); a new suite on Newman |
| `visual` | N/A: an HTTP API has no rendered output | - | - | None | - | - | - |
| `a11y` | N/A: an HTTP API has no user interface | - | - | None | - | - | - |
| `journey` | Built-in: journeys plugin (`journeys-guide` skill: `journey-verify`, `journey-verify-changed`) driving the API through an HTTP driver such as `hurl` or `curl` in a shell | - | Built-in | None | - | release + on-demand | Journeys against production data |

### Tradeoffs

#### e2e

- **hurl**: wins on plain-text HTTP requests with captures and asserts in one binary, easy to run in CI; costs no GUI and no scripting beyond its filters.
- **Bruno**: wins when non-developers edit collections in a GUI that stays in Git; costs a second format beside the code.
- **Newman**: wins when the team already keeps Postman collections; costs the Postman format and a Node runtime.

## cli

| Concern | Default | Maintenance | Install | Alternatives | Use both when | Run | Avoid |
|---|---|---|---|---|---|---|---|
| `e2e` | `bats-core` | >= 1.14.0 · 2026-07-21 · active | `bats --version` · `brew install bats-core` | `testscript`: Go CLIs (rogpeppe/go-internal 1.15.0); `trycmd`: Rust CLIs, with `snapbox` for in-process snapshots; `pytest`: Python CLIs, driving the binary with `subprocess` | - | every-pr + scheduled | Tests that read the developer's own config or home directory: set `HOME` and the working directory to a temporary directory |
| `visual` | N/A: a command-line tool has no rendered UI | - | - | None | - | - | - |
| `a11y` | N/A: a command-line tool has no UI to audit | - | - | None | - | - | - |
| `journey` | Built-in: journeys plugin (`journeys-guide` skill: `journey-verify`, `journey-verify-changed`) driving the tool through a shell driver in a disposable directory | - | Built-in | None | - | release + on-demand | Journeys that run destructive commands outside a sandbox |

### Tradeoffs

#### e2e

- **bats-core**: wins for any CLI, driving the real binary with exit-code and output asserts and JUnit output; costs Bash-only tests and subprocess handling by hand.
- **testscript**: wins for Go CLIs, with txtar scripts and coverage of the binary; costs a Go-only workflow.
- **trycmd**: wins for Rust CLIs, keeping command output in checked-in files; costs a Rust-only workflow.
- **pytest**: wins for Python CLIs that already use pytest fixtures; costs hand-written subprocess handling.
