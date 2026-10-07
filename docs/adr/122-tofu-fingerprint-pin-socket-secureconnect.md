---
tags: [decision, security, tls, tofu, coordinator, beacon, bug-fix]
related: [concepts/beacon-verification.md, modules/drone-beacon.md, modules/drone-coordinator.md, modules/drone-swarm-common.md, decisions/117-tofu-fingerprint-pinning.md, decisions/118-tofu-interactive-confirmation.md, decisions/119-bidirectional-verification-code.md, decisions/121-verification-code-ux-fix.md]
---

# 122. Fix beacon TOFU coordinator fingerprint pin via socket `secureConnect`

**Summary**: The TOFU fingerprint pinning from [[decisions/117-tofu-fingerprint-pinning]] was **dead code** — Node never calls `checkServerIdentity` when `rejectUnauthorized: false`, so the beacon never observed/pinned the coordinator's TLS fingerprint. The bidirectional verification code never matched between the beacon and coordinator (the beacon hashed with an *empty* coordinator fingerprint while the coordinator used its real one). This fix observes and enforces the fingerprint from the socket's `secureConnect` event instead, restoring the pin and converging the codes.

## Context

[[decisions/117-tofu-fingerprint-pinning]] wired TOFU observation/enforcement through a `checkServerIdentity` override (`buildCheckServerIdentity`) on every HTTPS request to the coordinator, alongside `rejectUnauthorized: false` (self-signed cert compat). But there is a Node TLS trap: when `rejectUnauthorized` is `false`, Node **skips server-identity verification entirely**, so `checkServerIdentity` — and thus `onFirstFingerprint` — is **never invoked**. The beacon therefore computed `generateVerificationCode(pubkey, beaconTlsFp, '')` with an empty coordinator fingerprint, while the coordinator computed the same code with its real fingerprint. The two 4-word codes never matched, so the bidirectional handshake (see [[decisions/119-bidirectional-verification-code]]) could never complete.

**Live data proof (before fix):**
- Beacon in-memory code (`GET /coordinator/trust`): `raven-hound-vixen-savor` (empty fingerprint input)
- Coordinator code (web UI, computed with `/health` tlsFingerprint `56a1f0...1bfd`): `yanks-yearn-robin-quest`
- No `coordinator-tls-fingerprint.pending.txt` ever written; no TOFU log line — confirming `onFirstFingerprint` never fired.

## Decision

Keep `rejectUnauthorized: false` (required for self-signed certs) but stop relying on `checkServerIdentity` for TOFU observation/enforcement. Instead, in `createCoordinatorFetch()`, when HTTPS, attach a `req.on('socket')` → `socket.on('secureConnect')` handler that reads `(socket as TLSSocket).getPeerCertificate().fingerprint256`, normalizes it (strip colons, lowercase), then:

- if `expectedCoordinatorFingerprint` is set: verify the match; call `req.destroy(err)` on mismatch (rejects the Promise → `registerBeacon` throws). The user approved a **hard-fail on mismatch** — rotating the coordinator cert requires a beacon restart, which is acceptable.
- else: call `onFirstFingerprint(observed)` (TOFU pin on first contact).

`checkServerIdentity` is still passed (harmless, may help other paths) but is no longer the enforcement mechanism.

## Consequences

- The TOFU pin works again: the beacon now observes the coordinator's fingerprint on first connection (writing `coordinator-tls-fingerprint.pending.txt`) and enforces the pinned value on every subsequent connection.
- The bidirectional verification code converges — both sides hash the same three inputs, so the two 4-word codes match.
- A real coordinator certificate mismatch (MitM or cert rotation) now fails hard with a `fingerprint mismatch` error instead of silently proceeding.
- The temporary debug echo that leaked the beacon's code in the `/coordinator/trust` mismatch error was removed.

## Tests

- New `makeHttpsRequestMock` helper in `drone-beacon/test/coordinator-client.test.ts` builds a fake socket that can emit `secureConnect` with a fake peer cert.
- 2 new tests: (1) TOFU observation via socket `secureConnect` — asserts `onFirstFingerprint` receives the normalized value; (2) mismatch destroys the request with a `/fingerprint mismatch/` error.
- Existing `buildCheckServerIdentity` unit tests left intact (function still exported).

## Implementation

- **Commits**: `026aa8e` (debug echo + plan), `525316d` (the fix), `03f6da6` (plan marked complete + insight)
- **Files**: `drone-beacon/src/coordinator-client.ts` (socket `secureConnect` TOFU/pinning block; imported `TLSSocket` type), `drone-beacon/src/routes/coordinator-trust.ts` (removed debug echo), `drone-beacon/test/coordinator-client.test.ts` (`makeHttpsRequestMock` + 2 tests), plus the drone-beacon systemd unit (line-continuation backslash before `--https`; outside the repo, not in git)
- **Validation**: LSP clean, `pnpm -r run build`, `pnpm typecheck`, `pnpm test` (120 files / 1834 tests) all pass; drone-beacon is eslint-ignored. Runtime verified live: `createCoordinatorFetch('https://ambiorix:3456')` TOFU callback now fires with `56a1f0...1bfd`, matching the coordinator `/health` tlsFingerprint (`match: true`).

## Remediation (remaining manual ops — not performed by this plan run)

The code fix is committed, but the live beacon has NOT yet been restarted. To converge the codes on the running setup:
1. `systemctl --user restart drone-beacon` (dist rebuilt; re-pins coordinator fingerprint, writing `coordinator-tls-fingerprint.pending.txt`, and re-registers). Coordinator re-registration recomputes `verification_code` with its real fingerprint; the beacon public key is unchanged so the public-key-mismatch guard does not trip.
2. Confirm the pending fingerprint on the beacon (`--confirm-coordinator-fingerprint <fp>` or `/trust-coordinator <code>`).
3. Approve the beacon by ID on the coordinator.
4. Verify both sides now show the SAME 4-word code and `/coordinator/trust` shows `fingerprintTrusted=true` with both gate halves satisfied.

## Key insight for future work

`rejectUnauthorized: false` + `checkServerIdentity` is a trap: Node never calls `checkServerIdentity` when `rejectUnauthorized` is false, so any pinning/observation wired through `checkServerIdentity` is dead code. Use the socket `secureConnect` event + `getPeerCertificate()` for TLS peer observation when `rejectUnauthorized` is disabled. (Recorded as an insight.)

## Related

- [[concepts/beacon-verification]] — The MitM verification code concept
- [[decisions/117-tofu-fingerprint-pinning]] — The flawed TOFU mechanism this corrects (dead `checkServerIdentity` path)
- [[decisions/118-tofu-interactive-confirmation]] — The interactive confirmation flow that depends on the observed fingerprint
- [[decisions/119-bidirectional-verification-code]] — The bidirectional code that needs both real fingerprints
- [[decisions/121-verification-code-ux-fix]] — The UX split this fix makes function end-to-end
- [[modules/drone-beacon]] — Beacon module (hosts the coordinator client)
