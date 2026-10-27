---
name: review-security
description: Use when reviewing code for vulnerabilities to trace untrusted input to sinks, tag CWEs and check dispatch.
metadata:
  opencode/autoinvoke: false
---

# Security review

Find vulnerabilities an attacker can reach. A finding needs a path from a source the attacker controls to a sink or a missing control, not a pattern match.

## 1. Map the attack surface

List the entry points in scope before reading deeply: HTTP and RPC handlers, CLI arguments and flags, environment variables, files and uploads, IPC, queues and webhooks, deserialised data, and model or tool output fed back into code. Note who can reach each one: anonymous, any user, an admin, a local process.

## 2. Trace source to sink

For each entry point, follow the data through every call, assignment and transformation until it reaches a sink or is dropped. Read the callee, not its name: a `sanitize()` that only trims whitespace sanitises nothing.

| Sink | Look for | CWE |
| --- | --- | --- |
| Shell or process spawn | string-built commands, `shell: true`, unquoted args, option injection (`-`-led values) | CWE-78, CWE-88 |
| SQL, NoSQL, LDAP, XPath | concatenated queries, unparameterised filters | CWE-89, CWE-943 |
| HTML, templates, DOM | unescaped output, `innerHTML`, raw template blocks | CWE-79 |
| File paths | `..`, absolute paths, symlinks, archive entries (zip slip) | CWE-22, CWE-59 |
| Outbound requests | user-chosen URLs or hosts reaching internal services | CWE-918 |
| Deserialisation and code evaluation | `pickle`, YAML full loaders, JS eval or `new Function`, dynamic imports | CWE-502, CWE-94 |
| Regex | user-supplied or nested-quantifier patterns on user input | CWE-1333 |
| Redirects | user-chosen redirect targets | CWE-601 |

## 3. Check the controls

- Authentication on every entry point that needs it (CWE-306), and authorisation on the object, not just the route: can user A act on B's id (CWE-639, CWE-862, CWE-863)?
- Validation is an allowlist at the boundary, with encoding at the sink matching the sink's syntax (CWE-20, CWE-116).
- Secrets never land in code, logs, errors or URLs (CWE-798, CWE-532, CWE-209); comparisons of secrets are constant-time (CWE-208).
- Crypto uses vetted libraries, current algorithms and real randomness (CWE-327, CWE-330); TLS checks stay on (CWE-295).
- Check-then-use on files or state is atomic (CWE-367); resources have limits (CWE-400, CWE-770).
- Agent or LLM input: text from files, pages or tool output that reaches a prompt, a tool call or a shell is untrusted (CWE-77, CWE-1427).

## 4. Cross-boundary dispatch

For every type, variant, message or value a change sends across a function, module or process boundary, find the consuming dispatch point -- switch, router, handler registry, middleware or filter chain -- even outside the diff. Confirm the new case meets the same authorisation and validation as its siblings. A new variant that skips a guard, falls through to a permissive default, or is silently dropped is a finding.

## 5. Report

One root cause is one finding: list every location it reaches. Per finding give severity (critical, high, medium, low, informational), confidence, the CWE id, the source `path:line` and the sink `path:line`, why the controls fail, and the fix. Reject a candidate without a credible execution path; say what you reviewed when nothing survives.
