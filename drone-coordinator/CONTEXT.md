# drone-coordinator

Central hub that connects beacons for swarm-wide coordination. Maintains a registry of beacons, provides swarm-wide skills and personas, and tracks session history.

## Language

**Coordinator**:
The central hub in a swarm. Beacons register with it to enable cross-beacon coordination and access to swarm-wide resources.
_Avoid_: Server, hub, central node, master

**Beacon**:
A registered beacon that has connected to this coordinator. Tracked by ID, name, host, port, and heartbeat.
_Avoid_: Node, client, peer, agent host

**Beacon Session**:
A record of an agent session that occurred on a connected beacon. Tracks the beacon, agent ID, persona, and duration.
_Avoid_: Session record, agent history, session log

**Swarm Persona**:
A persona available across the entire swarm. Synced from coordinator to beacons.
_Avoid_: Global persona, shared persona, centralized persona

**Swarm Skill**:
A skill available across the entire swarm. Synced from coordinator to beacons.
_Avoid_: Global skill, shared skill, centralized skill

**Register Beacon**:
The act of a beacon connecting to and registering with the coordinator. Includes beacon ID, name, host, and port.
_Avoid_: Beacon connect, beacon join, beacon handshake

**Heartbeat**:
A periodic signal from a beacon to indicate it's still connected. Used to detect stale connections.
_Avoid_: Ping, keepalive, check-in

**Beacon Trust**:
The coordinator's record of a beacon's identity and approval, keyed by beacon ID and anchored on the beacon's public key. A re-registration presenting a different public key is rejected as a possible spoofing attempt (the record must be deleted first to accept a new key).
_Avoid_: Beacon approval, trust record, allowlist entry

**Trust Status**:
A beacon trust record's lifecycle state: `pending` → `approved` (or `rejected`). A new beacon starts `pending` unless it registered over a loopback socket or the deployment opted into `autoApproveBeacons`; only `approved` beacons pass the mTLS and reverse-channel gates.
_Avoid_: Approval state, trust level, status flag

**Fingerprint Confirmed**:
Whether the beacon has confirmed the coordinator's own TLS fingerprint (`fingerprint_confirmed_at`) — the coordinator-side half of the TOFU exchange. A loopback beacon is treated as confirmed at registration. Approval requires it: `approveBeaconById` only flips `pending → approved` when it is set, so the UI's Approve stays disabled until then.
_Avoid_: Fingerprint verified, pin confirmed

**Verification Code**:
A short human-readable code derived from the beacon's public key, the beacon's TLS fingerprint, and the coordinator's TLS fingerprint. Both sides compute the same code and the operator compares them out-of-band to detect a man-in-the-middle. Never displayed by the beacon itself; recomputed on every re-registration.
_Avoid_: Approval token, pairing code, auth code

**TLS Fingerprint**:
The SHA-256 of a peer's TLS certificate, used for TOFU pinning. The coordinator stores the beacon's (pins it at first sight, flags a later mismatch) and the beacon stores the coordinator's; each verifies the other on reconnect.
_Avoid_: Cert hash, certificate ID
