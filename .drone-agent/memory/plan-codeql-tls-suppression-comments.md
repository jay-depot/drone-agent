---
key: plan-codeql-tls-suppression-comments
tags:
  []
created: 2026-08-14T18:45:19.867Z
updated: 2026-08-14T18:45:19.867Z
---

# Plan: CodeQL — fix TLS suppression comments (lgtm → codeql)

## Summary
The existing `// lgtm[js/disabling-certificate-verification]` comments in `drone-beacon/src/coordinator-client.ts` do NOT suppress GitHub CodeQL alerts — `lgtm[...]` is LGTM.com syntax, unsupported by GitHub code scanning (LGTM.com shut down Dec 2022). The correct syntax is `// codeql[rule-id]` on the sink line or the line immediately before it. This is the same finding as the reflected-XSS plan (plan-codeql-reflected-xss-suppression).

## Research finding (shared with reflected-XSS plan)
- `// lgtm[rule-id]` is LGTM.com-only, NOT recognized by GitHub CodeQL/code scanning.
- Correct syntax: `// codeql[rule-id]`, placed on the sink line or the line immediately before it.
- Rule ID for this alert is `js/disabling-certificate-verification` (correct in the existing comments).
- Suppression targets the sink location. A comment in a JSDoc block far from the sink is ineffective.

## Sinks in drone-beacon/src/coordinator-client.ts
- Sink: line 225 `(options as https.RequestOptions).rejectUnauthorized = false;`
- Line 190: ` * lgtm[js/disabling-certificate-verification]` — inside the JSDoc for createCoordinatorFetch, NOT adjacent to the sink → ineffective. REMOVE this line (keep the explanatory JSDoc text).
- Line 224: `// lgtm[js/disabling-certificate-verification]` — immediately before the sink line 225 → correctly placed. CHANGE keyword `lgtm` → `codeql`.

## Steps
1. `drone-beacon/src/coordinator-client.ts`:
   - Remove the ` * lgtm[js/disabling-certificate-verification]` line from the JSDoc block (line 190). Keep the surrounding explanatory text.
   - Change line 224 from `// lgtm[js/disabling-certificate-verification]` to `// codeql[js/disabling-certificate-verification]`.
2. No behavior change, no tests needed (comment-only change).
3. Validation: LSP zero errors; `pnpm -r run lint` zero errors; `pnpm -r run build` zero errors; fast test suite passes.
4. After commit, re-run code scanning; the TLS alert will be marked suppressed.

## Files touched
- drone-beacon/src/coordinator-client.ts

## Notes
- No drone-core changes → no cross-package rebuild needed before typecheck, but run `pnpm -r run build` as part of validation anyway.
- Do NOT use `// lgtm[...]` (unsupported).
