## LLM provider config via swarm underlays

Coordinator-level config is distributed to agents as a config underlay through
the beacon. The coordinator is the source of truth; the beacon PULLS the
coordinator's global allowlisted entries on its existing 5-minute
`triggerCoordinatorSync` (plus startup), persists the non-secret ones as
`beacon_config scope='swarm'` (secret-bearing rows stay in a memory-only
overlay — see the Stored Secrets section below), and serves the merged view
from its `GET /config` (beacon-local entries win for the same key, one row per
key). The agent's swarm plugin then
applies that merged underlay at session start via the config plugin's
`rebuild()` (which runs registered injectors in precedence order, re-applies
the on-disk user/project layers on top so the most-local config wins
conflicts, and mutates the engine's shared config in place, so the llm
broker and budget service observe the values before the first turn).
Direction is strictly coordinator → beacon → agent. The agent injector
normalizes the beacon's flat dotted-key rows into nested config keys and
drops rows outside the underlay allowlist, rows that fail to parse, and rows
whose `${VAR}` templates reference unset environment variables (one-time
warning per row and failure kind).

The coordinator UI's **Config** page manages the allowed entries (global
allowlist in `drone-core`'s `UNDERLAY_ALLOWLIST`): `providers.*` (whole-entry
units), `llm.active`, `llm.reasoningLevel`, `compaction.enabled`,
`compaction.strategy`, and `session.guardrail.*`. API keys and other secrets
are managed through the **Stored Secrets** manager (button at the top of the
Config page) and referenced from settings via the distinct `${secret:NAME}`
token — the coordinator resolves those tokens into the real stored values at
beacon-pull time on the beacon-facing `/api/config/distribution` payload.
Stored values are plaintext-at-rest on the coordinator, masked on read
(`••••` + last 4) and write-only on edit, and never shown in full after
saving. Reference names use the environment-variable charset
`[A-Za-z0-9_]+`, so `${secret:NAME}` can never collide with a receiver-side
`${VAR}` env template (the env regex does not match the colon), and the PUT
route rejects references to secrets that do not exist (400).

Secrets are resolved ONLY on the beacon-facing distribution payload; the
UI-facing `/api/config` listing stays unresolved and masked, so a resolved
value never reaches the UI. Distribution only reaches **approved** beacons
(Plan A server-side status enforcement), with a persistent warning banner in
the UI. Encryption-at-rest is a documented follow-up.

A setting whose `${secret:NAME}` reference cannot be resolved (the secret was
deleted or renamed after save) is dropped from distribution with a warning,
and stays out of every pull until the reference is valid again or the
setting is removed. Legacy `secret:true` rows without a reference are still
honored: their value ships on the distribution payload flagged
`containsSecrets` so the beacon keeps it memory-only.

When a stored secret is added/rotated/deleted or a referenced setting is
saved/deleted, the coordinator fires a payload-less `configChanged` nudge over
the reverse channel; each connected beacon re-pulls immediately. The 5-minute
periodic sync + startup sync remain the correctness floor.

Valid underlay content includes:

- `providers` — full provider entries (protocol, baseUrl, `${VAR}`-templated
  apiKey, parameters, models). Entries merge by key with whole-entry
  replacement: any scope defining `providers.<id>` replaces that entire
  entry, so a swarm-distributed entry cannot be partially overridden by
  local config (define a different id instead).
- `llm.active` / `llm.reasoningLevel` — selection pins.
- `compaction.enabled` / `compaction.strategy` — compaction tuning.
- `session.guardrail.*` — guardrail thresholds.

`${VAR}` interpolation runs receiver-side in both config paths: disk-layer
files are interpolated at parse time, and underlay rows are interpolated by
the agent's beacon injector at session-start apply time — each node resolves
against its own process environment. A swarm-distributed
`"apiKey": "${OPENROUTER_API_KEY}"` therefore authenticates once the
variable exists in the agent's environment. An underlay row referencing an
unset variable is dropped whole (provider entries are whole-entry units; a
half-resolved provider that lists but cannot authenticate is worse than an
honest absence) with a one-time warning per key naming the variable. Set the
env var before launching the agent; env changes take effect at the next
session start, usually the next agent process. A known gap shared with the
disk path: non-identifier variable names like `${FOO-BAR}` are unresolvable
and stay literal. Plaintext keys in underlays are allowed (swarm is a trusted
channel); project-scope files may NOT define `providers` at all — that
combination fails startup validation.

Resolved `${secret:NAME}` values are injected into agents at session start
and are never retained by the beacon: the beacon holds secret-bearing entries
in a memory-only overlay (`containsSecrets`), keeps them out of `beacon_config`
SQLite, and wipes them on process exit. A beacon compromise at rest therefore
yields zero secret material.

### Underlay reactivity (ADR 241)

Changes propagate on the next sync (≤ ~5 minutes) and are applied at the next
agent session start, or mid-session when a plugin-enable catch-up re-runs the
session-start hooks. At apply time the config plugin fires
`onLayersChanged` (new optional method on `DroneConfigCapability`); the llm
broker subscribes and reacts immediately — the model-listing cache is
invalidated and re-warmed, so `/model` never serves a stale pre-underlay
listing, and the active selection is re-evaluated: a swarm-pinned `llm.active`
auto-activates unless a manual selection was already made this session (a
manual choice is kept with a one-time log notice). Ordinary config changes
still wait for the next session start; the underlay is not re-read
mid-session on its own. Spawn-env
asymmetry: coordinator-relayed spawns run with the beacon host's environment
(the shared spawner passes the beacon process's `process.env` plus additive
`config.env`), so a spawned agent resolves `${VAR}` templates against the
beacon host's env, not the coordinator's or gateway's.

# Swarm Plugin

The `swarm` plugin connects to a `drone-beacon` instance to provide swarm-wide personas, skills, and config injection. It is not enabled by default.

## Capabilities

- Registers persona and skill providers at both the beacon and coordinator precedence levels
- Provides a WebSocket-based messaging channel for inter-agent communication
- Registers HTTP storage engines for swarm-scoped insights and principles
- Registers wiki and coordinator tools using the list/mount pattern (3 meta-tools: `list_tools`, `mount_tool`, `unmount_tool`)
- Pushes conversation events to the coordinator
- Registers the `swarm.status` and `swarm.identity` header fragments (see below)

> **Coordinator traffic proxies through the beacon.** The agent never talks to the coordinator directly. All coordinator reads and mutations (session import/list, spawn, list beacons/agents, terminate spawn) hit the **beacon's** `/coordinator/*` proxy routes, which forward to the coordinator via the beacon's trust-gated `CoordinatorClient`. This keeps the beacon as the sole coordinator-facing trust gate (TOFU fingerprint + beacon approval). The now-removed `coordinatorUrl` agent config is gone — the swarm plugin only needs `beaconHost`/`beaconPort`.

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

### Agent-rendered fragments (status, identity, stored fragments)

The swarm plugin registers four prompt fragments:

| Key                      | Phase    | Renders                                                                |
| ------------------------ | -------- | ---------------------------------------------------------------------- |
| `swarm.status`           | `header` | `# Swarm Status` — local beacon, coordinator, registered beacon roster |
| `swarm.identity`         | `header` | `# Swarm Identity` — reserved free-text identity (below)               |
| `swarm.fragments.header` | `header` | `# Swarm Fragments` — stored header-phase fragments                    |
| `swarm.fragments.footer` | `footer` | `# Swarm Directives` — stored footer-phase fragments                   |

Registration order fixes the header order: `# Swarm Status` → `# Swarm Identity`
→ `# Swarm Fragments`. Every render function reads an in-memory store only (no
network I/O in the render path, and prompts are stable whether or not the
beacon is reachable).

The beacon pushes stored-fragment changes as:

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

Render format for stored fragments (ids are model-visible for reference):

```
# Swarm Fragments

## [maintenance-window]

The wiki analytics collector is down until 14:00 UTC.
```

Footer-phase fragments render identically under `# Swarm Directives`.

### Swarm status fragment (`# Swarm Status`)

The `swarm.status` header fragment describes the connected swarm so the model
knows which swarm it runs in. It is always on when the swarm plugin is loaded
(no config key) and hides itself entirely (renders `false`) until it has data.
It reads a cache only — never the network — and the cache is refreshed:

- at plugin load (`onPluginsLoaded`),
- on every WS connect/reconnect, and
- on a 60s interval.

Sources:

| Field              | Source                                                          |
| ------------------ | --------------------------------------------------------------- |
| Local beacon       | `GET /info` (`{ id, name, coordinatorHost, coordinatorPort }`)  |
| Coordinator        | `coordinatorHost[:coordinatorPort]` from `/info`                |
| Registered beacons | beacon proxy `GET /coordinator/beacons` (name/host/port/status) |

The beacon also pushes the same `/info` payload in the WS `connected`
handshake, so the cache self-heals after a beacon restart or reconfiguration
without waiting for a fetch. A failed refresh keeps the last known values and
never regresses the roster to empty (only a successful response replaces it).

Render shape:

```
# Swarm Status

- Local beacon: home-office (localhost:3457)
- Coordinator: coord.example:3456
- Registered beacons (2):
  - home-office (localhost:3457)
  - workshop (10.0.0.2:3457) · offline
```

The coordinator line is omitted when no coordinator is configured. A roster
entry gets a `· offline` marker when not connected and a `· pending approval` /
`· rejected` marker when its trust status is not `approved`.

### Swarm identity fragment (`# Swarm Identity`)

The `swarm-identity` fragment is a **reserved, user-authored broadcast**: free
text describing the swarm, written from the coordinator web UI's **Identity**
page and rendered as its own top-level `# Swarm Identity` section. It is stored
in the coordinator `fragments` table (`target: 'broadcast'`, `phase: 'header'`)
and rides the normal coordinator → beacon mirror → WS `fragmentSync` path. The
reserved id is excluded from the `# Swarm Fragments` bucket, so it never
double-renders.

Reserved fragments have their own policy (implemented in the shared
`drone-swarm-common` limits module): they may only target `broadcast`, are
excluded from the broadcast/targeted count caps (their own budget), and never
expire (the TTL sweep skips them). The plugin renders `swarm.identity` as its
own fragment and hides it (`false`) until the row exists.

Coordinator authoring uses the general fragment routes
`PUT /api/fragments/:id` and `DELETE /api/fragments/:id`; a write fires the
reverse-channel `fragmentsChanged` nudge, which makes each connected beacon
re-pull immediately (the 5-minute periodic sync remains the floor).

### Limits (provisional constants)

| Limit                              | Value                            |
| ---------------------------------- | -------------------------------- |
| Max broadcast fragments per beacon | 5 (system-reserved ids excluded) |
| Max targeted fragments per agent   | 50                               |
| Max content size                   | 16 KB                            |
| Default targeted TTL               | 24h (implicit `expiresAt`)       |
| TTL sweep interval                 | 60s                              |

Reserved ids (`swarm-identity`) are excluded from the broadcast/targeted caps
and never expire, so the identity can always be saved even at the broadcast cap
and saving it does not consume a user broadcast slot.

### CLI usage

```sh
# Beacon authoring (list also works against the coordinator)
drone-swarm --beacon http://localhost:3457 fragments set maintenance-window \
  --target broadcast --content "Collector down until 14:00 UTC"
drone-swarm --beacon http://localhost:3457 fragments list
drone-swarm --beacon http://localhost:3457 fragments list --target agent-123
drone-swarm --beacon http://localhost:3457 fragments delete maintenance-window --target broadcast

# Coordinator-side list
drone-swarm --coordinator http://localhost:3456 fragments list
```

### Coordinator scope

The coordinator serves `GET /api/fragments` (with `?target=` filter) from its
own `fragments` table. The beacon pulls it on the persona-precedent sync
interval (default 5 min), stores rows with `scope: 'coordinator'`, and fans out
`fragmentSync` to connected agents when the merged set changes. The coordinator
also accepts `PUT /api/fragments/:id` and `DELETE /api/fragments/:id` (the
Identity page is a thin client over the reserved `swarm-identity` id); each
write fires the reverse-channel `fragmentsChanged` nudge so connected beacons
re-pull immediately.

### Security note

Fragments are prompt content injected by whoever can reach the beacon's or
coordinator's write API. This is a deliberate trade-off for the single-user
swarm: the beacon binds localhost/LAN (secure by default; tailscale for remote
access) and requires careful TOFU confirmation on coordinator trust. Do not
expose a beacon's fragment write routes to untrusted networks before release.
