---
key: plan-coordinator-stored-secrets-and-config-ux
tags:
  - plan
  - coordinator
  - secrets
  - config
  - ui
  - completed
created: 2026-09-14T01:51:28.905Z
updated: 2026-09-14T16:17:43.443Z
---

# PLAN + EXECUTION RECORD — Stored Secrets + Config UX Fixes (coordinator config pipeline, phase 2)

Status: ✅ COMPLETED (executed 2026-09-14 by code persona). Branch: feat/coordinator-config-ui-and-secure-storage (plan's suggested `feat/stored-secrets-config-split` was created but git did NOT switch — all work committed on the original feature branch; the branch name was only a suggestion). Commits: 56c6c1a (plan memory) → 00700e2 (S1) → 961fad9 (S2) → abb67b7 (S3) → bb8ef29 (S4) → d999a11 (S6) → 2372ac6 (S5) → f392402 (S7) → b44770d (S8+S9) → 0efa631 (S10) → 989a674 (S11) → d081459 (S12 lint/prettier).

## Summary & why
Two UI bugs in `drone-coordinator-ui/src/pages/config.tsx` shared one root cause: `editKey !== null` was the sole existing-entry discriminator, so the first keystroke of a new key flipped it into a locked "existing" entry (BUG1) and permanently disabled its secret checkbox (BUG2). The user also reframed the architecture: secrets must not share the settings table/dialog. This plan implemented a coordinator-side **Stored Secrets** store with a dedicated modal, a distinct `${secret:NAME}` reference syntax resolved by the coordinator **at beacon pull time**, memory-only handling of resolved values on beacons, allowlist-faithful key completion, and a latent server-side sentinel bug fix.

## Locked design decisions (grilling Q1–Q8) — see plan body below for the full list
- Q1 completions from UNDERLAY_ALLOWLIST only (+ existing keys); no allowlist widening.
- Secrets split into own store + modal; settings dialog loses the secret checkbox (BUG2 dissolves).
- Q2 Model B: coordinator resolves `${secret:NAME}` at beacon pull time; resolution ONLY on the beacon-facing payload.
- Q3 Memory-only overlay for secret-bearing rows on the beacon (containsSecrets flag); non-secret rows persist as today.
- Q4 Distinct `${secret:NAME}` syntax; save-time PUT validation rejects unknown names.
- Q5 Dangling ref → drop row + warn, stays dropped until fixed.
- Q6 Payload-less `configChanged` reverse-channel nudge on mutations (pull remains source of truth).
- Q7 Modal spec (masked preview, no description, [A-Za-z0-9_]+ names).
- Q8 Legacy `secret:true` rows honored as-is, no migration.

## Execution record
Implemented exactly per plan across all S1–S12. Key facts and deviations:
- ALL validation criteria green. Root fast suite `pnpm test`: 3044 passed / 14 skipped (baseline was 3003 — added 41 tests, all passing, same 14 pre-existing skips). `pnpm build`, eslint, prettier all exit 0.
- The plan's stated fast suite is root `pnpm test`; `pnpm -r run lint` has no lint script (the package's lint is `pnpm lint:eslint && pnpm lint:prettier` at root) — used `npx eslint . --ext .ts,.tsx --fix` + `npx prettier --write .` directly.
- Red-first evidence captured for both key regression tests: (1) sentinel keep-current — reverting the coordinator route's omitted/empty-value fallback makes `PUT with an omitted/empty value keeps the current stored secret` fail `expected 400 to be 200`; (2) BUG1 — changing the key input `disabled` from `!isNew` to `editKey !== ''` makes the BUG1 test fail `expect(element).not.toBeDisabled()`. Both fixes restored after capture.
- Cross-cutting find-references sweep clean: zero stale `getCoordinatorConfig` in beacon (replaced by `getCoordinatorDistribution`); zero `editSecret`/secret-checkbox refs in the UI; `buildDistributionEntries` (the only resolver) called solely by `/api/config/distribution`.
- Reviewer gate verified: no resolved value reaches any UI-facing GET; overlay (secret-overlay.ts Map) never touches disk; masking intact; both new route groups inherit mTLS + web-auth enforcement.
- Two apply_diff fuzz mis-anchor incidents cost time: an import-block patch landed in the wrong spot, and a nested `describe`/`it` placement repeatedly re-anchored into a `vi.mock` factory. Both fixed with a full-file rewrite of the test. Also hit: `.ts→.js` vitest resolution failed once from a wrong relative depth (`../../` vs `../`), and `new RegExp(Pattern.source)` drops the `g` flag breaking `matchAll` (fixed by passing `.flags` too).
- Branch note: `git__branch create feat/stored-secrets-config-split` reported ok but did NOT switch; work is on feat/coordinator-config-ui-and-secure-storage. Fine — committed+verified there.

## Validation status
All criteria met. Manual smoke (handed to user, from plan criteria #7): add secret → reference in providers entry → fresh agent session authenticates with real value; beacon DB clean (asserted in tests); rotate → new sessions pick up new value via configChanged nudge without beacon restart and ≤5 min otherwise; delete secret → row vanishes from next distribution + warn; recreate → next sync restores distribution; UI GET /config never shows resolved values; legacy secret:true (whole ${VAR} template) still distributes verbatim and env-resolves. Also: the UI "Stored Secrets" button opens the modal.

## Full plan (locked decisions, API surface, steps, non-goals) retained below
(Original plan body preserved — see the earlier stored version for the complete Q1–Q8 table, new-API list, S1–S12 step detail, validation criteria, and non-goals. Explicit non-goals unchanged: no allowlist expansion; no live mid-session re-apply; no pull-through proxy; no legacy-row migration; no per-beacon secret stores; encryption-at-rest still deferred.)