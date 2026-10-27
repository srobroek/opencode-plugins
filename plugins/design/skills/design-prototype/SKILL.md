---
name: design-prototype
description: Routes a wireframe, mockup, prototype or deck request to the right producer; triggers on wireframe this or prototype.
---

# Design Prototype

Phase SPECIFY. Produce a throwaway artifact that answers a layout or flow question
before anything real is built.

TRIGGER
+ "wireframe this", "make a prototype", "show me a mockup"
+ "what should this look like" asked before any implementation exists
- implementing a real surface against the system -> `ui-ux-specialist`
- verifying a surface that already renders -> `ui-review`
- whether a state model or logic holds up -> `prototype-logic` (quality plugin)
- recording the durable visual system -> `design-md`

## Workflow
1. Pick the route from the fidelity table below, then resolve it by KIND, because the rows
   are not all skills.
   - An UPSTREAM SKILL row: apply the `design-upstream-preflight` skill for that row BEFORE
     loading it. -> installed, and loaded by name or, when installed this session and not
     yet listed, from its install path. Install refused or failed: STOP and report the gap. Do NOT
     take a different row instead: each row answers a different question, and a
     substituted fidelity reads like the real one.
   - An MCP SERVER row: check the tool is in your available tools. A configured server is
     not a connected one. Absent: STOP and say so, naming the server's config entry (see
     the design plugin's README) or the harness's MCP reconnect command (in OpenCode,
     `/mcps`) as the user's move. Do NOT drop to another row.
   - A HARNESS TOOL row, such as image generation: check the tool is present, and STOP and
     say so if it is not, rather than substituting a different fidelity.
   -> the chosen route and its kind are both named before any file is written.
2. Produce exactly one artifact on that route. -> the artifact opens or renders, and its
   path is reported.
3. SERVE it whenever it is interactive, rather than handing over a file path. A clickable
   prototype judged by reading its source is not judged at all.
   -> a background shell process running `python3 -m http.server "<port>" --bind 127.0.0.1`
   with its working directory set to the artifact's directory; wait until the port answers.
   -> SELF-CHECK before reporting, because this is the step that silently does not happen:
   fetch your own URL and report the status, `curl -sS -o /dev/null -w '%{http_code}'
   "http://127.0.0.1:<port>/<file>"`. A 200 is the only proof it ran. With no status line,
   report NOT SERVED plus the blocker, the absolute file path, and the one-line command a
   human runs from that directory. Never report a URL you did not fetch.
   -> Then drive it yourself with the `ui-review` skill at 1440, 768, and 375 before claiming
   the flow works. An SVG or a single HTML file serves the same way.
   -> Stop the background server before reporting, or explicitly hand it off to a human with
   its process id and stop command. Never leave a hub process running after this task.
4. State what the artifact does not answer. -> a named gap list, because a low-fidelity
   artifact settles layout and flow, never final visual detail.

| need | route |
|---|---|
| low-fidelity layout, one self-contained file | upstream `html-wireframe` |
| wireframe inside a Markdown doc, git-diffable | the `wireloom` skill, vendored here, always available |
| clickable multi-screen flow with keyboard support | upstream `html-prototype` |
| vector wireframe as SVG, PNG, or PDF | the `wire-dsl` MCP server, configured as the design plugin's README shows |
| raster visual concept | the harness's image-generation tool, when it has one; pass reference images as its input |
| fixed 16:9 deck or PDF | upstream `frontend-slides` |
| favicon, app icon, or social image files | upstream `web-asset-generator` |
| hosted concept exploration | upstream `superdesign`, after the user confirms the account |
| rendered surface against a reference mockup | a screenshot, then a vision comparison of the two images against an explicit question; a screenshot diff against the baseline, with its threshold, for a measured pixel diff |
| structurally different variants of an existing page, inside the real app | in-app `?variant=` switcher behind a dev-only flag: `references/in-app-variants.md` |

Producer install identities: `references/upstream.md`

## Rules

MUST Prefer the local account-free route before any hosted service.
MUST State which route produced an artifact. A reader cannot judge fidelity without it.
MUST Report a vision comparison of images as a judgement; a measured claim needs a screenshot diff against a baseline, with its threshold.
MUST Report the measured HTTP status beside any URL you hand over. A URL with no status
  behind it is exactly the failure the self-check exists to catch.
DEFAULT One artifact per question. A second fidelity level is a second request.
NOT Present a generated image as an implementation plan.
NOT Take a hosted route before the user confirms the account it needs.

## Output

L1 ARTIFACT: path, plus the route that produced it.
   Served -- the URL and the HTTP status you measured, or NOT SERVED plus the blocker,
   the absolute path, and the command to serve it.
   Answers -- the layout or flow question it settles.
   Open -- what it does not answer.
CAP 100w
