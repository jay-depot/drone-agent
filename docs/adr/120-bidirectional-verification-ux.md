---
tags: [decision, security, verification, coordinator, beacon, ui]
related: [concepts/beacon-verification.md, modules/drone-beacon.md, modules/drone-coordinator.md, modules/drone-coordinator-ui.md, modules/drone-agent-plugins.md, decisions/117-tofu-fingerprint-pinning.md, decisions/118-tofu-interactive-confirmation.md, decisions/119-bidirectional-verification-code.md, decisions/121-verification-code-ux-fix.md]
---

# 120. Bidirectional verification-code UX + remove approval token

**Summary**: Surfaced the bidirectional verification code on **both** sides (web UI display-only, beacon compare-only), made the web UI approve beacons **by ID**, and removed the obsolete opaque `approvalToken` mechanism entirely.

## Context

The bidirectional verification code ([119-bidirectional-verification-code](119-bidirectional-verification-code.md)) was computed on both sides but **never surfaced or enforced**. The coordinator computed it in `registerBeaconTrust` but never persisted it (no `verification_code` column), so the web UI's beacon detail page never actually showed it. The beacon computed and logged its copy but never surfaced it to a connecting agent. Meanwhile the web UI's Approve flow still required the admin to paste an opaque `approvalToken` that was generated server-side and only ever shown to the beacon's operator — never to the coordinator admin, who actually needed it.

Separately, the agent only surfaced **one** of the two halves of the both-sides trust gate: the coordinator-fingerprint-confirmed half. The beacon-pending-approval half was invisible, so after `/trust-coordinator` succeeded the swarm silently stayed off until approval happened elsewhere.

## Decision

Make the verification code the UX centerpiece and remove the approval token:

### Web UI = display-only

- Persist the verification code: add a `verification_code` column to `beacon_trust` (idempotent migration) and return it from `GET /beacons/:id`.
- The beacon detail page now displays the coordinator's copy of the code with explicit "display-only, transcribe into the agent" copy.
- The topology Approve dialog approves the beacon **by ID** via `POST /beacons/trust/:id/approve` (no token entry), with a note to verify the code first.

### Beacon/agent = compare-only

- The beacon computes its verification code at registration and holds it **in memory** (`coordinator-trust` module).
- `/trust-coordinator <code>` transcribes the code shown in the coordinator web UI; the beacon's `POST /coordinator/trust` compares it against its in-memory copy. A match confirms the pending coordinator fingerprint (half A).
- The agent surfaces **both** gate halves (fingerprint confirmed, beacon approved) plus the beacon's verification code, so the user knows exactly what remains.

This design naturally forces the user to compare the two codes — one side displays, the other side compares — closing the "make the user verify they match" gap without any extra friction.

### Remove the approval token

- Drop `approval_token` column (migration), `POST /beacons/approve` route, `--approve <token>` CLI flag, and `approveBeacon(token)`.
- Add `approveBeaconById(id)`, `POST /beacons/trust/:id/approve`, and `--approve-beacon <id>` CLI command.

## Consequences

- The verification code is now meaningfully surfaced and enforced on both sides; the display-only / compare-only split forces a real comparison.
- Beacon approval is by ID, so the coordinator admin controls approval directly (there is no secret to find).
- The both-sides gate is fully visible to the agent, so users no longer wonder why sync is still off after confirming the fingerprint.

## Tests

- Coordinator: db tests (`verificationCode` stored, `approveBeaconById`), route tests (`/beacons/trust/:id/approve`), CLI `--approve-beacon`.
- Beacon: coordinator-trust verification-code setter/getter, `/coordinator/trust` GET/POST shape, registerBeacon stores the code, `POST /agents` surfaces both halves + code.
- Agent: `/trust-coordinator` posts a verification code and surfaces both gate halves.
- UI: beacon-detail displays the code; topology approves by ID.

## Implementation

- **Files**: `drone-coordinator/src/db/init.ts`, `drone-coordinator/src/db/beacon-trust.ts`, `drone-coordinator/src/db/index.ts`, `drone-coordinator/src/routes/beacons.ts`, `drone-coordinator/src/index.ts`, `drone-coordinator/src/types.ts`, `drone-coordinator-ui/src/lib/types.ts`, `drone-coordinator-ui/src/pages/beacon-detail.tsx`, `drone-coordinator-ui/src/pages/topology.tsx`, `drone-beacon/src/coordinator-trust.ts`, `drone-beacon/src/coordinator-client.ts`, `drone-beacon/src/routes/coordinator-trust.ts`, `drone-beacon/src/routes/agents.ts`, `drone-beacon/src/index.ts`, `drone-agent/src/plugins/swarm/tools-coordinator-trust.ts`, `drone-agent/src/plugins/swarm/index.ts`, plus tests and docs
- **Validation**: build, lint, and test suite pass

## Related

- beacon-verification — The MitM verification code concept
- [drone-beacon](../../drone-beacon/) — Beacon holds the compare-only copy
- [drone-coordinator](../../drone-coordinator/) — Coordinator stores/serves the display-only copy
- [drone-coordinator-ui](../../drone-coordinator-ui/) — Web UI display-only + approve-by-ID
- [drone-agent-plugins](../../drone-agent/src/plugins/) — `/trust-coordinator <code>` command
- [117-tofu-fingerprint-pinning](117-tofu-fingerprint-pinning.md) — Provides the coordinator fingerprint
- [118-tofu-interactive-confirmation](118-tofu-interactive-confirmation.md) — The flow this strengthens
- [119-bidirectional-verification-code](119-bidirectional-verification-code.md) — The code this UX makes usable

## Follow-up correction

This decision shipped with two bugs that were later fixed in [121-verification-code-ux-fix](121-verification-code-ux-fix.md):

- The agent surfaced and pre-filled the beacon's **own** verification code (so the beacon compared it to itself and always matched — MITM protection inverted). The agent and beacon now **never display** the code; it appears only in the coordinator web UI.
- The coordinator only persisted `verification_code` on a beacon's **first** registration, so existing beacons showed no code. The re-registration path now recomputes and persists it.

The topology approve dialog now also shows the code inline (display-only) and its copy no longer references "the code shown on the beacon."
