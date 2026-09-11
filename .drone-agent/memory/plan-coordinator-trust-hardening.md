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
  - completed
created: 2026-09-11T01:41:33.900Z
updated: 2026-09-11T02:44:07.447Z
---

# PLAN A — Beacon↔Coordinator Trust Hardening (announce-gated approval + server-side enforcement)

Status: ✅ COMPLETED (executed 2026-09-11, commit bf3a7ef on feat/coordinator-config-ui-and-secure-storage). All A1–A10 steps done; validation green (LSP clean, typecheck/build/lint exit 0, fast suite 2905 pass / 14 skip, coordinator+beacon 788 pass, UI changed-file tests pass).

## Feature summary

Hardened the beacon↔coordinator trust path: (a) coordinator does NOT allow approving a beacon until the beacon has confirmed the coordinator's TLS fingerprint via the /trust-coordinator human handshake (announce-gated approve); (b) coordinator UI shows a persistent "don't approve unexpected beacons" warning + the announce state, gating the Approve button; (c) localhost auto-approve derives locality from the SOCKET, not the body-claimed host (closes the self-approve-by-claiming-localhost spoof); (d) approval status is enforced server-side (mTLS + reverse-channel WS) so a pending beacon cannot read coordinator data. Verification code was already bidirectional — no change to it.

## What shipped (per step)

- A1: beacon_trust.fingerprint_confirmed_at INTEGER (idempotent migration, init.ts), BeaconTrust.fingerprintConfirmedAt (types.ts), BeaconTrustRow/mapping/register/approve/confirmBeaconFingerprint (db/beacon-trust.ts + db/index.ts export).
- A2: new src/ip.ts isLoopbackIp() (handles ::ffff: mapped + 127/8); routes/beacons.ts passes socketIsLocal from request.ip for POST /beacons and /beacons/trust — locality is socket-derived, body host is display-only.
- A3: drone-swarm-common verification.ts gained verifyBeaconSignature() + signBeaconPayload() (Ed25519 one-shot; see gotcha below); coordinator POST /api/beacons/trust/:id/confirm-fingerprint (beaconId match, ±60s skew, sig vs beacon_trust.public_key, idempotent set); beacon CoordinatorClient.confirmFingerprint() (signed beaconId:timestamp POST) + registerBeacon body fingerprintConfirmed:isCoordinatorTrusted(); beacon routes/coordinator-trust.ts POST /coordinator/trust fires confirmFingerprint() after a match (fire-and-forget).
- A4: approveBeaconById gates on 'pending' AND fingerprint_confirmed_at IS NOT NULL; route returns 409 "Beacon has not confirmed the coordinator fingerprint yet. Run /trust-coordinator <code> on the beacon first."; CLI handleApproveBeacon prints the same gate.
- A5: GET /api/beacons/trust/:id returns fingerprintConfirmed (feeds the beacon's 30s poll).
- A6: mtls.ts requires status='approved' (403 otherwise) with open-while-pending exemptions: /health, POST /api/beacons, GET /api/beacons/trust/:id, POST /api/beacons/trust/:id/confirm-fingerprint. beacon-ws.ts: extracted exported resolveBeaconWsAdmission(beaconId) → close 4002 for non-approved; beacon reconnects with backoff after approval.
- A7: UI types Beacon.fingerprintConfirmed; topology.tsx amber warning banner ("Do not approve beacons you did not start or do not expect..."), Approve disabled w/ tooltip until announced + "waits for /trust-coordinator", fingerprint state row; beacon-detail.tsx warning banner + fp badge (confirmed/awaiting) + step CTA (1. run /trust-coordinator <code> on the beacon 2. return here). trust.test.tsx 5 tests.
- A8: agent /trust-coordinator success message now says "Return to the coordinator web UI — Approve is now enabled for this beacon."; beacon pending-reminder logs whether the fingerprint is confirmed.
- A9: tests — coordinator db.test.ts (96), mtls.test.ts (14), beacon-ws.test.ts (13), routes/beacons.test.ts (35, incl. remoteAddress:'10.0.0.1' so inject() simulates remote); beacon coordinator-client.test.ts (37, confirmFingerprint signs+posts w/ body capture + registration body fingerprintConfirmed), routes.test.ts (99, /coordinator/trust match → confirmFingerprint fired). UI trust.test.tsx + topology.test.tsx.
- A10: validation all green.

## KEY GOTCHAS (log for future plans)

1. **Node 25.8.1 ed25519**: the streaming `crypto.createSign('ed25519')`/`createVerify('ed25519')` APIs THROW "Invalid digest" at runtime even though @types/node@24 compiles them. Runtime requires the one-shot `crypto.sign(null, Buffer.from(data), privateKey)` / `crypto.verify(null, Buffer.from(data), publicKey, signature)` with `null` algorithm (derived from key type). Caught by the test harness, not by typecheck/build.
2. **light-my-request app.inject() defaults remoteAddress to '127.0.0.1'** (loopback). After A2's socket-locality fix, any test-injected beacon registers auto-approved. Pass `remoteAddress: '10.0.0.1'` to simulate a remote beacon (asserting pending/409).
3. **cfetch writes request bodies via req.write(data)**, not the options object — tests must capture the written body to assert payload shape.

## Out of scope / follow-ups

- Manual smoke runbook (live register→poll→announce→approve→WS) still worth running against a real beacon/coordinator pair before release — requires live services, not run in this session.
- Plan B (plan-coordinator-config-ui-and-secret-handling) is the next plan — NOW safe to push secrets because pending beacons are blocked server-side for real.
- The `sessions.test.tsx` "refetch on lifecycle event" test flaked once in a full UI-suite run but passes in isolation and was NOT touched by this plan — pre-existing timing flake, not a regression.
