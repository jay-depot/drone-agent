---
key: plan-bidirectional-coordinator-auth-ux
tags:
  []
created: 2026-08-11T22:37:22.386Z
updated: 2026-08-11T22:52:15.862Z
---

# Plan: Complete bidirectional coordinator-auth verification-code UX + remove approval token

## Status: COMPLETED (2026-08-11) — commit cc8a544

## Summary
The bidirectional verification code (decisions 117-119) was computed on both sides but never surfaced or enforced. The web UI's Approve flow depended on the obsolete opaque `approvalToken`; the agent only surfaced one half of the both-sides trust gate. This plan made the web UI display-only, the beacon/agent compare-only, and removed the approval-token mechanism entirely.

## Design (confirmed with user)
- Web UI = display-only: shows bidirectional verification code prominently; approves beacons by ID (no token)
- Beacon/agent = compare-only: `/trust-coordinator <code>` transcribes the code shown in the web UI; beacon compares against its in-memory computed code; a match confirms the coordinator fingerprint (half A)
- Agent surfaces BOTH gate halves: half A (fingerprint confirmed), half B (beacon awaiting coordinator approval) + its own verification code
- Remove approvalToken entirely: DB column, POST /beacons/approve, --approve, approveBeacon(token); add approve-by-ID route + --approve-beacon <id> CLI
- Beacon stores its computed verification code in memory at registration (coordinator-trust module)

## What was done
- Coordinator backend: added `verification_code` column to beacon_trust (idempotent migration), persisted it on registerBeaconTrust, returned from getBeaconTrust/listBeaconTrust. Dropped `approval_token` column (migration). Replaced `approveBeacon(token)` with `approveBeaconById(id)`.
- Coordinator routes: removed POST /beacons/approve; added POST /beacons/trust/:id/approve (approve by ID, publishMutationEvent).
- Coordinator CLI: removed --approve <token> + handleApprove; added --approve-beacon <id> + handleApproveBeacon; list-beacons no longer outputs token.
- Coordinator types.ts: removed approvalToken from BeaconTrust + BeaconStatusResponse; verificationCode now required on BeaconTrust.
- Coordinator UI: lib/types.ts removed approvalToken from BeaconDetail. beacon-detail.tsx now displays the verification code with "transcribe into the agent" copy. topology.tsx Approve dialog approves by ID (POST /api/beacons/trust/:id/approve), no token input.
- Beacon coordinator-trust.ts: added beaconVerificationCode state + setBeaconVerificationCode()/getBeaconVerificationCode().
- Beacon coordinator-client.ts registerBeacon(): stores the computed code via setBeaconVerificationCode; removed approvalToken from return type/logging.
- Beacon routes/coordinator-trust.ts: GET returns { fingerprintTrusted, beaconApproved, pendingFingerprint, verificationCode }; POST accepts { verificationCode }, compares to stored code, on match confirms pending fingerprint via confirmCoordinatorFingerprint.
- Beacon routes/agents.ts: POST /agents coordinatorTrust now { fingerprintTrusted, beaconApproved, pendingFingerprint, verificationCode }.
- Beacon index.ts: removed approval-token log/reminder paths; verification code now surfaces via coordinator-trust.
- Agent tools-coordinator-trust.ts: /trust-coordinator <code> posts { verificationCode }; surfacePendingCoordinatorTrust shows BOTH halves + the code to transcribe.
- Agent index.ts: surfaces trust warning when either fingerprintTrusted OR beaconApproved is false.
- Tests updated: coordinator db.test.ts + routes/beacons.test.ts (approve-by-ID, verificationCode); beacon coordinator-trust.test.ts (code setter/getter), routes.test.ts (GET/POST shape + agents coordinatorTrust), coordinator-client.test.ts (stores code); agent swarm-coordinator-trust.test.ts (/trust-coordinator posts code, surfaces both halves); new UI trust.test.tsx (beacon-detail code display, topology approve-by-ID).
- Docs: docs/agents/swarm-plugin.md (both-sides flow, /trust-coordinator <code>, --approve-beacon); ADR 120 (decisions/120-bidirectional-verification-ux.md); wiki concept beacon-verification.md + index.md.

## Validation
- LSP clean (typescript, yaml, json) for all changed files.
- `pnpm -r run build` passes (drone-core → dependents, incl. coordinator-ui).
- `pnpm lint` (eslint + prettier) passes.
- `pnpm test` passes (1832 passed, 9 skipped). UI tests pass separately.
- Grep confirms no remaining approvalToken / approval_token / /beacons/approve / approveBeacon(token) / --approve references except the migration that drops the column.

## Notes / gotchas
- The coordinator verificationCode was computed in registerBeaconTrust but NEVER persisted before this plan (no verification_code column) — the beacon-detail page's conditional block had literally never rendered. Persisting it was the critical first fix.
- The beacon's approval-token log/reminder path in index.ts referenced result.approvalToken which no longer exists; replaced with verification-code reminder.
- The old /trust-coordinator command wanted the raw 64-hex fingerprint which was never shown in the web UI; now it takes the 4-word verification code that the web UI displays.
