---
key: plan-fix-bidirectional-verification-code-ux
tags:
  - plan
  - swarm
  - coordinator
  - verification-code
  - mitm
  - beacon-trust
created: 2026-08-11T23:25:52.377Z
updated: 2026-08-11T23:33:23.029Z
---

# Plan: Fix bidirectional verification-code UX (MITM protection)

## Summary

The bidirectional 4-word verification code (coordinator web UI display-only, agent
compare-only via `/trust-coordinator <code>`) is broken in two ways:

1. **MITM protection is inverted.** The agent's `surfacePendingCoordinatorTrust()`
   prints the beacon's OWN verification code and pre-fills it into the suggested
   `/trust-coordinator <code>` command. The beacon trivially compares the code
   against ITSELF, so it always "matches" — the real comparison against the web
   UI's code never happens. This means the protection doesn't exist.
2. **The code never shows in the web UI for existing beacons.** The coordinator's
   `registerBeaconTrust()` only computes + persists `verification_code` on a
   beacon's FIRST registration. The re-registration path (every restart) only
   UPDATEs host/port/tls_fingerprint, so `verification_code` stays NULL/'' for
   any row that predates the column or has re-registered — the web UI's
   `{beacon.verificationCode && ...}` guard renders nothing.

We fix only the re-registration path (NOT building a migration system — see
memory `db-migrations-system-deferred`).

## Design (confirmed with user)

- **Option A** for code display: remove the code from the agent UI AND from the
  beacon's stdout logging/reminder. Code appears in exactly ONE place: the web UI.
- **Option 2** for the web UI: surface the code inline in the topology approve
  dialog (not just on the beacon detail page), and fix the stale dialog copy that
  references "the code shown on the beacon."
- Coordinator re-registration persists the verification code.

## Steps

(see file .drone-agent/memory/plan-fix-bidirectional-verification-code-ux.md for full steps 1-8 + validation criteria)

## Completed (2026-08-11)

All steps executed and committed in `0799a43` on branch `copilot/fix-codeql-issue-26`.

### What changed

- **Coordinator** (`db/beacon-trust.ts`): re-registration branch now recomputes
  `verification_code` from `req.publicKey` + `req.tlsFingerprint ?? ''` +
  `getCoordinatorFingerprint() ?? ''` and persists it in the UPDATE, and returns
  it on the returned trust object.
- **Coordinator** (`routes/beacons.ts`): `GET /beacons` list entries now include
  `verificationCode: trust?.verificationCode ?? null`.
- **Coordinator UI** (`lib/types.ts`): added `verificationCode?: string | null`
  to the `Beacon` interface.
- **Coordinator UI** (`topology.tsx`): approve dialog surfaces the code inline
  (font-mono, bold) and its copy now references the dialog's own code instead of
  "the code shown on the beacon."
- **Agent** (`tools-coordinator-trust.ts`): `surfacePendingCoordinatorTrust()`
  no longer prints/pre-fills the code; it surfaces both gate halves and directs
  the user to read the 4-word code from the web UI. `verificationCode` field was
  removed from the fetched shape (it's no longer used).
- **Beacon** (`index.ts`): removed the stdout `Verification code:` log and the
  `[REMINDER] ... Verification code:` lines; the pending reminder now points to
  the web UI / `--approve-beacon <id>` only. The beacon still holds the code in
  memory (`setBeaconVerificationCode`) for the compare-only `/coordinator/trust`
  endpoint — that part was already correct and unchanged.
- **Docs** (`swarm-plugin.md`): the code is documented as displayed ONLY in the
  web UI (detail page AND approve dialog); the agent/beacon never display it.
  Fixed the stale "shown on the beacon" copy in the both-sides-gate section and
  the certificate-rotation step 6.

### Tests added/updated

- `drone-coordinator/test/db.test.ts`: re-registration test now asserts the
  recomputed code is returned AND persisted (`getBeaconTrust(...).verificationCode`).
- `drone-coordinator/test/routes/beacons.test.ts`: `GET /beacons` test asserts a
  pending beacon's list entry carries a truthy `verificationCode`.
- `drone-coordinator-ui/src/pages/trust.test.tsx`: approve-dialog test mocks a
  `verificationCode` in the list and asserts the dialog displays it inline.
- `drone-agent/test/swarm-coordinator-trust.test.ts`: "surfaces pending gate
  halves" test now captures the warning and asserts it references the web UI but
  does NOT contain the code value or a pre-filled `/trust-coordinator <word>`.

### Validation results

- LSP: clean on all changed files.
- `pnpm -r run build`: passes.
- `pnpm lint:eslint`: passes (with `--fix`); prettier reformatted `topology.tsx`.
- `pnpm test`: 1832 passed | 9 skipped (fast suite).
- Grep checks: no pre-fill in agent source; no `Verification code` / `Compare
  this code` strings in beacon `index.ts`; no stale "shown on the beacon" copy in
  UI or docs. The agent still has `verificationCode` references only in the slash
  command handler (compare-only input), which is correct.

### Notes / follow-ups

- The schema-evolution fragility that caused the web-UI code to never appear is
  deferred to a proper migration system — see memory
  `db-migrations-system-deferred` (Option A minimal versioned runner was the lean
  recommendation).