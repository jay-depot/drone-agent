---
key: plan-bidirectional-coordinator-auth-ux
tags: []
created: 2026-08-11T22:37:22.386Z
updated: 2026-08-11T22:37:22.386Z
---

# Plan: Complete bidirectional coordinator-auth verification-code UX + remove approval token

## Summary

The bidirectional verification code (decisions 117-119) is computed on both sides but never actually surfaced or enforced. The web UI's Approve flow still depends on the obsolete opaque `approvalToken`; the agent only surfaces one half of the both-sides trust gate. This plan makes the web UI display-only (show code, approve by ID), the beacon/agent compare-only (/trust-coordinator <code>), and removes the approval-token mechanism entirely.

## Design (confirmed with user)

- Web UI = display-only: shows bidirectional verification code prominently; approves beacons by ID (no token)
- Beacon/agent = compare-only: `/trust-coordinator <code>` transcribes the code shown in the web UI; beacon compares against its in-memory computed code; a match confirms the coordinator fingerprint (half A)
- Agent surfaces BOTH gate halves: half A (fingerprint confirmed), half B (beacon awaiting coordinator approval) + its own verification code
- Remove approvalToken entirely: DB column, POST /beacons/approve, --approve, approveBeacon(token); add approve-by-ID route + --approve-beacon <id> CLI
- Beacon stores its computed verification code in memory at registration (coordinator-trust module)

## Steps

### Coordinator backend

1. Persist verificationCode: add `verification_code` column to beacon_trust (idempotent migration in db/init.ts); store on registerBeaconTrust; return from getBeaconTrust/listBeaconTrust.
2. Remove approval token: drop `approval_token` column (migration); remove `generateApprovalToken`, `approveBeacon(token)`; add `approveBeaconById(id)` in db/beacon-trust.ts.
3. Routes (beacons.ts): remove `POST /beacons/approve`; add `POST /beacons/trust/:id/approve` (approve by ID, uses approveBeaconById, publishMutationEvent). Update `POST /beacons` and `POST /beacons/trust` responses to omit approvalToken, keep verificationCode.
4. CLI (index.ts): remove `--approve <token>` + handleApprove + config.approvalToken; add `--approve-beacon <id>` + handleApproveBeacon; update list-beacons to drop token output; update --help.
5. types.ts: remove `approvalToken` from BeaconTrust and BeaconStatusResponse; keep `verificationCode`.

### Coordinator UI

6. lib/types.ts: remove `approvalToken` from BeaconDetail.
7. beacon-detail.tsx: verificationCode now populated from API; improve copy to "compare with the code shown on the beacon" and mark it display-only.
8. topology.tsx: Approve dialog -> approve by beacon ID (call POST /api/beacons/trust/:id/approve), remove approvalToken input/state, update dialog copy.

### Beacon backend

9. coordinator-trust.ts: add `beaconVerificationCode` state + `setBeaconVerificationCode()` / `getBeaconVerificationCode()`.
10. coordinator-client.ts registerBeacon(): after computing verificationCode, call setBeaconVerificationCode(code); remove approvalToken handling from return/logging.
11. routes/coordinator-trust.ts: GET returns { fingerprintTrusted, beaconApproved, pendingFingerprint, verificationCode }; POST accepts { verificationCode }, compares to stored code, on match calls confirmCoordinatorFingerprint (promote pending -> trusted).
12. routes/agents.ts: POST /agents coordinatorTrust now includes { fingerprintTrusted, beaconApproved, verificationCode, pendingFingerprint }.
13. index.ts: remove approval-token log/reminder paths (lines ~251-277); the beacon's verification code is surfaced via coordinator-trust; remove --approve references.

### Agent (swarm plugin)

14. tools-coordinator-trust.ts: `/trust-coordinator <code>` -> POST /coordinator/trust with { verificationCode }; update surfacePendingCoordinatorTrust to show BOTH halves (fingerprint pending AND beacon not approved) + the beacon's verification code to transcribe into the web UI.
15. index.ts: on register, if coordinatorTrust present, surface verificationCode + both gate halves.

### Docs

16. Update docs/agents/swarm-plugin.md (both-sides flow, /trust-coordinator <code>, --approve-beacon).
17. Add ADR decision (decision 120) + update wiki concept beacon-verification.md + decisions index.

## Tests to update

- drone-coordinator/test/db.test.ts (lines ~316, 340, 425, 431): approvalToken assertions -> verificationCode + approveBeaconById.
- drone-coordinator/test/routes/beacons.test.ts (lines ~254-293): replace /beacons/approve token tests with /beacons/trust/:id/approve by-ID tests.
- drone-beacon/test/coordinator-trust.test.ts: add verification-code setter/getter tests.
- drone-beacon/test/routes.test.ts: /coordinator/trust now returns verificationCode + beaconApproved; POST accepts verificationCode.
- drone-beacon/test/coordinator-client.test.ts: registerBeacon no longer returns approvalToken; stores verification code.
- drone-agent/test/swarm-coordinator-trust.test.ts: /trust-coordinator now posts verificationCode; surfacePending shows both halves.
- Add UI tests for topology approve-by-ID + beacon-detail code display.

## Validation criteria

- LSP passes (typescript, yaml, json) for all changed files.
- `pnpm -r run build` passes (drone-core first, then dependents; drone-coordinator-ui build too).
- `pnpm -r run lint` passes.
- `pnpm -r run test` passes (fast suite).
- No remaining references to approvalToken / approval_token / --approve / /beacons/approve / approveBeacon(token) anywhere (grep).
- Web UI shows verification code on beacon detail; topology Approve approves by ID.
- Agent surfaces both gate halves + its verification code; /trust-coordinator <code> compares and confirms fingerprint on match.
- Dead code removed; no stale comments.
