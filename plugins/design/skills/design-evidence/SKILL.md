---
name: design-evidence
description: Use when making any claim about a rendered UI, to cite ARIA, computed-style or screenshot evidence with the viewport.
---

MUST Cite, per claim, the ONE kind that fits it: an ARIA snapshot (the browser's accessibility snapshot, such as Playwright's `ariaSnapshot()` YAML), a computed-style value read with page-side JavaScript, or a screenshot path. This governs citation. Collection order is separate and lives in the phase map of the `ui-review` skill's `references/tools.md`: snapshot the tree once per pass before claiming anything, then cite whichever kind the claim needs.
MUST Name the viewport width on every layout claim: `1440`, `768`, or `375`, or `320` for a 1.4.10 Reflow claim, which WCAG specifies at 320 CSS px.
MUST Re-verify only the assertion that changed after a fix. Unchanged assertions stay cited from the prior pass.
NOT Close VERIFY, CRITIQUE, or RECONCILE with "looks good", "should work", or "appears correct".
NOT Use a screenshot diff as the sole evidence for a claim.
NOT Infer a native-app result from a web snapshot, or the reverse.

| situation | choice |
|---|---|
| claim about roles, names, or focus | ARIA snapshot first |
| claim about color, size, or spacing | computed style |
| claim about appearance only | screenshot path, after the two above |
| layout at a breakpoint | same evidence plus the width |
| fix landed | re-run that one assertion |
