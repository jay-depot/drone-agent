## LLM provider config via swarm underlays

The beacon/coordinator config underlays are sanctioned channels for LLM
provider configuration. Valid underlay content includes:

- `providers` — full provider entries (protocol, baseUrl, `${VAR}`-templated
  apiKey, parameters, models). Entries merge by key with whole-entry
  replacement: any scope defining `providers.<id>` replaces that entire
  entry, so a swarm-distributed entry cannot be partially overridden by
  local config (define a different id instead).
- `llm.active` / `llm.reasoningLevel` — selection pins.

`${VAR}` interpolation runs receiver-side at layer parse time (each node
resolves against its own environment), so a swarm-distributed template like
`"apiKey": "${OPENROUTER_API_KEY}"` resolves per-agent. Plaintext keys in
underlays are allowed (swarm is a trusted channel); project-scope files may
NOT define `providers` at all — that combination fails startup validation.

# Swarm Plugin

The `swarm` plugin connects to a `drone-beacon` instance to provide swarm-wide personas, skills, and config injection. It is not enabled by default.

## Capabilities

- Registers persona and skill providers at both the beacon and coordinator precedence levels
- Provides a WebSocket-based messaging channel for inter-agent communication
- Registers HTTP storage engines for swarm-scoped insights and principles
- Registers wiki and coordinator tools using the list/mount pattern (3 meta-tools: `list_tools`, `mount_tool`, `unmount_tool`)
- Pushes conversation events to the coordinator

## Coordinator TLS trust and certificate rotation

When the beacon connects to the coordinator over HTTPS, it pins the coordinator's TLS certificate fingerprint (Trust-On-First-Use). On the first connection the observed fingerprint is recorded as _pending_; the beacon does not trust the coordinator for swarm sync until the user confirms the fingerprint matches the coordinator's reported fingerprint. See the interactive confirmation flow below.

### The both-sides trust gate

Swarm sync with the coordinator starts only after **both** sides accept:

1. **Coordinator fingerprint confirmed (half A)** — the beacon has confirmed the coordinator's TLS fingerprint via the verification code.
2. **Coordinator approved the beacon (half B)** — the coordinator's operator has approved the beacon (by ID) in the web UI or via `drone-coordinator --approve-beacon <id>`.

Either side can be satisfied first. Connecting agents surface **both** halves, so the user knows exactly which side is still outstanding. The verification code itself is displayed only in the coordinator web UI.

### The bidirectional verification code

Both the beacon and the coordinator independently compute a human-readable 4-word **verification code** from the beacon's public key, its TLS fingerprint, and the coordinator's TLS fingerprint. Comparing the two codes verifies that no MitM attack occurred during key exchange — it proves both identities:

- **Coordinator web UI (display-only):** the beacon detail page shows the coordinator's copy of the code. The coordinator's operator reads it and approves the beacon there (or via `--approve-beacon <id>`).
- **Beacon/agent (compare-only):** the user transcribes that code into the agent with `/trust-coordinator <code>`. The beacon compares the transcribed code against its own in-memory copy; a match confirms the coordinator fingerprint. A mismatch is rejected with a MitM warning.

Because one side is display-only and the other is compare-only, the user is naturally forced to compare the two codes to complete the handshake — there is no way to "skip" the comparison.

### Confirming the coordinator fingerprint (first connection)

On first connection the beacon writes the observed fingerprint to a pending file and holds coordinator trust. Confirm it with either:

- **CLI (primary):** `drone-beacon --confirm-coordinator-fingerprint <fp>` — promotes the pending fingerprint to trusted.
- **Agent (human-only):** connecting agents display a `[SECURITY]` warning with both gate halves and guidance to read the verification code from the coordinator's web UI. The agent and beacon **never display the code themselves** — open the coordinator web UI (beacon detail page), read its verification code, and run `/trust-coordinator <code>` in the agent with that exact value. The beacon compares the transcribed code against its own in-memory copy; a match confirms the fingerprint via its `POST /coordinator/trust` endpoint. No auto-confirm.

### Approving a pending beacon

A non-local beacon registers as `pending` in the coordinator. Approve it by **ID** (there is no approval token) with either:

- **Web UI:** on the beacon detail page or topology view, click **Approve**. The approve dialog shows the bidirectional verification code inline (it is display-only in the web UI, so this is the single source of truth). Verify it matches the code you entered on the beacon's agent with `/trust-coordinator` before approving.
- **CLI:** `drone-coordinator --approve-beacon <id>`.

### Rotating the coordinator's TLS certificate

The coordinator's self-signed certificate is stored as `coordinator-cert.pem` and `coordinator-key.pem` in its config directory (default `~/.drone-coordinator/`). It is generated on first startup by `loadOrCreateTlsIdentity` and reused on subsequent startups.

To rotate the certificate (e.g. after a reinstall, or to regenerate a compromised key):

1. **Stop the coordinator.**
2. **Delete the certificate files** so a fresh one is generated on next startup:
   ```sh
   rm ~/.drone-coordinator/coordinator-cert.pem ~/.drone-coordinator/coordinator-key.pem
   ```
3. **Restart the coordinator.** It generates a new self-signed certificate with a **new fingerprint** (logged at startup and available via `drone-coordinator --show-fingerprint` / `GET /health`).
4. **The beacon's pinned fingerprint now mismatches.** The beacon's `buildCheckServerIdentity` rejects the coordinator's new certificate, so swarm sync stops. This is expected — the beacon is refusing to trust a coordinator it hasn't re-verified.
5. **Re-confirm the new fingerprint on the beacon side.** The beacon records the new fingerprint as _pending_ on its next connection attempt. Confirm it (matching the coordinator's reported fingerprint) via the CLI or agent path above. This clears the mismatch and re-enables sync.
6. **Re-verify the bidirectional code.** Because the verification code now includes the coordinator's fingerprint, the code shown in the coordinator web UI will change. Re-enter the new code in the agent with `/trust-coordinator <code>` and re-confirm to ensure no MITM occurred during the rotation.

> **Note:** The beacon's pinned fingerprint lives in `coordinator-tls-fingerprint.txt` in the beacon's config directory (default `~/.drone-beacon/`). You generally do **not** need to delete it manually — the confirmation flow replaces it. If you want to force a fresh TOFU handshake from scratch, you can remove it (and the `.pending.txt` file) and restart the beacon, but the confirmation flow above is the supported path.

## Swarm prompt fragments

Beacons and the coordinator can inject **system prompt fragments** into running
drone-agent sessions. A fragment is a stored, addressed DB asset — not a
fire-and-forget push — so it survives agent reconnects and can be listed,
updated idempotently, and deleted.

### Asset model

A fragment row is `{ id, target, content, phase, scope, createdAt, updatedAt, expiresAt }`:

| Field       | Meaning                                                                                                                                         |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`        | Caller-chosen stable id (`^[a-zA-Z0-9:_-]+$`). Upserting the same `(id, target)` replaces content.                                              |
| `target`    | An `agentId` (a session id; unknown ids are accepted and queued) or the reserved sentinel `broadcast` (all sessions).                           |
| `content`   | Prompt text. Re-sent to the LLM verbatim under the heading below.                                                                               |
| `phase`     | `header` (default) or `footer` — which prompt seam it renders into.                                                                             |
| `scope`     | `local` (beacon-authored) or `coordinator` (mirrored from coordinator). Coordinator-scoped rows **shadow** beacon-scoped rows with the same id. |
| `expiresAt` | Epoch ms expiry, or null. Targeted fragments default to now + 24h; broadcasts never expire by default.                                          |

The primary key is `(id, target)`: the same id can exist as a targeted row and a
broadcast simultaneously. `POST /agents` rejects registering an agentId of
`broadcast` (reserved sentinel).

### Delivery and rendering

The swarm plugin registers two prompt fragments — `swarm.fragments.header`
(phase `header`) and `swarm.fragments.footer` (phase `footer`) — whose render
functions read an in-memory store only (no network I/O in the render path, and
prompts are stable whether or not the beacon is reachable). The beacon pushes:

- On every WS connect: `fragmentSync` — the full merged current set for the
  connecting agent (targeted-for-agent + all broadcasts, TTL-filtered,
  coordinator-shadowed). Reconnects converge without an ack protocol.
- On upsert/delete of a targeted row: a `fragment` set/remove message to that
  agent (if connected).
- On upsert/delete of a broadcast: `fragmentSync` to all connected agents.
- On the beacon's TTL sweep (60s interval): a remove push for expired targeted
  rows addressed to connected agents.
- Coordinator mirror changes arrive during the beacon→coordinator sync interval
  (default 5 min); on change the beacon fans out `fragmentSync` to all agents.

Render format (ids are model-visible for reference):

```
# Swarm Fragments

## [maintenance-window]

The wiki analytics collector is down until 14:00 UTC.
```

Footer-phase fragments render identically under `# Swarm Directives`. Fragments
render after all other plugin fragments.

### Limits (provisional constants)

| Limit                              | Value                      |
| ---------------------------------- | -------------------------- |
| Max broadcast fragments per beacon | 5                          |
| Max targeted fragments per agent   | 50                         |
| Max content size                   | 16 KB                      |
| Default targeted TTL               | 24h (implicit `expiresAt`) |
| TTL sweep interval                 | 60s                        |

### CLI usage

```sh
# Beacon authoring (list also works against the coordinator, read-only)
drone-swarm --beacon http://localhost:3457 fragments set maintenance-window \
  --target broadcast --content "Collector down until 14:00 UTC"
drone-swarm --beacon http://localhost:3457 fragments list
drone-swarm --beacon http://localhost:3457 fragments list --target agent-123
drone-swarm --beacon http://localhost:3457 fragments delete maintenance-window --target broadcast

# Coordinator-side list (read-only v1; authoring arrives with the persistent-WS rework)
drone-swarm --coordinator http://localhost:3456 fragments list
```

### Coordinator scope

The coordinator serves `GET /api/fragments` (with `?target=` filter) from its
own `fragments` table. The beacon pulls it on the persona-precedent sync
interval (default 5 min), stores rows with `scope: 'coordinator'`, and fans out
a resync to connected agents when the merged set changes. This sync-hop is
scaffolding for the coming persistent-WS rework (which moves coordinator
authoring + push to a dedicated reverse channel); agent-side behavior is
unchanged by that rework.

### Security note

Fragments are prompt content injected by whoever can reach the beacon's write
API. This is a deliberate trade-off for the single-user swarm: the beacon binds
localhost/LAN (secure by default; tailscale for remote access) and requires
careful TOFU confirmation on coordinator trust. Do not expose a beacon's
fragment write routes to untrusted networks before release.

> Coordinator-side storage/serving is scaffolding for the persistent-WS rework
> branch; the swarm-internal prompt-injection surface above is accepted for v1.
