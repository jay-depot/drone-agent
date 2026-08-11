---
key: plan-tofu-gap1-interactive-confirmation
tags:
  - plan
  - tofu
  - gap1
  - coordinator
  - tls
  - swarm
created: 2026-08-11T17:36:27.533Z
updated: 2026-08-11T17:36:27.533Z
---

# Sub-plan 1 — Gap 1: Interactive TOFU confirmation (SSH-style)

Part of master plan `plan-tofu-coordinator-gaps` (PR #48, branch copilot/fix-codeql-issue-26).

## Goal
Close the unguarded first-connection window. The beacon must not trust the coordinator until the user explicitly confirms the observed fingerprint matches the coordinator's reported fingerprint.

## Design decisions
- Coordinator surfaces its fingerprint via BOTH a CLI command (--show-fingerprint) AND an API endpoint
- Beacon holds the coordinator connection in a "pending fingerprint approval" state — keeps serving agents locally, but doesn't trust the coordinator for sync until confirmed
- Confirmation mechanisms: (a) beacon CLI command (primary), (c) agent slash command backed by a beacon endpoint (human-only), (b) optional TTY prompt (bonus, low priority)
- Agent surfaces the pending-fingerprint message when it connects to the beacon

## Steps
1. Coordinator CLI --show-fingerprint: add to drone-coordinator/src/index.ts (mirror handleShowWebToken; update command union + --help)
2. Coordinator API: module-level setCoordinatorFingerprint(fp) setter (setTlsLogger pattern) in routes/health.ts; call from main() when HTTPS; extend GET /health to return {status, timestamp, tlsFingerprint?}
3. Beacon two-phase fingerprint state (drone-beacon/src/index.ts): first connection writes PENDING file (coordinator-tls-fingerprint.pending.txt) not trusted file; trusted file written only on confirmation; track coordinatorFingerprintConfirmed
4. Beacon holds coordinator trust until confirmed: gate all sync/trust ops (personas/skills/knowledge/session/event push) behind coordinatorFingerprintConfirmed; still registers with coordinator + polls for approval
5. Beacon CLI --confirm-coordinator-fingerprint <fp> (parseArgs; verify pending matches, promote pending->trusted, exit; mirror drone-coordinator --approve; update --help)
6. Beacon confirmation endpoint for agent path (e.g. POST /api/coordinator/trust with fp or token) that promotes pending->trusted. DECISION NEEDED when executing: fingerprint-based vs token-based (token-based more robust against compromised agent relaying wrong fp)
7. Beacon surfaces pending status to agents (extend POST /agents response or status endpoint)
8. Agent (drone-agent/src/plugins/swarm/): on connect, if beacon reports pending coordinator fingerprint, surface prominent message; register slash command /trust-coordinator calling beacon endpoint; HUMAN-ONLY, no auto-confirm
9. Both-sides gate: swarm comms start only after coordinatorFingerprintConfirmed AND pollForApproval()==='approved'
10. Tests: coordinator --show-fingerprint + /health fp; beacon pending->confirmed transitions; CLI confirm; agent slash command; both-sides gate

## Validation criteria
- LSP passes for all touched files (typescript LSP connected)
- pnpm -r run build passes zero errors
- pnpm -r run lint passes zero errors (prettier reformats; re-read files before further edits)
- pnpm -r run test (fast suite) passes
- All new code covered by unit tests
- No dead code, unused vars, fluff comments
- Files stay under 750 lines (split if >1000)

## Key files
- drone-beacon/src/coordinator-client.ts, drone-beacon/src/index.ts
- drone-beacon/src/routes/health.ts, agents.ts, index.ts
- drone-coordinator/src/index.ts, drone-coordinator/src/routes/health.ts
- drone-agent/src/plugins/swarm/index.ts, context.ts
- Tests: drone-beacon/test/coordinator-client.test.ts, drone-coordinator/test/routes/health.test.ts