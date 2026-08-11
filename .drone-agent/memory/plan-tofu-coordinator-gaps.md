---
key: plan-tofu-coordinator-gaps
tags:
  - plan
  - tofu
  - coordinator
  - tls
  - swarm
  - codeql
created: 2026-08-11T17:33:43.498Z
updated: 2026-08-11T17:36:15.790Z
---

# Master Plan: Filling gaps in PR #48 (TOFU coordinator TLS)

Branch: copilot/fix-codeql-issue-26. PR #48 addressed CodeQL issue #47 (disabling cert validation) by adding TOFU fingerprint pinning for coordinator TLS (buildCheckServerIdentity, coordinator-tls-fingerprint.txt, CodeQL suppression). Copilot identified 3 remaining gaps. This is a MASTER plan with 4 sub-plans (3 primary + 1 bonus), each independently executable.

## Core design principle: two-sided approval gate
Swarm comms start only after BOTH sides accept. Either side can approve first.
- Coordinator approves beacon: existing web UI flow (approve/reject + verification code)
- Beacon approves coordinator: NEW fingerprint confirmation (Gap 1)

## Sub-plan 1 — Gap 1: Interactive TOFU confirmation (SSH-style)
Goal: close unguarded first-connection window. Beacon must not trust coordinator until user confirms observed fingerprint matches coordinator's reported fingerprint.
Decisions:
- Coordinator surfaces fingerprint via BOTH CLI command (--show-fingerprint) AND API endpoint
- Beacon holds coordinator connection in "pending fingerprint approval" state; keeps serving agents locally, doesn't trust coordinator for sync until confirmed
- Confirmation: (a) beacon CLI command (primary), (c) agent slash command backed by beacon endpoint (human-only), (b) optional TTY prompt (bonus, low priority)
- Agent surfaces pending-fingerprint message on connect

Steps:
1. Coordinator CLI --show-fingerprint (drone-coordinator/src/index.ts, mirror handleShowWebToken; update command union + --help)
2. Coordinator API: module-level setCoordinatorFingerprint(fp) setter (setTlsLogger pattern) in routes/health.ts; call from main() when HTTPS; extend GET /health to return {status, timestamp, tlsFingerprint?}
3. Beacon two-phase fingerprint state (drone-beacon/src/index.ts): first connection writes PENDING file (coordinator-tls-fingerprint.pending.txt) not trusted file; trusted file written only on confirmation; track coordinatorFingerprintConfirmed
4. Beacon holds coordinator trust until confirmed: gate all sync/trust ops (personas/skills/knowledge/session/event push) behind coordinatorFingerprintConfirmed; still registers with coordinator + polls for approval
5. Beacon CLI --confirm-coordinator-fingerprint <fp> (parseArgs; verify pending matches, promote pending->trusted, exit; mirror drone-coordinator --approve; update --help)
6. Beacon confirmation endpoint for agent path (e.g. POST /api/coordinator/trust with fp or token) that promotes pending->trusted. NOTE: decide fingerprint-based vs token-based when executing (token-based more robust against compromised agent relaying wrong fp)
7. Beacon surfaces pending status to agents (extend POST /agents response or status endpoint)
8. Agent (drone-agent/src/plugins/swarm/): on connect, if beacon reports pending coordinator fingerprint, surface prominent message; register slash command /trust-coordinator calling beacon endpoint; HUMAN-ONLY, no auto-confirm
9. Both-sides gate: swarm comms start only after coordinatorFingerprintConfirmed AND pollForApproval()==='approved'
10. Tests: coordinator --show-fingerprint + /health fp; beacon pending->confirmed transitions; CLI confirm; agent slash command; both-sides gate

## Sub-plan 2 — Gap 2: Bidirectional verification code
Goal: verification code proves BOTH identities, not just beacon's.
Decision: extend generateVerificationCode to 3 inputs: generateVerificationCode(beaconPubKey, beaconTlsFp, coordinatorTlsFp). Coordinator knows own fp (has cert); beacon knows it via TOFU pinning (observed during registration request TLS handshake).
Steps:
1. Extend generateVerificationCode in drone-swarm-common/src/verification.ts to accept 3rd coordinatorTlsFingerprint param (make required; update doc comment). NOTE: could be optional for backward-compat if desired
2. Coordinator: drone-coordinator/src/db/beacon-trust.ts registerBeaconTrust needs coordinator fp (module-level setter or pass-through from route); compute generateVerificationCode(req.publicKey, req.tlsFingerprint ?? '', coordinatorFp)
3. Beacon: drone-beacon/src/coordinator-client.ts registerBeacon() needs observed coordinator fp (onFirstFingerprint fires during registration request TLS handshake, before response); make available in-memory; compute generateVerificationCode(identity.publicKey, tlsFingerprint, coordinatorFp)
4. Tests: 3-input generateVerificationCode (both sides identical given same inputs; different coordinator fp -> different code)

## Sub-plan 3 — Gap 3: Coordinator cert rotation documentation
Goal: document cert-rotation workflow so fingerprint mismatch after regen is resolvable.
Steps:
1. Add section to docs/agents/swarm-plugin.md (or new doc): how to regenerate coordinator cert, that it changes coordinator fingerprint, that beacon's pinned fingerprint will mismatch, resolution steps (confirm new fp on beacon side, re-verify bidirectional code), interaction with Gap 1 pending state.

## Sub-plan 4 — BONUS: Coordinator-pushed cert rotation notifications
Goal: protocol for the coordinator to proactively push certificate-rotation notifications out to beacons (so beacons learn of a rotation rather than only discovering a mismatch on next connection). MENTION ONLY in master plan for now — not yet scoped/designed. To be fleshed out when executed.

## Validation criteria (all sub-plans)
- LSP passes for all touched files (typescript LSP connected)
- pnpm -r run build passes zero errors
- pnpm -r run lint passes zero errors (prettier reformats; re-read files before further edits)
- pnpm -r run test (fast suite) passes
- All new code covered by unit tests
- No dead code, unused vars, fluff comments
- Files stay under 750 lines (split if >1000)

## Key files
- drone-beacon/src/coordinator-client.ts (buildCheckServerIdentity, createCoordinatorFetch, createCoordinatorClient, registerBeacon)
- drone-beacon/src/index.ts (parseArgs, main, coordinator client setup, pending state)
- drone-beacon/src/routes/health.ts, agents.ts, index.ts
- drone-coordinator/src/index.ts (parseArgs, main, buildApp, handleShowWebToken pattern)
- drone-coordinator/src/routes/health.ts, beacons.ts, index.ts
- drone-coordinator/src/db/beacon-trust.ts (registerBeaconTrust)
- drone-swarm-common/src/verification.ts (generateVerificationCode)
- drone-agent/src/plugins/swarm/index.ts, context.ts, tools-coordinator.ts
- docs/agents/swarm-plugin.md
- Tests: drone-beacon/test/coordinator-client.test.ts, drone-coordinator/test/routes/health.test.ts, beacons.test.ts, drone-swarm-common/test/