---
tags: [decision, security, verification, coordinator, beacon, ui, bug-fix]
related: [concepts/beacon-verification.md, modules/drone-beacon.md, modules/drone-coordinator.md, modules/drone-coordinator-ui.md, modules/drone-agent-plugins.md, decisions/120-bidirectional-verification-ux.md, decisions/119-bidirectional-verification-code.md, decisions/117-tofu-fingerprint-pinning.md]
---

# 121. Restore bidirectional verification-code UX (MITM protection)

**Summary**: The verification-code UX from [[decisions/120-bidirectional-verification-ux]] was shipped inverted — the agent surfaced the beacon's **own** code and pre-filled `/trust-coordinator <code>`, so the beacon compared the code against **itself** and always matched, silently defeating the MITM protection. Additionally, the coordinator only persisted `verification_code` on a beacon's first registration, so existing beacons never showed a code in the web UI. This fix restores the display-only / compare-only split and makes the code persist on re-registration.

## Context

[[decisions/120-bidirectional-verification-ux]] established the intended design: the coordinator web UI displays the verification code (display-only), and the user transcribes it into the agent's `/trust-coordinator <code>` so the beacon compares the transcribed code against its own in-memory copy (compare-only). Two bugs broke this:

1. **MITM protection inverted.** `surfacePendingCoordinatorTrust()` in the agent's swarm plugin printed the beacon's own verification code and pre-filled it into the suggested `/trust-coordinator <code>` command. If the user followed the suggestion, the beacon compared the code to its own stored value — which always matches — so a real comparison against the web UI's code never happened. The protection effectively didn't exist.

2. **Code never appeared for existing beacons.** `registerBeaconTrust()` in the coordinator only computed and persisted `verification_code` on a beacon's **first-ever** registration. The re-registration path (which runs on every beacon/coordinator restart) only `UPDATE`d `host`, `port`, `tls_fingerprint` — never `verification_code`. So any `beacon_trust` row created before the column existed, or re-registered since, kept a `NULL`/empty code, and the web UI's `{beacon.verificationCode && ...}` guard rendered nothing.

## Decision

Restore the security property and fix persistence, following the display-only / compare-only principle:

- **Agent (Option A):** remove the code from the agent's surfaced `[SECURITY]` warning. The agent surfaces both gate halves but never prints or pre-fills the code; it directs the user to read the 4-word code from the coordinator web UI and run `/trust-coordinator <code>` with that exact value. The beacon (compare-only side) must never display its own copy.
- **Beacon:** remove the stdout `Verification code:` log and the `[REMINDER] ... Verification code:` lines. The code now appears in exactly **one** place: the coordinator web UI. The beacon still holds its copy in memory (`setBeaconVerificationCode`) for the compare-only `/coordinator/trust` endpoint.
- **Coordinator:** recompute and persist `verification_code` in the `registerBeaconTrust()` **re-registration** branch, so existing/re-registered beacons populate the code on their next restart.
- **Coordinator web UI (Option 2):** surface the code **inline in the topology approve dialog** (not just on the beacon detail page), and fix the stale dialog copy that referenced "the code shown on the beacon." Add `verificationCode` to the `GET /beacons` list response and the UI `Beacon` type so the dialog can render it.

## Consequences

- The MITM protection works again: the only way to complete the handshake is to read the code from the web UI and transcribe it, so a MitM (whose fingerprint would produce a different code) is caught on the beacon side.
- The code is no longer leaked into agent warnings or beacon stdout — it lives in a single place (the web UI), making the display-only / compare-only split airtight.
- Existing beacons now get their code populated on re-registration, so the web UI (detail page and approve dialog) shows it.
- The topology approve dialog shows the code right where the operator clicks **Approve**, so the operator compares it there without navigating to the detail page.

## Tests

- Coordinator db: re-registration test now asserts the recomputed code is returned **and** persisted (`getBeaconTrust(...).verificationCode`).
- Coordinator routes: `GET /beacons` list entries carry a truthy `verificationCode`.
- Coordinator UI: topology approve-dialog test mocks a `verificationCode` in the list and asserts the dialog displays it inline.
- Agent: "surfaces pending gate halves" test captures the warning and asserts it references the web UI but does **not** contain the code value or a pre-filled `/trust-coordinator <word>`.

## Implementation

- **Files**: `drone-coordinator/src/db/beacon-trust.ts`, `drone-coordinator/src/routes/beacons.ts`, `drone-coordinator-ui/src/lib/types.ts`, `drone-coordinator-ui/src/pages/topology.tsx`, `drone-agent/src/plugins/swarm/tools-coordinator-trust.ts`, `drone-beacon/src/index.ts`, `docs/agents/swarm-plugin.md`, plus tests
- **Validation**: LSP clean, `pnpm -r run build`, `pnpm lint:eslint`, and the fast suite (1832 passed / 9 skipped) all pass; grep confirms no code value/pre-fill in the agent warning or beacon stdout

## Related

- [[concepts/beacon-verification]] — The MitM verification code concept
- [[decisions/120-bidirectional-verification-ux]] — The design this fix corrects
- [[decisions/119-bidirectional-verification-code]] — The 3-input bidirectional code
- [[decisions/117-tofu-fingerprint-pinning]] — Provides the coordinator fingerprint
- [[modules/drone-beacon]] — Beacon holds the compare-only in-memory copy
- [[modules/drone-coordinator]] — Coordinator persists/serves the display-only copy
- [[modules/drone-coordinator-ui]] — Web UI shows the code in detail page + approve dialog
- [[modules/drone-agent-plugins]] — `/trust-coordinator <code>` command (no pre-fill)
