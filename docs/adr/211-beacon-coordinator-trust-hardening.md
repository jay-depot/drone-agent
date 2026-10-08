---
tags:
  [decision, trust, coordinator, beacon, mtls, approval, security, hardening]
related:
  [
    concepts/mtls-and-reverse-channel.md,
    concepts/beacon-verification.md,
    modules/drone-coordinator.md,
    modules/drone-beacon.md,
    modules/drone-coordinator-ui.md,
    decisions/117-tofu-fingerprint-pinning.md,
    decisions/118-tofu-interactive-confirmation.md,
    decisions/120-bidirectional-verification-ux.md,
    decisions/122-tofu-fingerprint-pin-socket-secureconnect.md,
    decisions/123-rate-limit-mtls-ws-reverse-channel.md,
    decisions/212-coordinator-config-pipeline.md,
  ]
---

# 211: Beacon↔coordinator trust hardening — announce-gated approval + server-side enforcement

**Status**: Implemented (2026-09-11) · **Branch**: `feat/coordinator-config-ui-and-secure-storage` (`bf3a7ef`) · **Plan**: project-memory `plan-coordinator-trust-hardening` (Plan A) — _deleted from project memory after ingest_

**Summary**: Three defects in the beacon↔coordinator trust path were found by reading the code rather than the docs: (1) server-side approval status gated almost nothing — mTLS and the reverse-channel WebSocket both accepted any certificate whose fingerprint was already in `beacon_trust`, so a _pending_ (unapproved) beacon could pull coordinator data; (2) localhost auto-approve keyed locality off the **body-claimed** `host` field, not the socket, so a remote attacker claiming `host: "localhost"` with a self-signed cert auto-approved; (3) the coordinator UI let an operator approve a beacon that had never confirmed the coordinator's own fingerprint, so the human handshake was advisory. The fix makes approval **announce-gated** (a signed `confirm-fingerprint` POST must land first), derives locality from the **socket**, and **enforces `status='approved'` server-side** on both mTLS and the reverse-channel WS.

## Context

The trust model is TOFU-based and bidirectional: the beacon pins the coordinator's TLS fingerprint ([decisions/122-tofu-fingerprint-pin-socket-secureconnect]], [decisions/117-tofu-fingerprint-pinning]]), and the coordinator approves the beacon. The verification code ties them together ([concepts/beacon-verification]]).

Four findings from a pre-implementation code review reshaped the request:

1. **The verification code was already bidirectional** (`drone-swarm-common/src/verification.ts`) — a 4-word code derived from `sha256(beaconPublicKey ∥ beaconTlsFingerprint ∥ coordinatorTlsFingerprint)`. It proves _channel integrity_, not _machine ownership_: a rogue beacon registering directly produces a matching code too. No reciprocal back-channel code was needed — the real defense is the human recognizing the machine.
2. **Approval status gated almost nothing server-side.** `mtls.ts` and `beacon-ws.ts` accepted any cert whose fingerprint was in `beacon_trust`, regardless of `status`. A pending beacon's cert is already in the table (that is how it registers), so it could already pull coordinator data. Only the _beacon's own_ client-side `coordinatorTrusted()` gate stopped it — a client-side gate cannot stop a hostile client.
3. **Localhost auto-approve was spoofable.** `db/beacon-trust.ts` keyed locality off the **body-claimed** `req.host === 'localhost' || '127.0.0.1'`, never the socket. A remote attacker claiming `host: "localhost"` with a self-signed cert auto-approved.
4. **The UI allowed a premature approve.** The Approve button did not require that the beacon had confirmed the coordinator's fingerprint, so an operator could approve before the human handshake completed.

## Decision

Four coupled changes, all required together:

1. **Announce-gated approve.** The beacon fires a **signed** `confirm-fingerprint` POST (Ed25519 signature over `beaconId:timestamp` via `signBeaconPayload`, ±60s skew window) the moment `/trust-coordinator <code>` matches. The coordinator persists `fingerprint_confirmed_at` on `beacon_trust`; the beacon's existing 30s approval poll carries `fingerprintConfirmed`; the coordinator API returns **409** and the UI disables Approve until it is set.
2. **"Do not approve unexpected beacons" warning.** A prominent, always-visible UI warning naming the beacon id/name/host and its verification code, plus a step-by-step CTA on the beacon detail page (1. run `/trust-coordinator <code>` on the beacon, 2. return here). This is the _real_ rogue-beacon defense — recognize the machine, not just the code.
3. **Socket-derived locality.** New `drone-coordinator/src/ip.ts` `isLoopbackIp(ip)` (handles `::ffff:` mapped IPv4 and the whole `127/8` range) replaces the body-claimed host for auto-approve. The body host is kept for **display and connect-back only**. Localhost remains auto-approved — that behavior is intentional.
4. **Server-side status enforcement.** The mTLS middleware and the reverse-channel WS require `status='approved'` (403 / WS close 4002 otherwise). Open-while-pending exemptions are exactly: `GET /health`, `POST /api/beacons`, `GET /api/beacons/trust/:id`, and `POST /api/beacons/trust/:id/confirm-fingerprint`. Closing a pending WS is safe because the beacon reconnects with exponential backoff after approval.

## Implementation

- `drone-coordinator/src/db/init.ts` — idempotent `beacon_trust.fingerprint_confirmed_at INTEGER` migration (column-presence checked before `ALTER TABLE`).
- `drone-coordinator/src/types.ts` — `BeaconTrust.fingerprintConfirmedAt`, `BeaconTrustRow` + mapping, and `fingerprintConfirmed?: boolean` on the registration/response shapes.
- `drone-coordinator/src/db/beacon-trust.ts` — register/approve/`confirmBeaconFingerprint`, exported via `db/index.ts`.
- `drone-coordinator/src/ip.ts` — new `isLoopbackIp()`.
- `drone-coordinator/src/routes/beacons.ts` — passes `socketIsLocal` from `request.ip` for `POST /beacons` and `/beacons/trust`; `GET /api/beacons/trust/:id` returns `fingerprintConfirmed`; `approveBeaconById` gates on `'pending'` AND `fingerprint_confirmed_at IS NOT NULL` (409 with "Beacon has not confirmed the coordinator fingerprint yet. Run /trust-coordinator <code> on the beacon first.").
- `drone-coordinator/src/mtls.ts` — requires `status='approved'` (403 otherwise) with the four pending exemptions above.
- `drone-coordinator/src/beacon-ws.ts` — extracted exported `resolveBeaconWsAdmission(beaconId)` → close **4002** for non-approved.
- `drone-swarm-common/src/verification.ts` — gained `verifyBeaconSignature()` + `signBeaconPayload()` (**one-shot** Ed25519; see gotcha 1).
- `drone-beacon/src/coordinator-client.ts` — `confirmFingerprint()` (signed `beaconId:timestamp` POST); `registerBeacon` body now sends `fingerprintConfirmed: isCoordinatorTrusted()`.
- `drone-beacon/src/routes/coordinator-trust.ts` — `POST /coordinator/trust` fires `confirmFingerprint()` after a code match (fire-and-forget).
- `drone-coordinator-ui/` — `types.ts` `Beacon.fingerprintConfirmed`; `topology.tsx` amber warning banner + Approve disabled w/ tooltip until announced + fingerprint state row; `beacon-detail.tsx` banner, fp badge (confirmed/awaiting), and the step CTA; `trust.test.tsx` (5 tests).

## Key gotchas (recorded for future planners)

1. **Node ed25519 requires the one-shot crypto API.** The streaming `crypto.createSign('ed25519')` / `createVerify('ed25519')` APIs **throw "Invalid digest" at runtime** even though `@types/node@24` compiles them cleanly. Runtime requires `crypto.sign(null, Buffer.from(data), privateKey)` / `crypto.verify(null, Buffer.from(data), publicKey, signature)` with a `null` algorithm (derived from the key type). Typecheck and build both pass over the broken form — only the test harness catches it.
2. **`app.inject()` defaults `remoteAddress` to `'127.0.0.1'`.** After the socket-locality fix, every test-injected beacon auto-approves. Pass `remoteAddress: '10.0.0.1'` to simulate a remote beacon (asserting pending/409).
3. **The beacon's `cfetch` writes request bodies via `req.write(data)`**, not the options object, so tests must capture the written body to assert the payload shape.

## Consequences

- A **pending beacon can no longer read coordinator data**, even with a valid pinned certificate — the gate is server-side, not client-side, so a hostile client cannot bypass it by skipping its own checks.
- The self-approve-by-claiming-localhost spoof is closed: locality is a socket fact.
- Approval now requires the full human handshake on both sides, which is what made [212-coordinator-config-pipeline](212-coordinator-config-pipeline.md) (pushing real API keys through the coordinator) safe to build next.
- Unattended swarms would be locked out by design, which is why [177-reverse-channel-session-end-trigger](177-reverse-channel-session-end-trigger.md) added the paired `autoApproveBeacons` + `BEACON_AUTO_CONFIRM_COORDINATOR_FINGERPRINT` opt-ins.

## Validation

LSP clean; typecheck/build/lint exit 0; fast suite 2905 pass / 14 skip; coordinator+beacon 788 pass; UI changed-file tests pass. Test additions: coordinator `db.test.ts` (96), `mtls.test.ts` (14), `beacon-ws.test.ts` (13), `routes/beacons.test.ts` (35, incl. `remoteAddress: '10.0.0.1'`), beacon `coordinator-client.test.ts` (37, incl. body capture), `routes.test.ts` (99), UI `trust.test.tsx` + `topology.test.tsx`.

**Pending (handed to the user)**: a live manual smoke run — register → poll → announce → approve → WS against a real beacon/coordinator pair.

## Related

- mtls-and-reverse-channel — the trust transport this hardens
- beacon-verification — the verification code the announce is bound to
- [212-coordinator-config-pipeline](212-coordinator-config-pipeline.md) — the next plan, unblocked by this one
- [118-tofu-interactive-confirmation](118-tofu-interactive-confirmation.md) · [120-bidirectional-verification-ux](120-bidirectional-verification-ux.md) — the human handshake this makes mandatory
- [177-reverse-channel-session-end-trigger](177-reverse-channel-session-end-trigger.md) — the unattended-swarm opt-ins that bypass the handshake deliberately
