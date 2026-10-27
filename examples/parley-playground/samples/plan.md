# Plan: add a response cache

## Goal

Cut p95 latency of `GET /reports` from 800 ms to under 200 ms.

## Approach

1. Put an in-process LRU cache in front of the report query.
2. Key by `(tenant, report, params)`; expire entries after 60 s.
3. Invalidate a tenant's entries when one of its reports is saved.

## Rollout

- Ship behind the `report_cache` flag, off by default.
- Turn it on for internal tenants, then 10 %, then everyone.
- Keep the uncached path for one release, then delete it.

## Risks

- Stale reports for up to 60 s after an edit in another process.
- Memory growth on large tenants; cap the cache at 5 000 entries.
