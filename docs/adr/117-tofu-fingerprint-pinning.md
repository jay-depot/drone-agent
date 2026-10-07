---
tags: [decision, security, tls, tofu, coordinator]
related: [concepts/beacon-verification.md, modules/drone-beacon.md, modules/drone-coordinator.md, modules/drone-swarm-common.md, decisions/091-beacon-mitm-verification.md, decisions/118-tofu-interactive-confirmation.md, decisions/119-bidirectional-verification-code.md, decisions/122-tofu-fingerprint-pin-socket-secureconnect.md]
---

# 117. TOFU fingerprint pinning for coordinator TLS

**Summary**: Added Trust-On-First-Use (TOFU) certificate fingerprint pinning to the beacon's coordinator HTTPS connections, closing the gap where the coordinator's certificate was never verified after the initial connection.

> **CORRECTED by [122-tofu-fingerprint-pin-socket-secureconnect](122-tofu-fingerprint-pin-socket-secureconnect.md)**: The `checkServerIdentity` mechanism described here was **dead code** — Node never calls `checkServerIdentity` when `rejectUnauthorized` is `false`, so `onFirstFingerprint` never fired. This decision is retained for historical context; the working implementation observes/enforces the fingerprint from the socket `secureConnect` event (ADR 122).

## Context

CodeQL flagged `rejectUnauthorized: false` in `drone-beacon/src/coordinator-client.ts`. The complaint is technically correct — CA validation is skipped — but the context matters: both sides use self-signed certs, so CA validation is inapplicable. The real gap was that the coordinator's certificate was **never verified at all** after the initial connection, leaving all post-registration traffic open to MITM.

## Decision

Wire a `checkServerIdentity` override into every HTTPS request to the coordinator that pins the coordinator's certificate SHA-256 fingerprint.

### `buildCheckServerIdentity`

Added `buildCheckServerIdentity(expectedFingerprint, onFirstFingerprint)` in `drone-beacon/src/coordinator-client.ts`:

- When `expectedFingerprint` is provided, it verifies the server's `cert.fingerprint256` (normalized to lowercase, colons stripped) against it, returning an `Error` on mismatch (possible MITM).
- When no fingerprint is known yet (first connection), it calls `onFirstFingerprint` with the observed fingerprint and accepts the connection — the intentional TOFU window.

### `createCoordinatorFetch` extended

`createCoordinatorFetch(baseUrl, expectedCoordinatorFingerprint?, onFirstFingerprint?)` now sets `checkServerIdentity` on HTTPS requests alongside `rejectUnauthorized: false`. CodeQL suppression comments (`// lgtm[js/disabling-certificate-verification]`) explain that MITM protection is provided by the fingerprint check, not CA chains.

### `CoordinatorClientOptions` extended

Added `coordinatorTlsFingerprint?` and `onFirstCoordinatorFingerprint?` so callers can supply/persist the pinned value.

## Consequences

- All post-registration HTTPS traffic to the coordinator is now verified against a pinned fingerprint.
- The TOFU first-connection window is unguarded (addressed by [118-tofu-interactive-confirmation](118-tofu-interactive-confirmation.md)).
- Coordinator cert rotation causes a fingerprint mismatch (documented in `docs/agents/swarm-plugin.md`).

## Tests

- 4 new unit tests for `buildCheckServerIdentity`: TOFU first-use callback, matching fingerprint acceptance, mismatch rejection, missing fingerprint error.

## Implementation

- **Commits**: `58bda53` (TOFU pinning + CodeQL suppression), plus the gap-1/gap-2/gap-3 commits that build on it
- **Files**: `drone-beacon/src/coordinator-client.ts`, `drone-beacon/src/index.ts`, `drone-beacon/test/coordinator-client.test.ts`
- **Validation**: build, lint, and test suite pass

## Related

- beacon-verification — The MitM verification code concept
- [drone-beacon](../../drone-beacon/) — Beacon module (hosts the coordinator client)
- [091-beacon-mitm-verification](091-beacon-mitm-verification.md) — Original MitM verification code ADR
- [118-tofu-interactive-confirmation](118-tofu-interactive-confirmation.md) — Closes the unguarded TOFU window
- [119-bidirectional-verification-code](119-bidirectional-verification-code.md) — Makes the verification code bidirectional
- [122-tofu-fingerprint-pin-socket-secureconnect](122-tofu-fingerprint-pin-socket-secureconnect.md) — Corrects the dead `checkServerIdentity` mechanism
