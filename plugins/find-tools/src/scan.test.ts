import { describe, expect, test } from "bun:test"
import { npmSearchText } from "./query.ts"
import {
  AWESOME_OPENCODE_URL,
  awesomeEntries,
  catalogIndexUrl,
  DEFAULT_CATALOG_URL,
  type LocalInventory,
  mcpCounts,
  registryInstall,
  renderScan,
  type ScanDeps,
  SOURCES,
  scanSources,
} from "./scan.ts"

type Handler = (url: URL, init?: RequestInit) => Response | Promise<Response>

function fetcher(handler: Handler): typeof fetch {
  return Object.assign(async (input: string | URL | Request, init?: RequestInit) => handler(new URL(String(input)), init), {
    preconnect: () => {},
  }) as typeof fetch
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

const noLocal: LocalInventory = {
  plugins: async () => ({ data: [] }),
  skills: async () => ({ data: [] }),
  mcp: async () => ({ data: [] }),
}

/** Deps with no network, no gh and no key, so each test opts into the sources it exercises. */
function deps(extra: Partial<ScanDeps> = {}): ScanDeps {
  return {
    fetchFn: fetcher(() => new Response("unexpected", { status: 599 })),
    run: async () => {
      throw new Error("unexpected spawn")
    },
    which: () => false,
    env: {},
    local: noLocal,
    ...extra,
  }
}

const result = (report: Awaited<ReturnType<typeof scanSources>>, source: string) =>
  report.results.find((r) => r.source === source)

describe("source isolation", () => {
  test("one fetch failure does not fail other sources", async () => {
    const report = await scanSources(
      { query: "browser" },
      deps({
        fetchFn: fetcher((url) => {
          if (url.host === "registry.modelcontextprotocol.io") throw new Error("network down")
          if (url.host === "registry.npmjs.org") return json({ objects: [{ package: { name: "x-mcp", description: "hit" } }] })
          return new Response("nope", { status: 404 })
        }),
      }),
    )
    expect(report.results.map((r) => r.source)).toEqual([...SOURCES])
    expect(result(report, "mcp_registry")?.status).toBe("failed")
    expect(result(report, "npm")?.status).toBe("ok")
    expect(result(report, "npm")?.hits.some((h) => h.name === "x-mcp")).toBe(true)
    expect(result(report, "smithery")?.reason).toContain("SMITHERY_API_KEY")
    expect(result(report, "github")?.reason).toBe("gh not found")
    for (const source of ["mcp_registry", "smithery", "github", "skills_cli", "catalog", "awesome_opencode"]) {
      expect(report.gaps.some((g) => g.source === source)).toBe(true)
    }
  })

  test("a source subset skips the others without touching the network", async () => {
    const report = await scanSources({ query: "x", sources: ["local"] }, deps())
    expect(result(report, "local")?.hits).toEqual([{ name: "mcp", detail: '{"configured":0}' }])
    expect(result(report, "npm")?.status).toBe("skipped")
    expect(report.gaps).toContainEqual({ source: "npm", kind: "unavailable", reason: "not requested" })
  })

  test("rejects unknown sources with the valid names", async () => {
    await expect(scanSources({ query: "x", sources: ["discover"] }, deps())).rejects.toThrow(
      `Unknown source: discover. Valid sources: ${SOURCES.join(", ")}`,
    )
  })

  test("a source that ignores its abort signal still times out alone", async () => {
    const report = await scanSources(
      { query: "browser", sources: ["local", "npm"] },
      deps({
        timeoutMs: 50,
        local: { ...noLocal, plugins: () => new Promise(() => {}) },
        fetchFn: fetcher(() => json({ objects: [{ package: { name: "fast" } }] })),
      }),
    )
    expect(result(report, "local")).toMatchObject({ status: "failed", reason: "timed out after 0.05 s" })
    expect(result(report, "npm")?.status).toBe("ok")
  })

  test("cancellation returns partial coverage instead of throwing", async () => {
    const ac = new AbortController()
    const promise = scanSources(
      { query: "x", sources: ["local", "npm"] },
      deps({
        signal: ac.signal,
        fetchFn: fetcher(
          (_url, init) =>
            new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))),
        ),
      }),
    )
    await Bun.sleep(5)
    ac.abort()
    const report = await promise
    expect(report.cancellation?.completed).toEqual(["local"])
    expect(report.cancellation?.timedOut).toEqual(["npm"])
    expect(result(report, "npm")?.reason).toBe("cancelled")
  })
})

describe("npm", () => {
  const naturalLanguage = "browser extension native messaging bridge for Chrome DevTools protocol automation"

  test("keeps every keyword search inside npm's text length limit", () => {
    for (const keyword of ["opencode-plugin", "mcp-server", "agent-skill", "claude-skill"]) {
      const search = npmSearchText(keyword, naturalLanguage)
      expect(search?.text.length).toBeLessThanOrEqual(64)
      expect(search?.text.startsWith(`keywords:${keyword} browser`)).toBe(true)
      expect(search?.dropped).toBeGreaterThan(0)
    }
  })

  test("sends bounded text, deduplicates across keywords and ranks by relevance then downloads", async () => {
    const texts: string[] = []
    const report = await scanSources(
      { query: naturalLanguage, sources: ["npm"] },
      deps({
        fetchFn: fetcher((url) => {
          const text = url.searchParams.get("text") ?? ""
          texts.push(text)
          if (text.length > 64) return json({ error: "too long" }, 400)
          const keyword = text.split(" ")[0]?.slice("keywords:".length)
          return json({
            objects: [
              { package: { name: "popular-thing", description: "unrelated" }, downloads: { monthly: 9000 } },
              {
                package: { name: "chrome-browser-bridge", description: "browser automation", keywords: [keyword] },
                downloads: { monthly: 5 },
              },
            ],
          })
        }),
      }),
    )
    expect(texts).toHaveLength(4)
    const npm = result(report, "npm")
    expect(npm?.status).toBe("ok")
    expect(npm?.hits.map((h) => h.name)).toEqual(["chrome-browser-bridge", "popular-thing"])
    expect(npm?.hits[0]?.detail).toContain("opencode-plugin, mcp-server, agent-skill, claude-skill")
    expect(npm?.hits[0]?.install).toContain('add "chrome-browser-bridge" to "plugins"')
    expect(npm?.reason).toContain("trimmed")
  })

  test("caps the ranked list", async () => {
    let n = 0
    const report = await scanSources(
      { query: "thing", sources: ["npm"] },
      deps({
        fetchFn: fetcher(() =>
          json({ objects: Array.from({ length: 10 }, () => ({ package: { name: `thing-${n++}` } })) }),
        ),
      }),
    )
    expect(result(report, "npm")?.hits).toHaveLength(20)
    expect(result(report, "npm")?.reason).toContain("top 20 of 40")
  })

  test("an mcp-server package hint runs package code", async () => {
    const report = await scanSources(
      { query: "fs", sources: ["npm"] },
      deps({
        fetchFn: fetcher((url) =>
          (url.searchParams.get("text") ?? "").includes("mcp-server")
            ? json({ objects: [{ package: { name: "@acme/fs-mcp" } }] })
            : json({ objects: [] }),
        ),
      }),
    )
    expect(result(report, "npm")?.hits[0]).toMatchObject({
      install: "opencode mcp add fs-mcp -- npx -y @acme/fs-mcp",
      runsCode: true,
    })
  })

  test.each(["{", "{}", "null"])("invalid responses are partial and keep the hits that arrived: %s", async (invalid) => {
    let calls = 0
    const report = await scanSources(
      { query: "example", sources: ["npm"] },
      deps({
        fetchFn: fetcher(() =>
          calls++ === 0 ? json({ objects: [{ package: { name: "retained-hit" } }] }) : new Response(invalid),
        ),
      }),
    )
    const npm = result(report, "npm")
    expect(npm?.status).toBe("partial")
    expect(npm?.hits.map((h) => h.name)).toEqual(["retained-hit"])
    expect(npm?.failures).toHaveLength(3)
    expect(report.gaps.some((g) => g.source === "npm" && g.kind === "partial")).toBe(true)
  })

  test("every keyword failing fails the source", async () => {
    const report = await scanSources(
      { query: "example", sources: ["npm"] },
      deps({ fetchFn: fetcher(() => new Response("{}", { status: 500 })) }),
    )
    expect(result(report, "npm")).toMatchObject({ status: "failed", ok: false })
    expect(result(report, "npm")?.reason).toContain("HTTP 500")
    expect(report.coverage.failed).toBe(1)
  })
})

describe("empty results versus source failure", () => {
  test("a source that answers with nothing is not a gap", async () => {
    const report = await scanSources(
      { query: "browser", sources: ["mcp_registry", "npm"] },
      deps({
        fetchFn: fetcher((url) =>
          url.host === "registry.modelcontextprotocol.io"
            ? json({ servers: [], metadata: { count: 0 } })
            : new Response("nope", { status: 503 }),
        ),
      }),
    )
    expect(result(report, "mcp_registry")?.status).toBe("empty")
    expect(report.gaps.some((g) => g.source === "mcp_registry")).toBe(false)
    expect(result(report, "npm")?.status).toBe("failed")
    expect(report.coverage).toMatchObject({ empty: 1, failed: 1 })
  })
})

describe("mcp_registry", () => {
  test("searches the specific words, reads the v0.1 envelope and ranks the union", async () => {
    const searched: string[] = []
    const report = await scanSources(
      { query: "headless browser automation", sources: ["mcp_registry"] },
      deps({
        fetchFn: fetcher((url) => {
          expect(url.pathname).toBe("/v0.1/servers")
          expect(url.searchParams.get("version")).toBe("latest")
          const search = url.searchParams.get("search") ?? ""
          searched.push(search)
          if (search !== "browser") return json({ servers: [] })
          return json({
            servers: [
              { server: { name: "io.example/other", description: "browser" } },
              {
                server: {
                  name: "io.example/headless-browser",
                  description: "browser automation",
                  remotes: [{ type: "streamable-http", url: "https://mcp.example.com/mcp" }],
                },
              },
            ],
          })
        }),
      }),
    )
    expect(searched.sort()).toEqual(["automation", "browser", "headless"])
    const hits = result(report, "mcp_registry")?.hits ?? []
    expect(hits.map((h) => h.name)).toEqual(["io.example/headless-browser", "io.example/other"])
    expect(hits[0]?.install).toBe("opencode mcp add headless-browser --url https://mcp.example.com/mcp")
  })

  test("install hints: package runners run code, templated remotes are not filled in", () => {
    expect(registryInstall({ name: "a/b", packages: [{ registryType: "npm", identifier: "@x/y", version: "1.0.0" }] })).toEqual({
      install: "opencode mcp add b -- npx -y @x/y@1.0.0",
      runsCode: true,
    })
    expect(registryInstall({ name: "a/py", packages: [{ registryType: "pypi", identifier: "py-mcp" }] })).toEqual({
      install: "opencode mcp add py -- uvx py-mcp",
      runsCode: true,
    })
    expect(registryInstall({ name: "a/t", remotes: [{ url: "https://{region}.example.com/mcp" }] }).install).toContain(
      "template variables",
    )
  })
})

describe("github", () => {
  const ok = (body: unknown) => ({ ok: true, stdout: JSON.stringify(body), stderr: "" })

  test("runs three gh api searches and keeps the hits of the ones that answered", async () => {
    const commands: string[][] = []
    const report = await scanSources(
      { query: "browser automation", sources: ["github"] },
      deps({
        which: (bin) => bin === "gh",
        run: async (argv) => {
          commands.push(argv)
          const path = argv[2] ?? ""
          if (path.startsWith("search/repositories")) {
            return ok({
              items: [
                {
                  full_name: "acme/opencode-browser",
                  description: "Browser plugin",
                  stargazers_count: 12,
                  license: { spdx_id: "MIT" },
                  pushed_at: "2026-10-01T00:00:00Z",
                  html_url: "https://github.com/acme/opencode-browser",
                },
              ],
            })
          }
          if (decodeURIComponent(path).includes("filename:SKILL.md")) {
            return ok({ items: [{ path: "skills/browse/SKILL.md", repository: { full_name: "acme/skills" } }] })
          }
          return { ok: false, stdout: "", stderr: "HTTP 403: rate limited" }
        },
      }),
    )
    expect(commands.every(([bin, sub]) => bin === "gh" && sub === "api")).toBe(true)
    expect(commands.map((c) => decodeURIComponent(c[2] ?? ""))).toEqual([
      expect.stringContaining("automation browser filename:marketplace.json path:.claude-plugin"),
      expect.stringContaining("automation browser filename:SKILL.md"),
      expect.stringContaining("automation browser topic:opencode-plugin"),
    ])
    const github = result(report, "github")
    expect(github?.status).toBe("partial")
    expect(github?.hits.map((h) => h.name)).toEqual(["acme/skills/skills/browse/SKILL.md", "acme/opencode-browser"])
    expect(github?.hits[0]?.install).toBe("copy the skill directory skills/browse into .opencode/skills/")
    expect(github?.hits[1]?.detail).toBe("Browser plugin [12 stars] (MIT, pushed 2026-10-01)")
    expect(github?.failures).toEqual(["code .claude-plugin/marketplace.json: HTTP 403: rate limited"])
  })

  test("malformed GitHub JSON everywhere fails the source with no hits", async () => {
    const report = await scanSources(
      { query: "browser", sources: ["github"] },
      deps({ which: () => true, run: async () => ({ ok: true, stdout: "{not-json", stderr: "" }) }),
    )
    expect(result(report, "github")).toMatchObject({ status: "failed", hits: [] })
  })
})

describe("local inventory", () => {
  test("lists plugins and skills and reports MCP as status counts only", async () => {
    const secret = "SYNTHETIC_MCP_SECRET_CANARY"
    const report = await scanSources(
      { query: "x", sources: ["local"] },
      deps({
        local: {
          plugins: async () => ({
            data: [
              { id: "srobroek.beads", source: { type: "package", target: "@srobroek/opencode-beads", version: "0.1.0" }, state: { status: "active" } },
              { id: "broken", source: { type: "local", path: `/home/${secret}` }, state: { status: "failed", error: secret } },
            ],
          }),
          skills: async () => [{ id: "find-tools", name: "find-tools", description: "Discover tools" }],
          mcp: async () => ({
            data: [
              { name: secret, status: { status: "connected" } },
              { name: `https://${secret}`, status: { status: "failed", error: secret } },
              { name: "x", status: { status: secret } },
            ],
          }),
        },
      }),
    )
    expect(JSON.stringify(report)).not.toContain(secret)
    expect(result(report, "local")?.hits).toEqual([
      { name: "plugin:srobroek.beads", detail: "package @srobroek/opencode-beads@0.1.0" },
      { name: "plugin:broken", detail: "local; failed to load" },
      { name: "skill:find-tools", detail: "Discover tools" },
      { name: "mcp", detail: '{"configured":3,"connected":1,"failed":1,"unknown":1}' },
    ])
  })

  test("a failing MCP list is reported without its error text", async () => {
    const secret = "SYNTHETIC_MCP_SECRET_CANARY"
    const report = await scanSources(
      { query: "x", sources: ["local"] },
      deps({
        local: {
          ...noLocal,
          mcp: async () => {
            throw new Error(`cannot reach https://${secret}`)
          },
        },
      }),
    )
    expect(JSON.stringify(report)).not.toContain(secret)
    expect(result(report, "local")).toMatchObject({ status: "partial", failures: ["mcp list failed"] })
  })

  test("all three lists failing fails the source; a missing inventory skips it", async () => {
    const boom = async () => {
      throw new Error("down")
    }
    const failedReport = await scanSources(
      { query: "x", sources: ["local"] },
      deps({ local: { plugins: boom, skills: boom, mcp: boom } }),
    )
    expect(result(failedReport, "local")?.status).toBe("failed")
    const skipped = await scanSources({ query: "x", sources: ["local"] }, deps({ local: undefined }))
    expect(result(skipped, "local")?.status).toBe("skipped")
  })

  test("mcpCounts counts statuses only", () => {
    expect(mcpCounts([{ status: { status: "disabled" } }, {}])).toEqual({ configured: 2, disabled: 1, unknown: 1 })
  })
})

describe("catalog", () => {
  const marketplace = {
    plugins: [
      { name: "worktrunk", description: "Worktrunk worktree skills", source: "./plugins/worktrunk" },
      { name: "rust", description: "Rust guidance", source: "./plugins/rust" },
    ],
  }

  test("matches this repository's marketplace and suggests the project-scope spec", async () => {
    const report = await scanSources(
      { query: "worktree", sources: ["catalog"] },
      deps({ fetchFn: fetcher((url) => (url.href === DEFAULT_CATALOG_URL ? json(marketplace) : json({}, 404))) }),
    )
    const hits = result(report, "catalog")?.hits ?? []
    expect(hits.map((h) => h.name)).toEqual(["worktrunk"])
    expect(hits[0]?.install).toBe(
      `project: add "github:srobroek/opencode-plugins::path:plugins/worktrunk" to "plugins" in opencode.json; user-wide: opencode plugin add 'github:srobroek/opencode-plugins::path:plugins/worktrunk'`,
    )
  })

  test("reads configured skill catalogs and keeps a broken one as a partial gap", async () => {
    const report = await scanSources(
      { query: "rust", sources: ["catalog"] },
      deps({
        skillCatalogs: ["https://skills.example.com/.well-known/skills/", "https://broken.example.com/x.json", "nope"],
        fetchFn: fetcher((url) => {
          if (url.href === DEFAULT_CATALOG_URL) return json(marketplace)
          if (url.href === "https://skills.example.com/.well-known/skills/index.json") {
            return json({ skills: [{ name: "rust-review", description: "Review Rust code" }] })
          }
          return new Response("gone", { status: 410 })
        }),
      }),
    )
    const catalog = result(report, "catalog")
    expect(catalog?.status).toBe("partial")
    expect(catalog?.hits.map((h) => h.name)).toEqual(["rust", "rust-review (skills.example.com)"])
    expect(catalog?.hits[1]?.install).toBe(
      'project: add "https://skills.example.com/.well-known/skills/" to "skills" in opencode.json',
    )
    expect(catalog?.failures).toEqual(["https://broken.example.com/x.json: HTTP 410: gone", "nope: invalid URL"])
  })

  test("catalogIndexUrl reads a directory catalog through index.json", () => {
    expect(catalogIndexUrl("https://a.example/skills/")).toBe("https://a.example/skills/index.json")
    expect(catalogIndexUrl("https://a.example/c.json")).toBe("https://a.example/c.json")
  })
})

describe("awesome_opencode", () => {
  const readme = `
<details open>
<summary><strong>🧩 PLUGINS</strong></summary>
<details>
  <summary><b>opencode-browser</b> <img src="x"/> - <i>Browser automation</i></summary>
  <blockquote>
    Drives Chrome &amp; Firefox.
    <br><br>
    <a href="https://github.com/acme/opencode-browser">🔗 <b>View Repository</b></a>
  </blockquote>
</details>
<details>
  <summary><b>quotes</b> - <i>Inspirational quotes</i></summary>
  <blockquote><a href="https://github.com/acme/quotes">x</a></blockquote>
</details>
</details>
- [list-entry](https://example.com/list) - a browser list item
`

  test("parses cards and bullets with their section", () => {
    expect(awesomeEntries(readme)).toEqual([
      {
        name: "opencode-browser",
        detail: "Browser automation — Drives Chrome & Firefox.",
        url: "https://github.com/acme/opencode-browser",
        section: "PLUGINS",
      },
      { name: "quotes", detail: "Inspirational quotes — x", url: "https://github.com/acme/quotes", section: "PLUGINS" },
      { name: "list-entry", detail: "a browser list item", url: "https://example.com/list", section: "PLUGINS" },
    ])
  })

  test("labels every matching hit unvetted", async () => {
    const report = await scanSources(
      { query: "browser", sources: ["awesome_opencode"] },
      deps({ fetchFn: fetcher((url) => (url.href === AWESOME_OPENCODE_URL ? new Response(readme) : json({}, 404))) }),
    )
    const awesome = result(report, "awesome_opencode")
    expect(awesome?.hits.map((h) => [h.name, h.unvetted])).toEqual([
      ["opencode-browser", true],
      ["list-entry", true],
    ])
    expect(awesome?.reason).toContain("unvetted")
    expect(renderScan(report)).toContain("opencode-browser [unvetted]")
  })
})

describe("smithery", () => {
  test("sends the key and keeps descriptions, use counts and a remote URL hint", async () => {
    const report = await scanSources(
      { query: "browser", sources: ["smithery"] },
      deps({
        env: { SMITHERY_API_KEY: "key" },
        fetchFn: fetcher((url, init) => {
          expect(url.host).toBe("registry.smithery.ai")
          expect(new Headers(init?.headers).get("authorization")).toBe("Bearer key")
          return json({
            servers: [
              { qualifiedName: "@acme/browser", description: "Drives a headless browser.", useCount: 7, remote: true },
            ],
          })
        }),
      }),
    )
    expect(result(report, "smithery")?.hits).toEqual([
      {
        name: "@acme/browser",
        detail: "Drives a headless browser. [7 uses]",
        url: "https://smithery.ai/server/@acme/browser",
        install: "opencode mcp add browser --url https://server.smithery.ai/@acme/browser/mcp",
      },
    ])
  })

  test("an unparseable response is partial with the raw text", async () => {
    const report = await scanSources(
      { query: "browser", sources: ["smithery"] },
      deps({ env: { SMITHERY_API_KEY: "key" }, fetchFn: fetcher(() => new Response("<html>maintenance</html>")) }),
    )
    expect(result(report, "smithery")).toMatchObject({
      status: "partial",
      hits: [{ name: "raw", detail: "<html>maintenance</html>" }],
    })
  })
})

describe("read-only boundary", () => {
  test("a full scan only spawns gh api and never the skills CLI", async () => {
    const commands: string[][] = []
    const report = await scanSources(
      { query: "browser" },
      deps({
        which: () => true,
        fetchFn: fetcher(() => json({})),
        run: async (argv) => {
          commands.push(argv)
          return { ok: true, stdout: "{}", stderr: "" }
        },
      }),
    )
    expect(commands.length).toBe(3)
    expect(commands.every(([bin, sub]) => bin === "gh" && sub === "api")).toBe(true)
    expect(result(report, "skills_cli")?.status).toBe("skipped")
    expect(report.gaps.find((g) => g.source === "skills_cli")?.reason).toMatch(/never runs it/)
  })

  test("the rendered report says hints are never run and lists every local entry", async () => {
    const skills = Array.from({ length: 30 }, (_, n) => ({ name: `skill-${n}` }))
    const report = await scanSources(
      { query: "x", sources: ["local"] },
      deps({ local: { ...noLocal, skills: async () => skills } }),
    )
    const text = renderScan(report)
    for (const { name } of skills) expect(text).toContain(`skill:${name}`)
    expect(text).toContain("never installs or runs")
  })
})
