---
key: plan-coordinator-trust-hardening
tags:
  - plan
  - trust
  - coordinator
  - beacon
  - mtls
  - approval
  - security
  - ready
created: 2026-09-11T01:41:33.900Z
updated: 2026-09-11T01:41:33.900Z
---

# PLAN A — Beacon↔Coordinator Trust Hardening (announce-gated approval + server-side enforcement)

Status: READY FOR EXECUTION. Branch: feat/coordinator-config-ui-and-secure-storage. Prerequisite for Plan B (plan-coordinator-config-ui-and-secret-handling) which pushes LLM API keys down the chain.

## Feature summary

Harden the beacon↔coordinator trust path: (a) coordinator does NOT allow approving a beacon until the beacon has confirmed the coordinator's TLS fingerprint via the /trust-coordinator human handshake (announce-gated approve); (b) coordinator UI shows a persistent "don't approve unexpected beacons" warning + the announce state, gating the Approve button; (c) localhost auto-approve derives locality from the SOCKET, not the body-claimed host (closes the self-approve-by-claiming-localhost spoof); (d) approval status is enforced server-side (mTLS + reverse-channel WS) so a pending beacon cannot read coordinator data. Verified facts: verification code is ALREADY bidirectional (sha256(pubkey||beaconTlsFp||coordTlsFp), drone-swarm-common/src/verification.ts:288-309) — no change to the code; approval status currently gates almost nothing (mtls.ts + beacon-ws.ts accept any cert in beacon_trust).

## Why / security context

Before Plan B pushes real provider API keys down coordinator→beacon→agent, a pending or spoofed beacon must not be able to pull coordinator data. Today a pending beacon's cert is in beacon_trust at registration, so mTLS/WS accept it; and `isLocal = req.host === 'localhost' || '127.0.0.1'` (db/beacon-trust.ts:108) trusts a body claim → remote attacker POST host:"localhost" auto-approves. Q4 (user-locked): localhost stays auto-approved (same host = no MITM channel) — the socket-locality fix is exactly what makes that safe.

## Steps (executor: code persona; atomic + testable)

### A1 — Schema: fingerprint_confirmed_at on beacon_trust

- drone-coordinator/src/db/init.ts: idempotent migration (pattern = verification_code one, ~L239-246): `ALTER TABLE beacon_trust ADD COLUMN fingerprint_confirmed_at INTEGER`.
- drone-coordinator/src/types.ts BeaconTrust: add `fingerprintConfirmedAt: number | null`.
- drone-coordinator/src/db/beacon-trust.ts: BeaconTrustRow + rowToBeaconTrust + registerBeaconTrust (INSERT cols + re-registration UPDATE) — persist the column.

### A2 — Locality from socket, not claim

- drone-coordinator/src/routes/beacons.ts POST /beacons: compute `socketIsLocal` from request socket (req.ip ∈ {127.0.0.1, ::1, ::ffff:127.0.0.1}) and pass into registerBeaconTrust. Same for POST /beacons/trust (trust-only registration: also socket-derived, default non-local).
- drone-coordinator/src/db/beacon-trust.ts registerBeaconTrust(req, { socketIsLocal }): `isLocal = socketIsLocal` (REPLACES req.host claim). Keep req.host for display/connect-back only.
- Add `isLoopbackIp(ip)` helper (handle IPv4-mapped ::ffff:); place in drone-coordinator/src/mtls.ts export or new src/ip.ts.
- Include a regression test: POST /beacons with host:"localhost" from a NON-loopback socket → status 'pending' (not auto-approved).

### A3 — Beacon announces fingerprint confirmation (signed)

- drone-beacon/identity.ts: add `signBeaconPayload(identity, payload): string` (node:crypto createSigner ed25519 using identity.privateKeyPem).
- drone-swarm-common/src/verification.ts (or drone-coordinator/src): `verifyBeaconSignature(publicKeyB64, payload, sig): boolean` (createVerifier, spki).
- drone-beacon/coordinator-client.ts: `confirmFingerprint(): Promise<void>` — POST `${baseUrl}/api/beacons/trust/${beaconId}/confirm-fingerprint` body `{ beaconId, timestamp, signature }` (sign `beaconId + ':' + timestamp`) via cfetch. Also add `fingerprintConfirmed: isCoordinatorTrusted()` to registerBeacon body (re-announce on restart).
- drone-beacon/routes/coordinator-trust.ts POST /coordinator/trust: after confirmCoordinatorFingerprint(fp) succeeds → fire getCoordinatorClient()?.confirmFingerprint() (fire-and-forget, .catch log).
- drone-coordinator/routes/beacons.ts NEW POST /api/beacons/trust/:id/confirm-fingerprint: body {beaconId,timestamp,signature}; verify beaconId matches :id; verify sig against beacon_trust.public_key; reject timestamp skew > ±60s; on success set fingerprint_confirmed_at=now (idempotent). 400 bad sig/skew, 404 unknown.
- drone-coordinator/types.ts RegisterBeaconRequest/RegisterBeaconTrustRequest: add optional `fingerprintConfirmed?: boolean`; registerBeaconTrust sets fingerprint_confirmed_at when true (both paths).

### A4 — Approve gated on confirmation

- drone-coordinator/src/db/beacon-trust.ts approveBeaconById: `UPDATE beacon_trust SET status='approved', approved_at=?, updated_at=? WHERE beacon_id=? AND status='pending' AND fingerprint_confirmed_at IS NOT NULL` → null when no flip.
- drone-coordinator/routes/beacons.ts POST /api/beacons/trust/:id/approve: when null, fetch row; 404 if missing; else 409 `{ error: 'Beacon has not confirmed the coordinator fingerprint yet. Run /trust-coordinator <code> on the beacon first.' }`.
- drone-coordinator/index.ts handleApproveBeacon (CLI --approve-beacon): same gate, print reason.

### A5 — Poll response surfaces fingerprintConfirmed

- drone-coordinator/routes/beacons.ts GET /api/beacons/trust/:id: include `fingerprintConfirmed: trust.fingerprintConfirmedAt !== null`.
- drone-coordinator/types.ts BeaconStatusResponse: add `fingerprintConfirmed?: boolean`.

### A6 — Server-side status enforcement (mTLS + reverse-channel WS)

- drone-coordinator/src/mtls.ts createMtlsMiddleware: after resolving beaconId, require trust.status === 'approved' → else 403 `{ error: 'Unauthorized', message: 'Beacon is not yet approved' }`. Exemptions that stay OPEN while pending (check BEFORE status): /health; POST /api/beacons (registration, in-route verification); GET /api/beacons/trust/:id (poll); POST /api/beacons/trust/:id/confirm-fingerprint (announce). Everything else /api → approved-only.
- drone-coordinator/src/beacon-ws.ts registerBeaconWebSocket: after resolving beaconId, require approved → else socket.close(4002, 'Beacon not yet approved') and return (do NOT register connection). Beacon-side client reconnects w/ backoff (drone-beacon/src/coordinator-ws.ts) so channel establishes post-approval. Pending beacons show "Pending" (not connected) — matches UI amber.

### A7 — UI: announce state, gated approve, warning copy

- drone-coordinator-ui/src/lib/types.ts Beacon: add `fingerprintConfirmed?: boolean | null`.
- drone-coordinator-ui/src/pages/topology.tsx: Approve button rendered only when trustStatus==='pending'; DISABLED when !fingerprintConfirmed with title "The beacon must first run /trust-coordinator with the verification code". Persistent amber warning banner at top: "Do not approve beacons you did not start or do not expect. Verify the beacon's identity (name/id/host) and that the verification code matches the one shown on the beacon's side." Approve dialog keeps existing verification-code line.
- drone-coordinator-ui/src/pages/beacon-detail.tsx: when pending && !fingerprintConfirmed → step call-to-action "1. On the beacon's agent run /trust-coordinator <code>. 2. Approve here." + disable approve; same warning copy.
- Tests drone-coordinator-ui/src/pages/trust.test.tsx: pending+unannounced → approve disabled/absent + warning visible; pending+announced → enabled → POST approve; announced renders.

### A8 — Agent/beacon copy

- drone-agent/src/plugins/swarm/tools-coordinator-trust.ts: success message adds "Return to the coordinator web UI — Approve is now enabled for this beacon."
- drone-beacon/src/index.ts pending reminder: add note when fingerprintTrusted ("the beacon has confirmed the coordinator fingerprint").

### A9 — Tests (beacon + coordinator)

- drone-coordinator/test/: beacon-trust (confirmed→approve ok; unconfirmed→approve null; socket-local auto-approves, claimed-localhost remote→pending; re-register w/ fingerprintConfirmed sets column); routes (confirm-fingerprint happy/400/404; approve 409; GET trust carries fingerprintConfirmed); mtls (pending 403 on /api/personas, open on poll+announce; approved ok); beacon-ws (pending close 4002; approved registers).
- drone-beacon/test/: confirmFingerprint signs+posts; registration body includes fingerprintConfirmed; POST /coordinator/trust match → confirmFingerprint fired.

### A10 — Validation (FINAL STEP — must all pass)

- LSP: zero NEW errors vs baseline (pre-existing `getUsageLedger` mock errors in drone-agent/test/{anthropic,compaction,conversation-service-events}.test.ts are ADR 208 leftovers — do NOT touch; assert zero delta).
- `pnpm -r run lint`, `pnpm -r run typecheck`, `pnpm -r run build` — zero errors. If running lint, prettier reformats → re-read files before further edits.
- `pnpm -r run test` (fast suite) + `cd drone-coordinator-ui && pnpm test` (NODE_ENV=test) pass.
- Manual smoke: beacon pending (WS closed) → /trust-coordinator match → announce → UI ready-to-approve → approve → WS connects + sync flows. Regression: non-loopback register host:"localhost" stays pending.

## Validation criteria (Plan A)

- All A9 tests pass. LSP delta-zero. lint/typecheck/build zero errors. Fast + UI suites pass. Spoof regression holds. Bootstrap non-deadlock (register→poll→announce→approve→WS).
