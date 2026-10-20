# drone-gateway

A standalone service that connects **chat platforms** to the drone swarm.
It receives messages from chat platforms (Matrix today; Telegram, Slack planned),
routes each conversation through one or more **control surfaces**, and posts the
responses back. It is the bridge between human conversation and agent
coordination.

Two binaries ship from this package:

- `drone-gateway` — the long-lived daemon.
- `drone-gateway-inject` — a one-shot helper that posts text into a live
  conversation from outside the platform (cron, CI, a script).

See [`CONTEXT.md`](./CONTEXT.md) for the domain glossary and
[`../docs/agents/swarm-extensions.md`](../docs/agents/swarm-extensions.md) for how
the gateway acts as a swarm extension.

## Architecture

```
Matrix event ──(adapter: the only layer that knows room vs DM vs *)──▶ AdapterMessage
        │
        ▼  engine: perAdapter[adapterId] = Map<convId, ControlSurface[]>
  exact convId?  → try surfaces in order (first-match-wins)
  else "*" present? → try the wildcard surface array in order
  else              → unhandled (drop, logged)
        │
        ▼
  A dedicated ControlSurface instance per conversation
   • created once at start() • never re-checks msg.conversationId
```

- **Service adapter** — a platform integration. It owns conversation routing:
  only it knows whether an event is a room, a DM, or the wildcard. Currently
  `matrix` is implemented.
- **Control surface** — a behavior bound to a conversation. Built-ins:
  `persona-assignment` (spawn an agent), `swarm-console` (dot-notation
  coordinator commands, no LLM), and `discard` (silent sink).
- **Spawn backends** — `local` (spawn `drone-agent` on this host) or
  `coordinator` (ask a beacon to spawn). The mode is **inferred per surface**:
  a `persona-assignment` surface with `config.targetBeaconId` set spawns via the
  coordinator; without it, locally.

## Usage

```bash
# Build the workspace first (from the repo root)
pnpm -r run build

# Start the daemon (loads ~/.drone-gateway/config.json by default)
drone-gateway
drone-gateway --config /path/to/config.json
drone-gateway serve

# Decommission a Matrix adapter (logout + delete its dataPath)
drone-gateway cleanup --adapter <adapter-id>

drone-gateway --help
```

The daemon loads config, starts each adapter, registers its control surfaces,
and runs until `SIGINT`/`SIGTERM`. Shutdown order is Injection API → Gateway
Engine → swarm extension node.

## Configuration

Config lives under `~/.drone-gateway/` by default (override the file with
`--config`).

```
~/.drone-gateway/
  config.json                     # Gateway-level settings
  adapters/
    <adapter-id>/
      adapter.json                # Platform connection + auth
      conversations/
        <conv-id>.json            # One file per conversation
        _default_.json            # Wildcard catch-all (conversationId "*")
```

### `config.json`

```jsonc
{
  "coordinatorUrl": "http://127.0.0.1:3456", // optional; see below
  "swarmExtension": {
    // Optional tuning for the extension node.
    "id": "drone-gateway", // default
    "name": "Drone Gateway", // default
    "dataDir": "<configDir>/extension", // default; "~" expanded
    "requestTimeoutMs": 15000, // default; bounded coordinator fetch
  },
  "idleTimeoutMs": 300000, // gateway-wide default idle timeout (ms); 0 disables
  "agentPath": "/path/to/drone-agent", // local spawn backend executable
  "controlApi": {
    // Opt-in inbound control API for external-process injection.
    "enabled": false, // disabled by default
    "host": "127.0.0.1", // default; loopback only
    "port": 8090, // default
    "token": "…", // optional Bearer token; unset = trust loopback
  },
}
```

**`coordinatorUrl` presence gates the swarm extension.** With it the gateway
registers as an extension node and routes all coordinator traffic over the
node's mTLS identity. Without it the gateway is a standalone local chat agent
runner. `coordinatorToken` is a **removed key** — a hard error when present.
See [ADR 256](../docs/adr/256-gateway-swarm-extension.md).

### `adapters/<id>/adapter.json`

```jsonc
{
  "id": "my-matrix-bot",
  "type": "matrix",
  "homeserverUrl": "https://matrix.org",
  "accessToken": "syt_…",
  "userId": "@mybot:matrix.org",
  "deviceId": "ABCDEF", // optional
  "rooms": ["!room:matrix.org"], // optional allowlist; DMs always included
  "dataPath": "~/.drone-gateway/adapters/my-matrix-bot/state.db",
  "encryption": false, // opt-in E2EE; on Node the Rust-crypto keys are memory-only
}
```

- **`dataPath`** backs the persistent sync store, the **Snapshot Store**
  (portable-context continuity), and the **Outbound Ledger**. When it is unset,
  `persona-assignment` continuity is **disabled** (one startup warning per
  adapter).

### `adapters/<id>/conversations/<conv-id>.json`

```jsonc
{
  "conversationId": "!room:matrix.org", // canonical, not derived from filename
  "allowedSenders": ["@alice:matrix.org"], // optional; others fall to wildcard
  "injection": { "enabled": false }, // opt this conversation into injection
  "controlSurfaces": [
    {
      "type": "persona-assignment",
      "personaId": "code",
      "config": {
        "targetBeaconId": "other-beacon", // presence selects coordinator mode
        "workingDir": "/srv/bots/me", // ABS; coordinator mode must be a spawnRoot
        "lifecycle": { "idleTimeoutMs": 300000 }, // 0 disables
        "batch": { "debounceMs": 500 }, // 0 disables; single-surface only
        "mode": "active", // active (default) | passive | observer
        "catchUp": { "intervalMs": 900000 }, // passive/observer cadence; 0 disables
      },
    },
    { "type": "swarm-console" },
    { "type": "discard" },
  ],
}
```

Surface mode is a **delivery axis**: `active` answers each message, `passive`
buffers and answers on a mention or the catch-up cadence, `observer` buffers and
never posts. An invalid `mode` is a hard load error. A `targetBeaconId` on a
non-spawning surface is dropped with a warning.

## Injection

External processes can post text into an opted-in conversation through the
**control API** (`controlApi.enabled` + `injection: { enabled: true }`).
The wildcard conversation can never be an injection target.

| Method | Path             | Purpose                                  |
| ------ | ---------------- | ---------------------------------------- |
| `POST` | `/inject`        | Post `{adapterId, conversationId, text}` |
| `GET`  | `/status`        | Version + adapter ids                    |
| `GET`  | `/conversations` | Injectable conversations                 |

Typed errors: unknown adapter/conversation → 404, not opted in → 403, bad body
→ 400.

### `drone-gateway-inject`

```bash
# Inject a literal string (no LLM)
drone-gateway-inject inject-message --adapter <id> --conversation <id> "hello"
drone-gateway-inject inject-message --adapter <id> --conversation <id> --file -

# Spawn a one-shot agent and inject its final chat message
drone-gateway-inject run-agent --adapter <id> --conversation <id> \
  --persona code --working-dir /srv/proj --timeout 600 \
  --no-response-sentinel "Summarize the last release"
```

Common options: `--config`, `--host`, `--port`, `--token`, `--adapter`,
`--conversation`, `--prefix`, `--json`. `run-agent` also takes `--persona`,
`--working-dir`, `--model`, `--agent-path`, `--timeout` (seconds, default 600),
and `--no-response-sentinel` (suppress injection when the agent replies
`<<NO_RESPONSE>>`).

## Pre-approval tokens

A remote coordinator — one that does not see the gateway as a loopback caller —
registers the gateway as **pending** and needs manual approval. A **pre-approval
token** pre-approves it.

The token file is a **sensitive credential**. Store it securely. The coordinator
UI shows it one time only.

```bash
drone-gateway --pre-approval-token-path=./token.json
# or
drone-gateway --pre-approval-token-path ./token.json
```

With the flag the gateway performs a **one-shot run**: it registers, redeems the
token, writes `<swarmExtension.dataDir>/coordinator-trust.json`, and exits 0 — it
does not serve. Later runs pin the coordinator's TLS fingerprint from the trust
file (no trust-on-first-use window). The flag requires `coordinatorUrl` and
`swarmExtension` in the config.

Mint tokens from the coordinator's **Pre-approval tokens** page (linked from the
Topology page). See [ADR 258](../docs/adr/258-pre-approval-tokens.md).

## Tests

```bash
pnpm --filter drone-gateway run test
# or from the repo root
pnpm test
```

## Related

- [`CONTEXT.md`](./CONTEXT.md) — domain glossary and config layout.
- [ADR 044](../docs/adr/044-gateway-core.md) — gateway core.
- [ADR 238](../docs/adr/238-gateway-per-surface-spawn-backend.md) — per-surface
  spawn backend.
- [ADR 250](../docs/adr/250-gateway-surface-modes.md) — surface modes.
- [ADR 256](../docs/adr/256-gateway-swarm-extension.md) — gateway as a swarm
  extension.
- [ADR 258](../docs/adr/258-pre-approval-tokens.md) — pre-approval tokens.
