---
key: fix-beacon-tofu-fingerprint-pin
tags:
  []
created: 2026-08-12T00:34:33.689Z
updated: 2026-08-12T00:36:07.789Z
---

# Plan: Fix beacon TOFU fingerprint pin so verification codes match coordinator

## Summary

The bidirectional verification code never matches between the local beacon and the coordinator on the tailnet. Root cause is a dead TOFU pin on the beacon's HTTPS path, not a whitespace/key-format issue.

## Root cause (confirmed empirically 2026-08-11)

`drone-beacon/src/coordinator-client.ts` `createCoordinatorFetch()` sets `rejectUnauthorized: false` and installs `checkServerIdentity` to observe/pin the coordinator TLS fingerprint (TOFU). But when `rejectUnauthorized` is `false`, Node's TLS layer SKIPS server-identity verification entirely, so `checkServerIdentity` (and thus `onFirstFingerprint`) is NEVER called. Result: the beacon computes `generateVerificationCode(pubkey, beaconTlsFp, '')` with an EMPTY coordinator fingerprint, while the coordinator computes it with its real fingerprint.

Live data proof:
- Beacon in-memory code (GET /coordinator/trust): `raven-hound-vixen-savor` (empty fp input)
- Coordinator code (web UI, computed with /health tlsFingerprint `56a1f0...1bfd`): `yanks-yearn-robin-quest`
- No `coordinator-tls-fingerprint.pending.txt` ever written; no TOFU log line.
- `tls.connect` test confirmed `checkServerIdentity` never fires; `cert.fingerprint256` is a valid 95-char string (cert itself fine).
- socket `secureConnect` + `socket.getPeerCertificate().fingerprint256` DOES return the fingerprint even with rejectUnauthorized:false — this is the fix mechanism.

## Fix approach (chosen by user: "clean option"; hard-fail on mismatch is fine)

Keep `rejectUnauthorized: false` (self-signed cert compat) but stop relying on `checkServerIdentity` for TOFU observation/enforcement. Instead, in `createCoordinatorFetch()`, when HTTPS, attach a `secureConnect` listener on the socket that reads `socket.getPeerCertificate().fingerprint256`, normalizes it (strip colons, lowercase), then:
- if `expectedCoordinatorFingerprint` set: verify match; destroy the request on mismatch (rejects the Promise → registerBeacon throws). User approved hard-fail on mismatch (rotating the coordinator cert requires restart; acceptable).
- else call `onFirstFingerprint(observed)` (TOFU pin).

Keep passing `checkServerIdentity` (harmless, may help other paths) but it is no longer the enforcement mechanism.

## Steps

### 1. Fix `createCoordinatorFetch` in `drone-beacon/src/coordinator-client.ts`
After creating the request, add:
```ts
const req = (isHttps ? https : http).request(options, res => { /* unchanged */ });

if (isHttps) {
  req.on('socket', socket => {
    socket.on('secureConnect', () => {
      const cert = socket.getPeerCertificate();
      const raw = cert?.fingerprint256;
      if (!raw) return;
      const observed = raw.replace(/:/g, '').toLowerCase();
      if (expectedCoordinatorFingerprint) {
        if (observed !== expectedCoordinatorFingerprint.toLowerCase()) {
          req.destroy(new Error(`TLS: coordinator certificate fingerprint mismatch — expected ${expectedCoordinatorFingerprint} but got ${observed}. Possible MITM attack.`));
        }
      } else {
        onFirstFingerprint?.(observed);
      }
    });
  });
}
```

### 2. Remove the temporary debug echo
`drone-beacon/src/routes/coordinator-trust.ts` — the mismatch error currently prepends `expected +` (leaks the beacon's code). Restore plain error message.

### 3. Tests
`drone-beacon/test/coordinator-client.test.ts`:
- New: HTTPS socket emits `secureConnect` with a fake cert fingerprint256 → assert `onFirstFingerprint` receives the normalized value (TOFU path).
- New: mismatched `expectedCoordinatorFingerprint` → assert the request errors with the mismatch message.
- Existing `buildCheckServerIdentity` unit tests remain valid (function still exported) — leave them.

### 4. Remediation (simplified — restart suffices, no stale-row deletion needed)
- Deploy fix, restart beacon: `systemctl --user restart drone-beacon` → re-pins coordinator fingerprint (writes `coordinator-tls-fingerprint.pending.txt`) and re-registers.
- Coordinator re-registration path already recomputes verification_code with its real fingerprint; beacon public key unchanged so the public-key-mismatch guard does NOT trip. Both sides converge on the same code.
- Then confirm the pending fingerprint (CLI `--confirm-coordinator-fingerprint <fp>` or `/trust-coordinator <code>`), then approve the beacon by ID on the coordinator.

### 5. Optional: fix systemd unit
`~/.config/systemd/user/drone-beacon.service` — the `--https` line lacks a trailing `\`, so systemd silently drops `--https` (beacon runs HTTP locally, harmless). Add the backslash. Not required for this bug.

## Validation criteria
- LSP passes (typescript) for changed files.
- `pnpm -r run build` passes.
- `pnpm -r run lint` passes.
- `pnpm -r run test` passes (fast suite), including new TOFU socket tests.
- No leftover `// Temporary debugging output` in coordinator-trust.ts.
- Live: after restart+confirm+approve, beacon and coordinator report the SAME 4-word code; `coordinator-tls-fingerprint.pending.txt` exists; `/coordinator/trust` shows fingerprintTrusted=true and both gate halves satisfied.
