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

### How the coordinator's fingerprint is reported

The coordinator exposes its TLS certificate fingerprint two ways:

- **CLI:** `drone-coordinator --show-fingerprint` prints the fingerprint of the on-disk certificate.
- **API:** `GET /health` returns `tlsFingerprint` when HTTPS is enabled.

### Confirming the coordinator fingerprint (first connection)

On first connection the beacon writes the observed fingerprint to a pending file and holds coordinator trust. Confirm it with either:

- **CLI (primary):** `drone-beacon --confirm-coordinator-fingerprint <fp>` — promotes the pending fingerprint to trusted.
- **Agent (human-only):** connecting agents display a `[SECURITY]` warning with the observed fingerprint; run `/trust-coordinator <fp>` in the agent to confirm via the beacon's `POST /coordinator/trust` endpoint.

Swarm sync with the coordinator starts only after **both** sides accept: the coordinator's TLS fingerprint is confirmed **and** the coordinator has approved the beacon.

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
6. **Re-verify the bidirectional code.** Because the verification code now includes the coordinator's fingerprint, the code shown on the beacon and in the coordinator web UI will change. Compare them again to confirm no MITM occurred during the rotation.

> **Note:** The beacon's pinned fingerprint lives in `coordinator-tls-fingerprint.txt` in the beacon's config directory (default `~/.drone-beacon/`). You generally do **not** need to delete it manually — the confirmation flow replaces it. If you want to force a fresh TOFU handshake from scratch, you can remove it (and the `.pending.txt` file) and restart the beacon, but the confirmation flow above is the supported path.
