---
key: plan-tofu-gap3-cert-rotation-docs
tags:
  - plan
  - tofu
  - gap3
  - coordinator
  - tls
  - docs
created: 2026-08-11T17:36:27.533Z
updated: 2026-08-11T18:09:01.788Z
---

# Sub-plan 3 — Gap 3: Coordinator cert rotation documentation

Part of master plan `plan-tofu-coordinator-gaps` (PR #48, branch copilot/fix-codeql-issue-26).

## Goal
Document the cert-rotation workflow so a fingerprint mismatch after coordinator cert regen is resolvable. Currently the only resolution is `rm coordinator-tls-fingerprint.txt`, which is undocumented.

## Steps
1. Add a section to docs/agents/swarm-plugin.md (or a new doc) covering:
   - How to regenerate the coordinator cert (drone-swarm-common/src/tls.ts loadOrCreateTlsIdentity; deleting coordinator-cert.pem/coordinator-key.pem triggers regen)
   - That regeneration changes the coordinator's fingerprint
   - That the beacon's pinned fingerprint will then mismatch (buildCheckServerIdentity rejects)
   - Resolution steps: confirm the new fingerprint on the beacon side (Gap 1 confirmation flow), re-verify the bidirectional code (Gap 2)
   - Interaction with the Gap 1 pending-fingerprint state

## Validation criteria
- LSP passes for all touched files (typescript LSP connected)
- pnpm -r run build passes zero errors
- pnpm -r run lint passes zero errors (prettier reformats; re-read files before further edits)
- pnpm -r run test (fast suite) passes
- No dead code, unused vars, fluff comments

## Key files
- docs/agents/swarm-plugin.md
- Reference: drone-swarm-common/src/tls.ts, drone-beacon/src/coordinator-client.ts

---

## EXECUTION SUMMARY (2026-08-11)

All steps implemented and validated. Build, lint, and full test suite pass (1831 passed, 9 skipped). Docs-only change (no TS files touched).

### What was built
- **docs/agents/swarm-plugin.md** — added a "Coordinator TLS trust and certificate rotation" section covering:
  - How the coordinator's fingerprint is reported (`--show-fingerprint` CLI + `GET /health` tlsFingerprint)
  - The first-connection confirmation flow (CLI `--confirm-coordinator-fingerprint` + agent `/trust-coordinator`), and the both-sides gate
  - The full cert-rotation workflow: stop coordinator, delete `coordinator-cert.pem`/`coordinator-key.pem` (default `~/.drone-coordinator/`), restart (new fingerprint generated), the beacon's pinned fingerprint now mismatches (buildCheckServerIdentity rejects — expected), re-confirm the new fingerprint on the beacon side, and re-verify the bidirectional code (Gap 2)
  - A note that the beacon's pinned fingerprint lives in `coordinator-tls-fingerprint.txt` (default `~/.drone-beacon/`) and that the confirmation flow is the supported path (manual deletion only for a fresh TOFU handshake)

### Notes / decisions
- Documented the coordinator cert files as `coordinator-cert.pem`/`coordinator-key.pem` in `~/.drone-coordinator/` (matching `loadOrCreateTlsIdentity(configDir, 'coordinator')`).
- Documented the beacon's pinned fingerprint file as `coordinator-tls-fingerprint.txt` in `~/.drone-beacon/`.
- Emphasized that the confirmation flow (not manual file deletion) is the supported resolution path, and that the bidirectional code must be re-verified after rotation.
