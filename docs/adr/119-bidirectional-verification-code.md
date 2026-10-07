---
tags: [decision, security, verification, coordinator, beacon]
related: [concepts/beacon-verification.md, modules/drone-beacon.md, modules/drone-coordinator.md, modules/drone-swarm-common.md, decisions/091-beacon-mitm-verification.md, decisions/117-tofu-fingerprint-pinning.md, decisions/118-tofu-interactive-confirmation.md]
---

# 119. Bidirectional verification code

**Summary**: Made the MitM verification code prove *both* identities — the beacon's and the coordinator's — by including the coordinator's TLS fingerprint as a third input to `generateVerificationCode`.

## Context

The original MitM verification code ([[decisions/091-beacon-mitm-verification]]) was `sha256(beaconPublicKey + beaconTlsFingerprint)`. It only proved the **beacon's** identity to the coordinator's operator — the coordinator's identity was not part of the code, so the beacon's operator could not independently verify they were talking to the right coordinator.

## Decision

Extend `generateVerificationCode` to three inputs: `generateVerificationCode(beaconPublicKey, beaconTlsFingerprint, coordinatorTlsFingerprint)`. The SHA-256 hash now includes all three, so the code is meaningful in both directions.

### Coordinator side

`registerBeaconTrust` in `drone-coordinator/src/db/beacon-trust.ts` now computes the code with its own fingerprint, via a new `getCoordinatorFingerprint()` getter in `routes/health.ts` (alongside the existing `setCoordinatorFingerprint()` setter):

```typescript
generateVerificationCode(req.publicKey, req.tlsFingerprint ?? '', getCoordinatorFingerprint() ?? '')
```

### Beacon side

`registerBeacon` in `drone-beacon/src/coordinator-client.ts` now computes the code with the observed coordinator fingerprint, via a new `getObservedCoordinatorFingerprint()` in `coordinator-trust.ts` (returns the trusted value if confirmed, else the pending value):

```typescript
generateVerificationCode(identity.publicKey, tlsFingerprint, getObservedCoordinatorFingerprint() ?? '')
```

## Consequences

- The verification code now proves both identities — the coordinator's operator verifies the beacon, and the beacon's operator verifies the coordinator.
- The coordinator-side confirmation (web UI approve flow displaying the code) is now meaningful in both directions.
- After a coordinator cert rotation, the code changes (because the coordinator fingerprint changed), so it must be re-verified.

## Tests

- 5 new `verification` unit tests (format, determinism, both-sides agreement, coordinator-fp sensitivity, beacon-fp sensitivity).
- Coordinator beacons route test, beacon `registerBeacon` test, and `coordinator-trust` observed-fp test.

## Implementation

- **Commits**: `c7c7e47` (gap 2), plus chore commits
- **Files**: `drone-swarm-common/src/verification.ts`, `drone-swarm-common/test/verification.test.ts` (new), `drone-coordinator/src/db/beacon-trust.ts`, `drone-coordinator/src/routes/health.ts`, `drone-beacon/src/coordinator-client.ts`, `drone-beacon/src/coordinator-trust.ts`
- **Validation**: build, lint, and test suite pass

## Related

- [[concepts/beacon-verification]] — The MitM verification code concept
- [[modules/drone-swarm-common]] — Hosts `generateVerificationCode`
- [[modules/drone-beacon]] — Beacon computes the code with the observed coordinator fingerprint
- [[modules/drone-coordinator]] — Coordinator computes the code with its own fingerprint
- [[decisions/091-beacon-mitm-verification]] — Original MitM verification code ADR
- [[decisions/117-tofu-fingerprint-pinning]] — Provides the coordinator fingerprint to the beacon
- [[decisions/118-tofu-interactive-confirmation]] — The confirmation flow this strengthens
