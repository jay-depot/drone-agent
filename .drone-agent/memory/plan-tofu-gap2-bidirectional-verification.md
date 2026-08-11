---
key: plan-tofu-gap2-bidirectional-verification
tags:
  - plan
  - tofu
  - gap2
  - coordinator
  - verification
  - swarm
created: 2026-08-11T17:36:27.533Z
updated: 2026-08-11T17:36:27.533Z
---

# Sub-plan 2 — Gap 2: Bidirectional verification code

Part of master plan `plan-tofu-coordinator-gaps` (PR #48, branch copilot/fix-codeql-issue-26).

## Goal
Make the verification code prove BOTH identities, not just the beacon's. Currently sha256(beaconPubKey + beaconTlsFp) only proves the beacon's identity to the coordinator's operator.

## Design decision
Extend generateVerificationCode to three inputs: generateVerificationCode(beaconPubKey, beaconTlsFp, coordinatorTlsFp). The coordinator knows its own fingerprint (it has the cert); the beacon knows it via TOFU pinning (observed during the registration request's TLS handshake). The coordinator-side confirmation already exists (web UI approve flow displays the verification code); this makes that code meaningful in both directions.

## Steps
1. Extend generateVerificationCode in drone-swarm-common/src/verification.ts to accept the 3rd coordinatorTlsFingerprint param (make required; update doc comment). NOTE: could be optional for backward-compat if desired
2. Coordinator: drone-coordinator/src/db/beacon-trust.ts registerBeaconTrust needs the coordinator fp (module-level setter or pass-through from route); compute generateVerificationCode(req.publicKey, req.tlsFingerprint ?? '', coordinatorFp)
3. Beacon: drone-beacon/src/coordinator-client.ts registerBeacon() needs the observed coordinator fp (the onFirstFingerprint callback fires during the registration request's TLS handshake, before the response); make it available in-memory; compute generateVerificationCode(identity.publicKey, tlsFingerprint, coordinatorFp)
4. Tests: 3-input generateVerificationCode (both sides identical given same inputs; different coordinator fp -> different code)

## Validation criteria
- LSP passes for all touched files (typescript LSP connected)
- pnpm -r run build passes zero errors
- pnpm -r run lint passes zero errors (prettier reformats; re-read files before further edits)
- pnpm -r run test (fast suite) passes
- All new code covered by unit tests
- No dead code, unused vars, fluff comments
- Files stay under 750 lines (split if >1000)

## Key files
- drone-swarm-common/src/verification.ts
- drone-coordinator/src/db/beacon-trust.ts
- drone-beacon/src/coordinator-client.ts
- Tests: drone-swarm-common/test/, drone-coordinator/test/routes/beacons.test.ts, drone-beacon/test/coordinator-client.test.ts