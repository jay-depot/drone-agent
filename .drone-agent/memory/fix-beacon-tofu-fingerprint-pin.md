---
key: fix-beacon-tofu-fingerprint-pin
tags:
  []
created: 2026-08-12T00:34:33.689Z
updated: 2026-08-12T00:41:13.043Z
---

# Plan: Fix beacon TOFU fingerprint pin so verification codes match coordinator

## Status: COMPLETED 2026-08-12 (commit 525316d on copilot/fix-codeql-issue-26)

## Summary

The bidirectional verification code never matched between the local beacon and the coordinator on the tailnet. Root cause was a dead TOFU pin on the beacon's HTTPS path, not a whitespace/key-format issue.

## Root cause (confirmed empirically 2026-08-11)

`drone-beacon/src/coordinator-client.ts` `createCoordinatorFetch()` sets `rejectUnauthorized: false` and installs `checkServerIdentity` to observe/pin the coordinator TLS fingerprint (TOFU). But when `rejectUnauthorized` is `false`, Node's TLS layer SKIPS server-identity verification entirely, so `checkServerIdentity` (and thus `onFirstFingerprint`) is NEVER called. Result: the beacon computed `generateVerificationCode(pubkey, beaconTlsFp, '')` with an EMPTY coordinator fingerprint, while the coordinator computed it with its real fingerprint.

Live data proof (before fix):
- Beacon in-memory code (GET /coordinator/trust): `raven-hound-vixen-savor` (empty fp input)
- Coordinator code (web UI, computed with /health tlsFingerprint `56a1f0...1bfd`): `yanks-yearn-robin-quest`
- No `coordinator-tls-fingerprint.pending.txt` ever written; no TOFU log line.

## Fix (implemented)

Keep `rejectUnauthorized: false` (self-signed cert compat) but stop relying on `checkServerIdentity` for TOFU observation/enforcement. Instead, in `createCoordinatorFetch()`, when HTTPS, attach a `req.on('socket')` → `socket.on('secureConnect')` handler that reads `(socket as TLSSocket).getPeerCertificate().fingerprint256`, normalizes it (strip colons, lowercase), then:
- if `expectedCoordinatorFingerprint` set: verify match; `req.destroy(err)` on mismatch (rejects the Promise → registerBeacon throws). User approved hard-fail on mismatch (rotating the coordinator cert requires restart; acceptable).
- else call `onFirstFingerprint(observed)` (TOFU pin).

`checkServerIdentity` is still passed (harmless, may help other paths) but is no longer the enforcement mechanism.

### Changes
- `drone-beacon/src/coordinator-client.ts`: added socket secureConnect TOFU/pinning block; imported `TLSSocket` type.
- `drone-beacon/src/routes/coordinator-trust.ts`: removed temporary debug echo that leaked the beacon's code in the /coordinator/trust mismatch error.
- `drone-beacon/test/coordinator-client.test.ts`: added `makeHttpsRequestMock` helper + 2 new tests (TOFU observation via socket secureConnect; mismatch destroys request with /fingerprint mismatch/ error). Existing `buildCheckServerIdentity` unit tests left intact.
- `~/.config/systemd/user/drone-beacon.service`: added missing line-continuation backslash before `--https` (previously silently dropped by systemd). NOT in git (outside repo).

## Validation (all passed)
- LSP clean (typescript) for all changed files.
- `pnpm -r run build` passed.
- `pnpm typecheck` passed (incl. `tsc -p tsconfig.test.json`).
- `pnpm -r run lint` — drone-beacon is eslint-ignored (`**/drone-beacon/**`); ran prettier --write on changed files (unchanged except test file formatting); eslint scoped showed only ignore warnings.
- `pnpm test` passed: 120 files / 1834 tests passed (incl. 2 new).
- Runtime verified live: `createCoordinatorFetch('https://ambiorix:3456')` TOFU callback now fires with `56a1f0...1bfd`, matching coordinator `/health` tlsFingerprint (`match: true`).

## Remediation (remaining manual ops — NOT performed by this plan run)
The code fix is done and committed, but the live beacon has NOT yet been restarted. To converge the codes on the running setup:
1. Deploy/restart beacon: `systemctl --user restart drone-beacon` (dist rebuilt; will re-pin coordinator fingerprint, writing `coordinator-tls-fingerprint.pending.txt`, and re-register). Coordinator re-registration recomputes verification_code with its real fingerprint; beacon public key unchanged so the public-key-mismatch guard does NOT trip.
2. Confirm the pending fingerprint on the beacon (`drone-beacon --confirm-coordinator-fingerprint <fp>` or `/trust-coordinator <code>`).
3. Approve the beacon by ID on the coordinator.
4. Verify both sides now show the SAME 4-word code and `/coordinator/trust` shows fingerprintTrusted=true with both gate halves satisfied.

## Key insight for future work
`rejectUnauthorized: false` + `checkServerIdentity` is a trap: Node never calls checkServerIdentity when rejectUnauthorized is false, so any pinning/observation wired through checkServerIdentity is dead code. Use the socket `secureConnect` event + `getPeerCertificate()` for TLS peer observation when rejectUnauthorized is disabled.
