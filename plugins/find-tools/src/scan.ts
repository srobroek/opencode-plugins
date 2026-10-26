/**
 * `find_tools_scan`: read-only discovery across local inventory, catalogs and public
 * registries. Ported from omp-plugins (`find-tools/extensions/find-tools-scan-tool.ts`)
 * without the omp sources. Every source runs in parallel under its own deadline, and
 * one failing source never fails the scan: it becomes a status and a gap.
 */

import { keyTerms, NPM_TEXT_MAX, npmSearchText, queryTerms, relevance } from "./query.ts"
import { defaultRun, type Run } from "./run.ts"

export const SOURCES = [
  "local",
  "catalog",
  "mcp_registry",
  "npm",
  "github",
  "awesome_opencode",
  "smithery",
  "skills_cli",
] as const

export type SourceName = (typeof SOURCES)[number]

export type Hit = {
  name: string
  detail?: string
  url?: string
  /** A suggested install, shown to the user and never run by the scan. */
  install?: string
  /** The install hint downloads and runs package code (`npx`, `uvx`, `docker run`). */
  runsCode?: true
  /** Listed by a community source nobody here reviewed. */
  unvetted?: true
}

export type SourceResult = {
  source: SourceName
  ok: boolean
  skipped?: boolean
  reason?: string
  /** Sub-request failures tolerated because other sub-requests of the same source answered. */
  failures?: string[]
  hits: Hit[]
}

/** A source that answered with nothing is not a source that could not answer. */
export type SourceStatus = "ok" | "empty" | "partial" | "skipped" | "failed"

export type ClassifiedSource = SourceResult & { status: SourceStatus }

export type Gap = { source: SourceName; kind: "unavailable" | "partial" | "failed"; reason: string }

export type Coverage = { answered: number; empty: number; partial: number; unavailable: number; failed: number }

export type ScanCancellation = { completed: SourceName[]; timedOut: SourceName[] }

export type ScanReport = {
  results: ClassifiedSource[]
  gaps: Gap[]
  coverage: Coverage
  cancellation?: ScanCancellation
}

/** The subset of `PluginInfo` the local source reads. */
export type LocalPlugin = {
  id?: string
  source?: { type: string; target?: string; version?: string; outdated?: true }
  state?: { status: string }
}
export type LocalSkill = { id?: string; name?: string; description?: string }
export type LocalMcp = { status?: { status?: string } }

/** The host inventory, from `ctx.plugin.list`, `ctx.skill.list` and `ctx.mcp.list`: a `{ data }` envelope or an array. */
export type LocalInventory = {
  plugins: () => Promise<unknown>
  skills: () => Promise<unknown>
  mcp: () => Promise<unknown>
}

export type ScanDeps = {
  fetchFn?: typeof fetch
  run?: Run
  which?: (bin: string) => boolean
  env?: Record<string, string | undefined>
  signal?: AbortSignal
  local?: LocalInventory
  /** This repository's Claude Code marketplace; overridable for tests and forks. */
  catalogUrl?: string
  /** Extra skill catalogs from the plugin options. */
  skillCatalogs?: readonly string[]
  /** Per-source deadline. */
  timeoutMs?: number
}

export type ScanParams = { query: string; sources?: string[] }

export const SOURCE_TIMEOUT_MS = 10_000
export const REPO_SPEC = "github:srobroek/opencode-plugins::path:plugins"
export const DEFAULT_CATALOG_URL =
  "https://raw.githubusercontent.com/srobroek/opencode-plugins/main/.claude-plugin/marketplace.json"
export const AWESOME_OPENCODE_URL = "https://raw.githubusercontent.com/awesome-opencode/awesome-opencode/main/README.md"
export const MCP_REGISTRY_URL = "https://registry.modelcontextprotocol.io/v0.1/servers"
export const NPM_SEARCH_URL = "https://registry.npmjs.org/-/v1/search"
export const SMITHERY_URL = "https://registry.smithery.ai/servers"
export const NPM_KEYWORDS = ["opencode-plugin", "mcp-server", "agent-skill", "claude-skill"] as const

const SEARCH_CAP = 20
const DETAIL_CHARS = 300

export function classify(result: SourceResult): SourceStatus {
  if (result.skipped) return "skipped"
  if (!result.ok) return "failed"
  if (result.failures?.length) return "partial"
  return result.hits.length > 0 ? "ok" : "empty"
}

const failed = (source: SourceName, reason: string, extra: Partial<SourceResult> = {}): SourceResult => ({
  source,
  ok: false,
  reason,
  hits: [],
  ...extra,
})

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

type Fetched = { ok: boolean; status: number; text: string }

async function getText(fetchFn: typeof fetch, url: string, signal: AbortSignal, init?: RequestInit): Promise<Fetched> {
  try {
    const res = await fetchFn(url, { ...init, signal })
    return { ok: res.ok, status: res.status, text: await res.text() }
  } catch (error) {
    return { ok: false, status: 0, text: message(error) }
  }
}

function httpReason(res: Fetched): string {
  return res.status ? `HTTP ${res.status}: ${res.text.slice(0, 200)}` : res.text.slice(0, 200) || "request failed"
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
const str = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined)

/** Accept either the raw array or the `{ data }` envelope the client returns. */
function listOf<T>(value: unknown): readonly T[] {
  if (Array.isArray(value)) return value as T[]
  const data = record(value)?.data
  return Array.isArray(data) ? (data as T[]) : []
}

// --- local ----------------------------------------------------------------

function pluginHit(plugin: LocalPlugin): Hit {
  const source = plugin.source
  let origin = source?.type ?? "unknown"
  if (source?.type === "package") {
    origin = `package ${source.target ?? "?"}${source.version ? `@${source.version}` : ""}${source.outdated ? " (outdated)" : ""}`
  }
  const failedState = plugin.state?.status === "failed" ? "; failed to load" : ""
  const name = plugin.id ?? (source?.type === "package" ? source.target : undefined) ?? "unnamed"
  return { name: `plugin:${name}`, detail: `${origin}${failedState}` }
}

/**
 * The MCP inventory as status counts only. Server names, commands, URLs and
 * environment can carry secrets or private hosts, so none of them leave this function.
 */
export function mcpCounts(servers: readonly LocalMcp[]): Record<string, number> {
  const counts: Record<string, number> = { configured: 0 }
  for (const server of servers) {
    counts.configured = (counts.configured ?? 0) + 1
    const status = server?.status?.status
    const key = status && /^[a-z_]{1,20}$/.test(status) ? status : "unknown"
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}

async function scanLocal(local: LocalInventory | undefined): Promise<SourceResult> {
  if (!local) return { source: "local", ok: true, skipped: true, reason: "host inventory unavailable", hits: [] }
  const [plugins, skills, mcp] = await Promise.allSettled([local.plugins(), local.skills(), local.mcp()])
  const hits: Hit[] = []
  const failures: string[] = []
  if (plugins.status === "fulfilled") hits.push(...listOf<LocalPlugin>(plugins.value).map(pluginHit))
  else failures.push(`plugin list failed: ${message(plugins.reason).slice(0, 200)}`)
  if (skills.status === "fulfilled") {
    for (const skill of listOf<LocalSkill>(skills.value)) {
      const name = skill.name ?? skill.id
      if (name) hits.push(skill.description ? { name: `skill:${name}`, detail: skill.description } : { name: `skill:${name}` })
    }
  } else failures.push(`skill list failed: ${message(skills.reason).slice(0, 200)}`)
  // The client's error text can quote a server name or URL; report the failure only.
  if (mcp.status === "fulfilled") hits.push({ name: "mcp", detail: JSON.stringify(mcpCounts(listOf<LocalMcp>(mcp.value))) })
  else failures.push("mcp list failed")
  if (failures.length === 3) return failed("local", failures.join("; "), { failures })
  return { source: "local", ok: true, hits, ...(failures.length ? { failures } : {}) }
}

// --- catalogs -------------------------------------------------------------

type CatalogEntry = { name: string; description?: string; source?: string }

/** Entries of a Claude marketplace (`plugins`), a skill index (`skills`) or a bare array. */
export function catalogEntries(json: unknown): { kind: "marketplace" | "skills"; entries: CatalogEntry[] } | undefined {
  const obj = record(json)
  const list = Array.isArray(json) ? json : Array.isArray(obj?.plugins) ? obj.plugins : obj?.skills
  if (!Array.isArray(list)) return undefined
  const kind = Array.isArray(obj?.plugins) ? "marketplace" : "skills"
  const entries: CatalogEntry[] = []
  for (const item of list) {
    const entry = record(item)
    const name = str(entry?.name)
    if (!name) continue
    const description = str(entry?.description)
    const source = str(entry?.source) ?? str(record(entry?.source)?.url) ?? str(record(entry?.source)?.repo)
    entries.push({ name, ...(description ? { description } : {}), ...(source ? { source } : {}) })
  }
  return { kind, entries }
}

/** A directory-style skill catalog URL (`…/.well-known/skills/`) is read through its `index.json`. */
export function catalogIndexUrl(url: string): string {
  return url.endsWith("/") ? `${url}index.json` : url
}

function catalogHits(url: string, own: boolean, json: unknown, terms: readonly string[]): Hit[] | undefined {
  const parsed = catalogEntries(json)
  if (!parsed) return undefined
  const ranked = parsed.entries
    .map((entry) => ({ entry, score: terms.length ? relevance(terms, entry.name, entry.description) : 1 }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, SEARCH_CAP)
  return ranked.map(({ entry }): Hit => {
    let install: string
    if (own) {
      const spec = `${REPO_SPEC}/${entry.name}`
      install = `project: add "${spec}" to "plugins" in opencode.json; user-wide: opencode plugin add '${spec}'`
    } else if (parsed.kind === "skills") {
      install = `project: add "${url}" to "skills" in opencode.json`
    } else {
      install = `Claude Code marketplace entry${entry.source ? ` (source ${entry.source})` : ""}; inspect it before adapting`
    }
    return {
      name: own ? entry.name : `${entry.name} (${new URL(url).host})`,
      ...(entry.description ? { detail: entry.description } : {}),
      url: own ? `https://github.com/srobroek/opencode-plugins/tree/main/plugins/${entry.name}` : url,
      install,
    }
  })
}

async function scanCatalog(
  fetchFn: typeof fetch,
  signal: AbortSignal,
  query: string,
  catalogUrl: string,
  extra: readonly string[],
): Promise<SourceResult> {
  const terms = queryTerms(query)
  const urls = [catalogUrl, ...extra.filter((u) => u !== catalogUrl)]
  const answers = await Promise.all(
    urls.map(async (url, index) => {
      let target: string
      try {
        target = new URL(catalogIndexUrl(url)).href
      } catch {
        return { url, error: "invalid URL" }
      }
      if (!/^https?:$/.test(new URL(target).protocol)) return { url, error: "not an http(s) URL" }
      const res = await getText(fetchFn, target, signal)
      if (!res.ok) return { url, error: httpReason(res) }
      const hits = catalogHits(url, index === 0 && url === catalogUrl, parseJson(res.text), terms)
      return hits ? { url, hits } : { url, error: "not a recognised catalog" }
    }),
  )
  const hits: Hit[] = []
  const failures: string[] = []
  for (const answer of answers) {
    if ("hits" in answer && answer.hits) hits.push(...answer.hits)
    else failures.push(`${answer.url}: ${answer.error}`)
  }
  if (failures.length === urls.length) return failed("catalog", failures.join("; "), { failures })
  return { source: "catalog", ok: true, hits, ...(failures.length ? { failures } : {}) }
}

// --- MCP Registry ---------------------------------------------------------

type RegistryServer = {
  name?: string
  description?: string
  title?: string
  version?: string
  repository?: { url?: string }
  websiteUrl?: string
  packages?: Array<{ registryType?: string; identifier?: string; version?: string }>
  remotes?: Array<{ type?: string; url?: string }>
}

const shortName = (name: string) =>
  (name.split("/").pop() ?? name).replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "server"

/** An `opencode mcp add` hint: a remote URL when one is listed, else the package runner. */
export function registryInstall(server: RegistryServer): Pick<Hit, "install" | "runsCode"> {
  const name = shortName(server.name ?? "server")
  const remote = server.remotes?.find((r) => r.url && !r.url.includes("{"))
  if (remote?.url) return { install: `opencode mcp add ${name} --url ${remote.url}` }
  const pkg = server.packages?.find((p) => p.identifier)
  if (pkg?.identifier) {
    const versioned = pkg.version ? `${pkg.identifier}@${pkg.version}` : pkg.identifier
    const runner =
      pkg.registryType === "npm"
        ? `npx -y ${versioned}`
        : pkg.registryType === "pypi"
          ? `uvx ${pkg.version ? `${pkg.identifier}==${pkg.version}` : pkg.identifier}`
          : pkg.registryType === "oci"
            ? `docker run -i --rm ${pkg.identifier}${pkg.version ? `:${pkg.version}` : ""}`
            : undefined
    if (runner) return { install: `opencode mcp add ${name} -- ${runner}`, runsCode: true }
  }
  if (server.remotes?.length) return { install: "remote URL needs template variables; see the registry entry" }
  return {}
}

async function scanMcpRegistry(fetchFn: typeof fetch, signal: AbortSignal, query: string): Promise<SourceResult> {
  // The registry matches a substring of the server name, so a sentence finds nothing;
  // search the most specific words and rank the union.
  const searches = keyTerms(query, 3)
  if (searches.length === 0) return { source: "mcp_registry", ok: true, reason: "empty query", hits: [] }
  const terms = queryTerms(query)
  const answers = await Promise.all(
    searches.map(async (search) => {
      const url = `${MCP_REGISTRY_URL}?search=${encodeURIComponent(search)}&version=latest&limit=30`
      return { search, res: await getText(fetchFn, url, signal) }
    }),
  )
  const seen = new Map<string, { hit: Hit; score: number }>()
  const failures: string[] = []
  for (const { search, res } of answers) {
    if (!res.ok) {
      failures.push(`${search}: ${httpReason(res)}`)
      continue
    }
    const servers = record(parseJson(res.text))?.servers
    if (!Array.isArray(servers)) {
      failures.push(`${search}: invalid registry response`)
      continue
    }
    for (const entry of servers) {
      const server = (record(record(entry)?.server) ?? record(entry)) as RegistryServer | undefined
      const name = str(server?.name)
      if (!server || !name || seen.has(name)) continue
      const detail = str(server.description) ?? str(server.title)
      const url = str(server.repository?.url) ?? str(server.websiteUrl)
      const hit: Hit = { name, ...(detail ? { detail } : {}), ...(url ? { url } : {}), ...registryInstall(server) }
      seen.set(name, { hit, score: relevance(terms, name, `${server.title ?? ""} ${detail ?? ""}`) })
    }
  }
  if (failures.length === searches.length) return failed("mcp_registry", failures.join("; "), { failures })
  const hits = [...seen.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, SEARCH_CAP)
    .map(({ hit }) => hit)
  return {
    source: "mcp_registry",
    ok: true,
    reason: `searched name substrings: ${searches.join(", ")}`,
    hits,
    ...(failures.length ? { failures } : {}),
  }
}

// --- npm ------------------------------------------------------------------

type NpmObject = {
  package?: { name?: string; description?: string; keywords?: string[]; links?: { npm?: string; repository?: string } }
  downloads?: { monthly?: number }
}

function npmInstall(name: string, keywords: ReadonlySet<string>): Pick<Hit, "install" | "runsCode"> {
  if (keywords.has("opencode-plugin")) {
    return { install: `project: add "${name}" to "plugins" in opencode.json; user-wide: opencode plugin add ${name}` }
  }
  if (keywords.has("mcp-server")) return { install: `opencode mcp add ${shortName(name)} -- npx -y ${name}`, runsCode: true }
  return { install: "skill package: vet its SKILL.md, then copy the skill directory into .opencode/skills/" }
}

async function scanNpm(fetchFn: typeof fetch, signal: AbortSignal, query: string): Promise<SourceResult> {
  const terms = queryTerms(query)
  const searches = await Promise.all(
    NPM_KEYWORDS.map(async (keyword) => {
      const search = npmSearchText(keyword, query)
      if (!search) return { keyword, search, res: undefined }
      const url = `${NPM_SEARCH_URL}?text=${encodeURIComponent(search.text)}&size=10`
      return { keyword, search, res: await getText(fetchFn, url, signal) }
    }),
  )
  type Ranked = { name: string; detail?: string; url?: string; keywords: Set<string>; monthly: number }
  const found = new Map<string, Ranked>()
  const failures: string[] = []
  let answered = 0
  let dropped = 0
  for (const { keyword, search, res } of searches) {
    if (!search || !res) {
      failures.push(`${keyword}: keyword alone exceeds npm's ${NPM_TEXT_MAX}-character search text limit`)
      continue
    }
    dropped = Math.max(dropped, search.dropped)
    if (!res.ok) {
      failures.push(`${keyword}: ${res.status ? `HTTP ${res.status}` : res.text.slice(0, 120)}`)
      continue
    }
    const objects = record(parseJson(res.text))?.objects
    if (!Array.isArray(objects)) {
      failures.push(`${keyword}: invalid search response`)
      continue
    }
    answered++
    for (const object of objects as NpmObject[]) {
      const p = object?.package
      if (!p?.name) continue
      const entry = found.get(p.name) ?? {
        name: p.name,
        ...(p.description ? { detail: p.description } : {}),
        ...(p.links?.npm ? { url: p.links.npm } : {}),
        keywords: new Set<string>(),
        monthly: object.downloads?.monthly ?? 0,
      }
      entry.keywords.add(keyword)
      for (const kw of p.keywords ?? []) if ((NPM_KEYWORDS as readonly string[]).includes(kw)) entry.keywords.add(kw)
      found.set(p.name, entry)
    }
  }
  if (answered === 0) return failed("npm", failures.join("; ") || "no npm searches ran", { failures })
  const hits = [...found.values()]
    .map((entry) => ({ entry, score: relevance(terms, entry.name, entry.detail) }))
    .sort((a, b) => b.score - a.score || b.entry.monthly - a.entry.monthly)
    .slice(0, SEARCH_CAP)
    .map(({ entry }): Hit => {
      const downloads = entry.monthly ? ` [${entry.monthly.toLocaleString("en-US")}/month]` : ""
      return {
        name: entry.name,
        detail: `${entry.detail ?? ""}${downloads} (${[...entry.keywords].join(", ")})`.trim(),
        ...(entry.url ? { url: entry.url } : {}),
        ...npmInstall(entry.name, entry.keywords),
      }
    })
  const notes = [
    failures.length ? `${answered}/${NPM_KEYWORDS.length} keyword searches answered` : "",
    dropped ? `query trimmed to npm's ${NPM_TEXT_MAX}-character search text (${dropped} term(s) dropped)` : "",
    found.size > SEARCH_CAP ? `top ${SEARCH_CAP} of ${found.size} packages` : "",
  ].filter(Boolean)
  return {
    source: "npm",
    ok: true,
    hits,
    ...(failures.length ? { failures } : {}),
    ...(notes.length ? { reason: notes.join("; ") } : {}),
  }
}

// --- GitHub ---------------------------------------------------------------

type GithubSearch = { label: string; path: string; kind: "marketplace" | "skill" | "repo" }

export function githubSearches(query: string): GithubSearch[] {
  const q = keyTerms(query, 3).join(" ")
  return [
    {
      label: "code .claude-plugin/marketplace.json",
      path: `search/code?q=${encodeURIComponent(`${q} filename:marketplace.json path:.claude-plugin`)}&per_page=10`,
      kind: "marketplace",
    },
    {
      label: "code SKILL.md",
      path: `search/code?q=${encodeURIComponent(`${q} filename:SKILL.md`)}&per_page=10`,
      kind: "skill",
    },
    {
      label: "repos topic:opencode-plugin",
      path: `search/repositories?q=${encodeURIComponent(`${q} topic:opencode-plugin`)}&sort=stars&per_page=10`,
      kind: "repo",
    },
  ]
}

function githubHits(kind: GithubSearch["kind"], json: unknown): Hit[] | undefined {
  const items = record(json)?.items
  if (!Array.isArray(items)) return undefined
  const hits: Hit[] = []
  for (const raw of items) {
    const item = record(raw)
    if (!item) continue
    if (kind === "repo") {
      const name = str(item.full_name)
      if (!name) continue
      const stars = typeof item.stargazers_count === "number" ? ` [${item.stargazers_count} stars]` : ""
      const license = str(record(item.license)?.spdx_id)
      const pushed = str(item.pushed_at)?.slice(0, 10)
      const meta = [license, pushed ? `pushed ${pushed}` : ""].filter(Boolean).join(", ")
      hits.push({
        name,
        detail: `${str(item.description) ?? ""}${stars}${meta ? ` (${meta})` : ""}`.trim(),
        ...(str(item.html_url) ? { url: str(item.html_url) } : {}),
        install: `project: add "github:${name}" to "plugins" in opencode.json, after checking it is a V2 plugin`,
      })
      continue
    }
    const repo = str(record(item.repository)?.full_name)
    const path = str(item.path)
    if (!repo) continue
    const install =
      kind === "skill"
        ? `copy the skill directory${path ? ` ${path.replace(/\/?SKILL\.md$/, "") || "."}` : ""} into .opencode/skills/`
        : "Claude Code marketplace: read its entries; OpenCode does not install from it"
    hits.push({
      name: path ? `${repo}/${path}` : repo,
      ...(str(item.html_url) ? { url: str(item.html_url) } : {}),
      install,
    })
  }
  return hits
}

async function scanGithub(
  run: Run,
  which: (bin: string) => boolean,
  signal: AbortSignal,
  timeoutMs: number,
  query: string,
): Promise<SourceResult> {
  if (!which("gh")) return { source: "github", ok: true, skipped: true, reason: "gh not found", hits: [] }
  const searches = githubSearches(query)
  const answers = await Promise.all(
    searches.map(async (search) => ({ search, res: await run(["gh", "api", search.path], timeoutMs, signal) })),
  )
  const hits: Hit[] = []
  const failures: string[] = []
  const seen = new Set<string>()
  for (const { search, res } of answers) {
    if (!res.ok) {
      failures.push(`${search.label}: ${res.stderr.trim().slice(0, 200) || "gh api failed"}`)
      continue
    }
    const found = githubHits(search.kind, parseJson(res.stdout))
    if (!found) {
      failures.push(`${search.label}: invalid GitHub search response`)
      continue
    }
    for (const hit of found) {
      if (seen.has(hit.name)) continue
      seen.add(hit.name)
      hits.push(hit)
    }
  }
  if (failures.length === searches.length) return failed("github", failures.join("; "), { failures })
  return { source: "github", ok: true, hits, ...(failures.length ? { failures } : {}) }
}

// --- awesome-opencode -----------------------------------------------------

const stripTags = (html: string) =>
  html
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim()

/**
 * Entries of the awesome-opencode README: its `<details>` cards (name in `<b>`,
 * tagline in `<i>`, link in the blockquote) and plain `- [name](url) - text` bullets.
 */
export function awesomeEntries(markdown: string): Array<{ name: string; detail: string; url?: string; section?: string }> {
  const entries: Array<{ name: string; detail: string; url?: string; section?: string }> = []
  let section: string | undefined
  const cards =
    /<summary><strong>([^<]*)<\/strong><\/summary>|<details>\s*<summary>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>|^\s*[-*] \[([^\]]+)\]\(([^)\s]+)\)\s*[-–—:]?\s*(.*)$/gm
  for (const match of markdown.matchAll(cards)) {
    if (match[1] !== undefined) {
      section = stripTags(match[1]).replace(/^[^A-Za-z]+/, "") || undefined
      continue
    }
    if (match[2] !== undefined) {
      const name = stripTags(/<b>([\s\S]*?)<\/b>/.exec(match[2])?.[1] ?? "")
      if (!name) continue
      const tagline = stripTags(/<i>([\s\S]*?)<\/i>/.exec(match[2])?.[1] ?? "")
      const body = stripTags(match[3] ?? "").replace(/🔗\s*View Repository/g, "").trim()
      const url = /href="([^"]+)"/.exec(match[3] ?? "")?.[1]
      entries.push({ name, detail: [tagline, body].filter(Boolean).join(" — "), ...(url ? { url } : {}), ...(section ? { section } : {}) })
      continue
    }
    if (match[4] !== undefined) {
      entries.push({ name: match[4], detail: stripTags(match[6] ?? ""), url: match[5], ...(section ? { section } : {}) })
    }
  }
  return entries
}

async function scanAwesome(fetchFn: typeof fetch, signal: AbortSignal, query: string): Promise<SourceResult> {
  const res = await getText(fetchFn, AWESOME_OPENCODE_URL, signal)
  if (!res.ok) return failed("awesome_opencode", httpReason(res))
  const entries = awesomeEntries(res.text)
  if (entries.length === 0) return failed("awesome_opencode", "README had no recognisable entries")
  const terms = queryTerms(query)
  const hits = entries
    .map((entry) => ({ entry, score: relevance(terms, entry.name, entry.detail) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, SEARCH_CAP)
    .map(
      ({ entry }): Hit => ({
        name: entry.name,
        detail: entry.section ? `[${entry.section}] ${entry.detail}` : entry.detail,
        ...(entry.url ? { url: entry.url } : {}),
        unvetted: true,
      }),
    )
  return {
    source: "awesome_opencode",
    ok: true,
    reason: `community list, unvetted: ${hits.length} of ${entries.length} entries matched`,
    hits,
  }
}

// --- Smithery -------------------------------------------------------------

async function scanSmithery(
  fetchFn: typeof fetch,
  signal: AbortSignal,
  env: Record<string, string | undefined>,
  query: string,
): Promise<SourceResult> {
  const key = env.SMITHERY_API_KEY
  if (!key) return { source: "smithery", ok: true, skipped: true, reason: "SMITHERY_API_KEY unset", hits: [] }
  const url = `${SMITHERY_URL}?q=${encodeURIComponent(query)}&pageSize=${SEARCH_CAP}`
  const res = await getText(fetchFn, url, signal, { headers: { Authorization: `Bearer ${key}` } })
  if (!res.ok) return failed("smithery", httpReason(res))
  const servers = record(parseJson(res.text))?.servers
  if (!Array.isArray(servers)) {
    return {
      source: "smithery",
      ok: true,
      failures: ["unparseable Smithery response; raw text kept"],
      hits: [{ name: "raw", detail: res.text.slice(0, 1000) }],
    }
  }
  const hits: Hit[] = []
  for (const raw of servers.slice(0, SEARCH_CAP)) {
    const server = record(raw)
    const name = str(server?.qualifiedName) ?? str(server?.displayName)
    if (!server || !name) continue
    const uses = typeof server.useCount === "number" ? ` [${server.useCount} uses]` : ""
    const verified = server.verified === true ? " (verified)" : ""
    const description = str(server.description)
    hits.push({
      name,
      ...(description || uses || verified ? { detail: `${description ?? ""}${uses}${verified}`.trim() } : {}),
      url: `https://smithery.ai/server/${name}`,
      install:
        server.remote === true
          ? `opencode mcp add ${shortName(name)} --url https://server.smithery.ai/${name}/mcp`
          : "local server: read its Smithery page for the package and run command",
    })
  }
  return { source: "smithery", ok: true, hits }
}

// --- skills CLI -----------------------------------------------------------

async function scanSkillsCli(): Promise<SourceResult> {
  return {
    source: "skills_cli",
    ok: true,
    skipped: true,
    hits: [],
    reason:
      "not run: the skills CLI (`npx skills find`) downloads and runs package code. Discovery never runs it; " +
      "vet the package and ask the user before any `skills` command.",
  }
}

// --- orchestration --------------------------------------------------------

/**
 * Run one source under its own deadline. The source gets an abort signal, but a
 * source that ignores it still loses the race and reports a timeout.
 */
async function bounded(
  source: SourceName,
  ms: number,
  outer: AbortSignal | undefined,
  job: (signal: AbortSignal) => Promise<SourceResult>,
): Promise<SourceResult> {
  const own = new AbortController()
  const signal = outer ? AbortSignal.any([outer, own.signal]) : own.signal
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const deadline = new Promise<SourceResult>((resolve) => {
    timer = setTimeout(() => {
      own.abort()
      resolve(failed(source, `timed out after ${ms / 1000} s`))
    }, ms)
  })
  const cancelled = new Promise<SourceResult>((resolve) => {
    if (!outer) return
    onAbort = () => resolve(failed(source, "cancelled"))
    if (outer.aborted) onAbort()
    else outer.addEventListener("abort", onAbort, { once: true })
  })
  try {
    return await Promise.race([job(signal).catch((error: unknown) => failed(source, message(error))), deadline, cancelled])
  } finally {
    clearTimeout(timer)
    if (onAbort) outer?.removeEventListener("abort", onAbort)
  }
}

export async function scanSources(params: ScanParams, deps: ScanDeps = {}): Promise<ScanReport> {
  const fetchFn = deps.fetchFn ?? fetch
  const run = deps.run ?? defaultRun
  const which = deps.which ?? ((bin: string) => Bun.which(bin) !== null)
  const env = deps.env ?? process.env
  const ms = deps.timeoutMs ?? SOURCE_TIMEOUT_MS
  const query = params.query.trim()
  const requested = params.sources?.map((s) => s.trim()).filter(Boolean) ?? []
  const invalid = requested.filter((name) => !(SOURCES as readonly string[]).includes(name))
  if (invalid.length > 0) {
    throw new Error(
      `Unknown source${invalid.length === 1 ? "" : "s"}: ${invalid.join(", ")}. Valid sources: ${SOURCES.join(", ")}`,
    )
  }
  const selected = requested.length > 0 ? new Set(requested) : null
  const jobs: Record<SourceName, (signal: AbortSignal) => Promise<SourceResult>> = {
    local: () => scanLocal(deps.local),
    catalog: (signal) => scanCatalog(fetchFn, signal, query, deps.catalogUrl ?? DEFAULT_CATALOG_URL, deps.skillCatalogs ?? []),
    mcp_registry: (signal) => scanMcpRegistry(fetchFn, signal, query),
    npm: (signal) => scanNpm(fetchFn, signal, query),
    github: (signal) => scanGithub(run, which, signal, ms, query),
    awesome_opencode: (signal) => scanAwesome(fetchFn, signal, query),
    smithery: (signal) => scanSmithery(fetchFn, signal, env, query),
    skills_cli: scanSkillsCli,
  }
  const completed = new Set<SourceName>()
  const results = await Promise.all(
    SOURCES.map(async (source): Promise<SourceResult> => {
      if (selected && !selected.has(source)) {
        return { source, ok: true, skipped: true, reason: "not requested", hits: [] }
      }
      if (deps.signal?.aborted) return failed(source, "cancelled")
      const result = await bounded(source, ms, deps.signal, jobs[source])
      if (result.reason !== "cancelled") completed.add(source)
      return result
    }),
  )
  const classified: ClassifiedSource[] = results.map((r) => ({ ...r, status: classify(r) }))
  const gaps: Gap[] = []
  const coverage: Coverage = { answered: 0, empty: 0, partial: 0, unavailable: 0, failed: 0 }
  for (const r of classified) {
    if (r.status === "ok") coverage.answered++
    else if (r.status === "empty") coverage.empty++
    else if (r.status === "partial") {
      coverage.partial++
      gaps.push({ source: r.source, kind: "partial", reason: r.failures?.join("; ") ?? r.reason ?? "partial coverage" })
    } else if (r.status === "skipped") {
      coverage.unavailable++
      gaps.push({ source: r.source, kind: "unavailable", reason: r.reason ?? "skipped" })
    } else {
      coverage.failed++
      gaps.push({ source: r.source, kind: "failed", reason: r.reason ?? "failed" })
    }
  }
  const started = SOURCES.filter((s) => !selected || selected.has(s))
  const cancellation = deps.signal?.aborted
    ? { completed: started.filter((s) => completed.has(s)), timedOut: started.filter((s) => !completed.has(s)) }
    : undefined
  return { results: classified, gaps, coverage, ...(cancellation ? { cancellation } : {}) }
}

// --- rendering ------------------------------------------------------------

const SEARCH_HITS_SHOWN = 8

function clip(text: string | undefined, max: number): string | undefined {
  if (!text) return text
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/** Local inventory renders every entry: the skill's coverage check reads it. */
export function renderScan({ results, gaps, coverage, cancellation }: ScanReport): string {
  const lines: string[] = []
  for (const r of results) {
    lines.push(`[${r.status}] ${r.source}${r.reason ? ` — ${r.reason}` : ""} (${r.hits.length} hits)`)
    const shown = r.source === "local" ? r.hits : r.hits.slice(0, SEARCH_HITS_SHOWN)
    for (const h of shown) {
      const detail = clip(h.detail, r.source === "local" ? 120 : DETAIL_CHARS)
      const label = h.unvetted ? " [unvetted]" : ""
      lines.push(`  - ${h.name}${label}${detail ? `: ${detail}` : ""}${h.url ? ` <${h.url}>` : ""}`)
      if (h.install) lines.push(`    install hint${h.runsCode ? " (runs package code)" : ""}: ${h.install}`)
    }
    if (shown.length < r.hits.length) lines.push(`  - … ${r.hits.length - shown.length} more in metadata.results`)
  }
  lines.push(
    `coverage: ${coverage.answered} answered, ${coverage.empty} empty, ${coverage.partial} partial, ${coverage.unavailable} unavailable, ${coverage.failed} failed`,
  )
  if (cancellation) {
    lines.push(
      `cancelled: completed [${cancellation.completed.join(", ") || "none"}], not finished [${cancellation.timedOut.join(", ") || "none"}]`,
    )
  }
  if (gaps.length) {
    lines.push("gaps:")
    for (const g of gaps) lines.push(`  - ${g.source} (${g.kind}): ${g.reason}`)
  }
  lines.push("Install hints are suggestions for the user. find_tools_scan never installs or runs anything it found.")
  return lines.join("\n")
}
