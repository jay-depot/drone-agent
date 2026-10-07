---
tags: [decision, beacon, security, usability]
related: [modules/drone-beacon.md, modules/drone-coordinator.md, decisions/091-beacon-mitm-verification.md]
---

# ADR 092: Beacon Approval Token Re-output and Shortening

**Status**: Implemented (commits `0116fd5`, `6a5f74e`)

## Problem

Two usability issues with beacon approval:

1. **Token shown once and lost**: When a beacon starts in pending mode, the approval token is logged once. If the admin misses it (e.g., terminal scrollback is limited), there's no way to retrieve it without restarting the beacon.

2. **Token too long**: The original approval token was 16 characters, making it tedious to type manually in the coordinator web UI or CLI.

## Solution

### Token Re-output Every 60 Seconds

Added a `setInterval` in `drone-beacon/src/index.ts` that re-outputs the approval token and verification code every 60 seconds until the beacon is approved:

```
[REMINDER] Beacon still pending approval. Verification code: acorn-badge-cabin-daisy
Compare this code with the one shown in the coordinator web UI to verify no MitM attack occurred during key exchange.
[REMINDER] Beacon still pending approval. Token: AbCdEfGh
Approve via: drone-coordinator --approve <token> or the coordinator web UI
```

The interval is cleared when the beacon is approved or rejected.

### Shorter Approval Tokens

Reduced the approval token from 16 characters to 8 characters using a 56-character alphabet:

```
ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789
```

The alphabet excludes ambiguous characters:
- `0` (zero) and `O` (letter O) — visually similar
- `1` (one) and `l` (letter l) — visually similar
- `I` (letter I) — visually similar to `1` and `l`

8 characters from a 56-character alphabet provides ~2^46 possible tokens, which is sufficient for preventing brute-force guessing during the approval window.

## Files Changed

- `drone-beacon/src/index.ts` — Added `setInterval` for token re-output every 60s
- `drone-coordinator/src/db/beacon-trust.ts` — Changed `generateApprovalToken()` to use 8-char tokens with 56-char alphabet

## Validation

- LSP clean
- `pnpm -r run build` passes
- `pnpm -r run lint` passes
- `pnpm -r run test` passes
