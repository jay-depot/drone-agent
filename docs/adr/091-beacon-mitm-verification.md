---
tags: [decision, security, beacon, verification]
related: [concepts/beacon-verification.md, modules/drone-beacon.md, modules/drone-coordinator.md, modules/drone-swarm-common.md, modules/drone-coordinator-ui.md]
---

# ADR 091: Beacon MitM Verification Code

**Status**: Implemented (commit `2577162`)

## Problem

When a beacon connects to the coordinator for the first time, the key exchange happens over a network connection that could be subject to a man-in-the-middle (MitM) attack. The coordinator stores the beacon's public key and TLS fingerprint, but there was no way for the admin to verify that these values weren't tampered with during transmission.

## Solution

Add a human-readable verification code that both sides independently compute from the same shared inputs (public key + TLS fingerprint). The admin compares the two codes to verify no MitM occurred.

### Verification Code Generation

Added `generateVerificationCode()` in `drone-swarm-common/src/verification.ts`:

- Takes two string inputs (public key and TLS fingerprint)
- Computes SHA-256 hash of the concatenated inputs
- Takes the first 4 bytes of the hash, each byte encodes an index into a 256-word list
- Returns a 4-word code (e.g., `"acorn-badge-cabin-daisy"`)
- The word list (256 words) is chosen for distinctiveness — no words that look or sound alike
- Each word is 4-6 characters, making the output easy to read and type

### How It Works

1. **Beacon side**: When registering with the coordinator, the beacon computes the verification code locally from its own public key and TLS fingerprint. It displays the code in its logs.

2. **Coordinator side**: When the beacon registers, the coordinator also computes the verification code from the same inputs (the public key and TLS fingerprint it received). It stores the code in the `beacon_trust` table and returns it in `GET /beacons/:id` responses.

3. **Admin verification**: The admin compares the code shown on the beacon with the code shown in the coordinator web UI (beacon detail page). If they match, no MitM occurred. If they differ, the key exchange was tampered with.

### UI Display

The beacon detail page (`/beacons/:id`) shows the verification code prominently with a note: "Compare this code with the one shown on the beacon to verify no MitM attack occurred during key exchange."

## Files Changed

- `drone-swarm-common/src/verification.ts` — New file with `generateVerificationCode()` and 256-word list
- `drone-swarm-common/src/index.ts` — Exported `generateVerificationCode`
- `drone-coordinator/src/db/beacon-trust.ts` — Stores verification code in beacon_trust table
- `drone-coordinator/src/types.ts` — Added `verificationCode` to `BeaconTrust` and `BeaconStatusResponse`
- `drone-beacon/src/coordinator-client.ts` — Computes and returns verification code during registration
- `drone-beacon/src/index.ts` — Displays verification code in logs with MitM warning
- `drone-coordinator-ui/src/pages/beacon-detail.tsx` — Displays verification code in UI
- `drone-coordinator-ui/src/lib/types.ts` — Added `verificationCode` to `BeaconDetail`

## Validation

- LSP clean
- `pnpm -r run build` passes
- `pnpm -r run lint` passes
- `pnpm -r run test` passes
