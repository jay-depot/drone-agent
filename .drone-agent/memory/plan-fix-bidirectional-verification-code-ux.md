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
updated: 2026-08-11T23:25:52.377Z
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

### 1. Coordinator backend — persist code on re-registration
File: `drone-coordinator/src/db/beacon-trust.ts`
- In the `registerBeaconTrust()` re-registration branch (existing trust record),
  recompute `verificationCode` from the same inputs used at first registration:
  `generateVerificationCode(req.publicKey, req.tlsFingerprint ?? '', getCoordinatorFingerprint() ?? '')`.
  Include `verification_code = @verificationCode` in the UPDATE statement and the
  returned trust object. (The returned object currently spreads `existing`, which
  carries the stale/empty code.)
- Note: `getCoordinatorFingerprint()` may be undefined if HTTPS disabled; the code
  is still deterministic and matches the beacon's side only when both compute from
  the same observed fp.

### 2. Coordinator backend — include code in list response (for Option 2 dialog)
File: `drone-coordinator/src/routes/beacons.ts`
- In `GET /beacons`, add `verificationCode: trust?.verificationCode ?? null` to
  each `beaconsWithTrust` entry (alongside existing `trustStatus`/`publicKey`).

### 3. Coordinator UI — types
File: `drone-coordinator-ui/src/lib/types.ts`
- Add `verificationCode?: string | null;` to the `Beacon` interface (list items
  used by the topology page). `BeaconDetail` already has it.

### 4. Coordinator UI — topology approve dialog (Option 2)
File: `drone-coordinator-ui/src/pages/topology.tsx`
- In the `approve` case of `getDialogContent()`, surface the code inline. The
  `dialogBeacon` is a `Beacon`; after step 3 it carries `verificationCode`. Add a
  section showing the code prominently (e.g. a `font-mono` bold line) when present.
- Fix the copy: it currently says "verify the bidirectional verification code
  matches the one shown on the beacon" — replace with copy directing the operator
  to the code shown in THIS dialog (it is now the single source of truth). If no
  code is present (e.g. HTTPS disabled), show a note instead of referencing the beacon.

### 5. Agent — stop surfacing/pre-filling the code (Option A)
File: `drone-agent/src/plugins/swarm/tools-coordinator-trust.ts`
- In `surfacePendingCoordinatorTrust()`, REMOVE the lines that print the beacon's
  own `verificationCode` and pre-fill `/trust-coordinator <code>`. Do NOT include
  the verification code value anywhere in the surfaced warning.
- Keep surfacing BOTH gate halves (fingerprint not confirmed / beacon not approved).
- Update the guidance text: tell the user to open the coordinator web UI
  (beacon detail page), read the 4-word verification code there, and run
  `/trust-coordinator <code>` with THAT value. Do not echo a value.

### 6. Beacon — stop logging the code to stdout (Option A)
File: `drone-beacon/src/index.ts`
- Remove the `if (result.verificationCode) { logger.info(...) }` block (line ~252).
- In the `[REMINDER]` interval, remove the verification-code logging lines; keep a
  plain "Beacon still pending approval. Approve via web UI or --approve-beacon <id>"
  reminder (no code value).

### 7. Docs
File: `docs/agents/swarm-plugin.md`
- Update the "Agent (human-only)" bullet (line ~40) and the "bidirectional
  verification code" section: the code is displayed ONLY in the coordinator web UI
  (beacon detail page AND topology approve dialog); the agent/beacon do NOT display
  it. Update "Approve a pending beacon" web-UI bullet to say the code is shown
  inline in the approve dialog.

### 8. Tests
- `drone-coordinator/test/db.test.ts`: extend/replace the re-registration test to
  assert `verificationCode` is recomputed and persisted (not empty) after
  re-registration.
- `drone-coordinator/test/routes/beacons.test.ts`: assert `GET /beacons` list
  entries include `verificationCode`.
- `drone-coordinator-ui/src/pages/trust.test.tsx`: topology approve test — include
  `verificationCode` in the mocked `/api/beacons` list entry and assert the dialog
  displays it before approving.
- `drone-agent/test/swarm-coordinator-trust.test.ts`: update the "surfaces pending
  gate halves" test to assert the surfaced warning does NOT contain the
  verification code value, and that it still references opening the web UI.
- `drone-beacon`: (index.ts stdout logging is in main(); no unit test currently
  covers it — no test change required, but verify nothing else references the
  removed logging).

## Validation criteria

- LSP passes (typescript, yaml, json) for all changed files.
- `pnpm -r run build` passes (drone-core first, then dependents; drone-coordinator-ui build too).
- `pnpm -r run lint` passes.
- `pnpm -r run test` passes (fast suite).
- The agent's `[SECURITY]` warning never contains the verification code value and
  never pre-fills `/trust-coordinator <code>` (grep the surfaced-string builder).
- The beacon no longer logs the verification code to stdout (no `Verification code:`
  / `[REMINDER] ... Verification code:` strings in `drone-beacon/src/index.ts`).
- The topology approve dialog shows the 4-word code inline and its copy no longer
  references "the code shown on the beacon."
- Coordinator re-registration persists `verification_code` (db test) so an existing
  beacon's detail page + approve dialog populate the code.
- Dead code removed; no stale comments.