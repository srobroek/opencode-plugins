import { describe, expect, test } from "bun:test"
import { githubApproval, githubChecks, gitlabApproval, gitlabChecks } from "./approval.ts"

const HEAD = "0123456789abcdef0123456789abcdef01234567"
const OLD = "1111111111111111111111111111111111111111"

describe("githubApproval", () => {
  test("an APPROVED review for the exact head approves", () => {
    const payload = {
      author: { login: "me" },
      reviews: [{ state: "APPROVED", author: { login: "you" }, commit: { oid: HEAD.toUpperCase() } }],
      comments: [],
    }
    expect(githubApproval(payload, HEAD)).toEqual({
      ok: true,
      evidence: { kind: "review", reviewer: "you", commit: HEAD },
    })
  })

  test("an APPROVED review for another head does not", () => {
    const payload = { author: { login: "me" }, reviews: [{ state: "APPROVED", commit: { oid: OLD } }], comments: [] }
    const result = githubApproval(payload, HEAD)
    expect(result.ok).toBe(false)
  })

  test("a VERDICT comment counts only from the author's own account and only naming the head", () => {
    const comment = (login: string, body: string) => ({
      author: { login: "me" },
      reviews: [],
      comments: [{ author: { login }, body }],
    })
    expect(githubApproval(comment("me", `VERDICT: APPROVE — reviewed ${HEAD}`), HEAD).ok).toBe(true)
    expect(githubApproval(comment("someone", `VERDICT: APPROVE ${HEAD}`), HEAD).ok).toBe(false)
    expect(githubApproval(comment("me", `VERDICT: APPROVE ${OLD}`), HEAD).ok).toBe(false)
    expect(githubApproval(comment("me", `looks fine\nVERDICT: APPROVE ${HEAD}`), HEAD).ok).toBe(false)
    expect(githubApproval(comment("me", `VERDICT: REQUEST-CHANGES ${HEAD}`), HEAD).ok).toBe(false)
  })

  test("a payload without the arrays refuses", () => {
    expect(githubApproval({}, HEAD).ok).toBe(false)
    expect(githubApproval(null, HEAD).ok).toBe(false)
  })
})

describe("githubChecks", () => {
  test("pass and skipping are green", () => {
    expect(githubChecks([{ bucket: "pass" }, { bucket: "skipping" }])).toEqual({ ok: true, evidence: { checks: 2 } })
  })

  test("pending, failing, or no checks refuse", () => {
    expect(githubChecks([{ name: "a", bucket: "pending" }])).toMatchObject({ ok: false })
    expect(githubChecks([{ name: "a", bucket: "fail" }])).toMatchObject({ ok: false })
    expect(githubChecks([])).toMatchObject({ ok: false })
    expect(githubChecks({})).toMatchObject({ ok: false })
  })
})

describe("gitlab", () => {
  test("approvals need approved true at the head", () => {
    expect(gitlabApproval({ approved: true, sha: HEAD, approved_by: [{ user: { username: "you" } }] }, HEAD)).toEqual({
      ok: true,
      evidence: { kind: "gitlab-approvals", approvedBy: ["you"] },
    })
    expect(gitlabApproval({ approved: false, sha: HEAD }, HEAD).ok).toBe(false)
    expect(gitlabApproval({ approved: true, sha: OLD }, HEAD).ok).toBe(false)
  })

  test("checks need a successful head pipeline on the head", () => {
    expect(gitlabChecks({ head_pipeline: { id: 7, status: "success", sha: HEAD } }, HEAD)).toEqual({
      ok: true,
      evidence: { pipeline: 7 },
    })
    expect(gitlabChecks({ head_pipeline: { status: "running", sha: HEAD } }, HEAD).ok).toBe(false)
    expect(gitlabChecks({ head_pipeline: { status: "success", sha: OLD } }, HEAD).ok).toBe(false)
    expect(gitlabChecks({}, HEAD).ok).toBe(false)
  })
})
