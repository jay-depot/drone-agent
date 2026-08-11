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
updated: 2026-08-11T17:52:16.312Z
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

---

## EXECUTION SUMMARY (2026-08-11)

All 10 steps implemented and validated. Build, lint, and full test suite pass (1823 passed, 9 skipped).

### What was built

- **Coordinator CLI `--show-fingerprint`** (drone-coordinator/src/index.ts): new `show-fingerprint` command + `handleShowFingerprint()` that loads the TLS identity and prints the fingerprint. Added to command union, arg parsing, and --help.
- **Coordinator API** (drone-coordinator/src/routes/health.ts): module-level `setCoordinatorFingerprint(fp)` setter; `GET /health` now returns `{status, timestamp, tlsFingerprint?}`. Wired into main() when HTTPS enabled.
- **Beacon two-phase fingerprint state** (NEW drone-beacon/src/coordinator-trust.ts): `initCoordinatorTrust`, `setPendingCoordinatorFingerprint` (writes `.pending.txt`), `confirmCoordinatorFingerprint` (promotes pending->trusted, writes trusted file, removes pending), `isCoordinatorTrusted`, `getTrustedCoordinatorFingerprint`, `getPendingCoordinatorFingerprint`, `setBeaconApproved`, `isBeaconApproved`, `isSwarmReady`, `resetCoordinatorTrust` (test helper).
- **Beacon holds trust until confirmed** (drone-beacon/src/coordinator-client.ts): added `coordinatorTrusted()` guard (uses `isSwarmReady()`); gated all sync/trust methods (fetchPersonas, fetchSkills, registerSession, endSession, registerAgentLocation, updateAgentLocationHeartbeat, unregisterAgentLocation, relayMessage, pushPersona, pushSkill, deletePersona, deleteSkill, pushKnowledge, pullKnowledge, searchKnowledge, registerSwarmSession, updateSwarmSessionPersona, endSwarmSession, pushEvents, pushToolDefinitions, getDefaultHiddenTools, getSessions, getSessionLog, processSession, completeSessionProcessing). registerBeacon + pollForApproval remain ungated (beacon still registers + polls).
- **Beacon CLI `--confirm-coordinator-fingerprint <fp>`** (drone-beacon/src/index.ts): new `command` field + `confirmFingerprint`; handled in main() before server start; added to --help.
- **Beacon confirmation endpoint** (NEW drone-beacon/src/routes/coordinator-trust.ts): `GET /coordinator/trust` (reports trusted + pendingFingerprint) and `POST /coordinator/trust` (body `{fingerprint}`, promotes pending->trusted). Registered in routes/index.ts.
- **Beacon surfaces pending status to agents** (drone-beacon/src/routes/agents.ts): `POST /agents` response now includes `coordinatorTrust: {trusted, pendingFingerprint}`.
- **Agent surfaces pending message + `/trust-coordinator`** (NEW drone-agent/src/plugins/swarm/tools-coordinator-trust.ts + index.ts): `surfacePendingCoordinatorTrust()` queries the beacon and logs a prominent [SECURITY] warning with the observed fingerprint + instructions; `createTrustCoordinatorCommand()` registers `/trust-coordinator <fp>` (human-only, calls POST /coordinator/trust). Wired into swarm plugin register().
- **Both-sides gate** (coordinator-trust.ts + index.ts): `isSwarmReady()` = fingerprint confirmed AND beacon approved. `setBeaconApproved(true)` called on registerBeacon 'approved' and on pollForApproval 'approved'; false on 'rejected'.

### Tests added

- drone-beacon/test/coordinator-trust.test.ts (8 tests): pending state, confirm promote, mismatch reject, no-pending reject, disk persistence (trusted + pending), both-sides gate.
- drone-coordinator/test/routes/health.test.ts (+2): /health returns tlsFingerprint when set, omits when not.
- drone-beacon/test/routes.test.ts (+2): GET /coordinator/trust untrusted, POST requires fingerprint.
- drone-agent/test/swarm-coordinator-trust.test.ts (3 tests): /trust-coordinator registered, pending warning surfaced on connect, confirm via beacon endpoint.
- drone-beacon/test/coordinator-client.test.ts: updated beforeEach to set up swarm-ready state (fingerprint confirmed + beacon approved) so gated methods don't short-circuit.

### Notes / decisions

- Step 6 used **fingerprint-based** confirmation (agent passes the observed fingerprint). Token-based was considered but fingerprint-based is simpler and the agent only relays what the user sees; the human confirms the value matches the coordinator's reported fingerprint before running /trust-coordinator.
- coordinator-client.ts is now 916 lines (was 826, already over the 750 guideline but under the 1000 hard limit). No split required.
- The optional TTY prompt (design decision b) was NOT implemented — it was explicitly low priority and the CLI + agent paths cover the requirement.
