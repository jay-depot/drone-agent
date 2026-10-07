---
tags: [decision, security, tls, tofu, coordinator, beacon]
related: [concepts/beacon-verification.md, modules/drone-beacon.md, modules/drone-coordinator.md, modules/drone-agent-plugins.md, decisions/117-tofu-fingerprint-pinning.md, decisions/119-bidirectional-verification-code.md]
---

# 118. Interactive TOFU confirmation for coordinator TLS

**Summary**: Closed the unguarded TOFU first-connection window with an SSH-style interactive confirmation flow. The beacon no longer trusts the coordinator until the user explicitly confirms the observed fingerprint matches the coordinator's reported fingerprint.

## Context

After [117-tofu-fingerprint-pinning](117-tofu-fingerprint-pinning.md), the beacon pinned the coordinator's TLS fingerprint on first connection but did not prompt the user to verify it — the TOFU window was unguarded. The beacon logged the observed fingerprint but trusted it immediately.

## Decision

Implement an SSH-style "authenticity of host" confirmation flow. The beacon holds the coordinator connection in a **pending fingerprint approval** state until the user confirms the observed fingerprint matches the coordinator's reported fingerprint.

### Coordinator surfaces its fingerprint

- **CLI**: new `--show-fingerprint` command on `drone-coordinator` prints the on-disk cert's fingerprint.
- **API**: `GET /health` now returns `tlsFingerprint` when HTTPS is enabled (via a new `setCoordinatorFingerprint()`/`getCoordinatorFingerprint()` pair in `routes/health.ts`).

### Beacon two-phase fingerprint state

New `drone-beacon/src/coordinator-trust.ts` module manages the state:

- `initCoordinatorTrust(dir)` — loads trusted/pending fingerprint files from disk.
- `setPendingCoordinatorFingerprint(fp)` — on first connection, writes the observed fingerprint to a **pending** file (`coordinator-tls-fingerprint.pending.txt`), not the trusted file.
- `confirmCoordinatorFingerprint(fp)` — promotes pending → trusted (writes `coordinator-tls-fingerprint.txt`, removes the pending file).
- `isCoordinatorTrusted()` / `getTrustedCoordinatorFingerprint()` / `getPendingCoordinatorFingerprint()` / `getObservedCoordinatorFingerprint()` — state accessors.
- `setBeaconApproved()` / `isBeaconApproved()` / `isSwarmReady()` — the both-sides gate.

### Beacon holds coordinator trust until confirmed

All coordinator sync/trust operations in `coordinator-client.ts` (fetchPersonas, fetchSkills, registerSession, endSession, agent location, relayMessage, push/delete persona/skill, knowledge push/pull/search, swarm session, events, tool definitions, sessions pipeline) are gated behind a `coordinatorTrusted()` guard. The beacon still registers with the coordinator and polls for approval, but does not exchange swarm data with an unverified coordinator.

### Confirmation paths

- **CLI (primary)**: `drone-beacon --confirm-coordinator-fingerprint <fp>` promotes pending → trusted.
- **Agent (human-only)**: the beacon surfaces the pending status to connecting agents (via the `POST /agents` response's `coordinatorTrust` field and a `GET /coordinator/trust` endpoint). Agents display a prominent `[SECURITY]` warning with the observed fingerprint. The user confirms via the `/trust-coordinator <fp>` slash command, backed by the beacon's `POST /coordinator/trust` endpoint. No auto-confirm.

### Both-sides gate

Swarm communications start only after **both** sides accept: the coordinator's TLS fingerprint is confirmed **and** the coordinator has approved the beacon (`pollForApproval() === 'approved'`). Either side can approve first.

## Consequences

- The unguarded TOFU window is closed — the beacon refuses to trust an unverified coordinator.
- The beacon keeps serving agents locally while the coordinator fingerprint is pending.
- Coordinator cert rotation now requires re-confirmation (documented in `docs/agents/swarm-plugin.md`).

## Tests

- 8 new `coordinator-trust` unit tests (pending state, confirm promote, mismatch reject, no-pending reject, disk persistence, both-sides gate).
- `/health` fingerprint tests, `/coordinator/trust` route tests, and swarm `/trust-coordinator` command tests.

## Implementation

- **Commits**: `bc41542` (gap 1), plus plan/chore commits
- **Files**: `drone-beacon/src/coordinator-trust.ts` (new), `drone-beacon/src/coordinator-client.ts`, `drone-beacon/src/index.ts`, `drone-beacon/src/routes/coordinator-trust.ts` (new), `drone-beacon/src/routes/agents.ts`, `drone-coordinator/src/index.ts`, `drone-coordinator/src/routes/health.ts`, `drone-agent/src/plugins/swarm/tools-coordinator-trust.ts` (new), `drone-agent/src/plugins/swarm/index.ts`
- **Validation**: build, lint, and test suite pass

## Related

- beacon-verification — The MitM verification code concept
- [drone-beacon](../../drone-beacon/) — Beacon module (hosts the trust state)
- [drone-coordinator](../../drone-coordinator/) — Coordinator module (surfaces its fingerprint)
- [drone-agent-plugins](../../drone-agent/src/plugins/) — Swarm plugin `/trust-coordinator` command
- [117-tofu-fingerprint-pinning](117-tofu-fingerprint-pinning.md) — The TOFU pinning this builds on
- [119-bidirectional-verification-code](119-bidirectional-verification-code.md) — Makes the verification code bidirectional
