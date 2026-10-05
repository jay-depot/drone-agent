# drone-gateway

Standalone service that connects chat platforms to the drone swarm. Receives messages from chat platforms (Matrix, Telegram, Slack), routes them through control surfaces, and sends responses back. Acts as the bridge between human conversation and agent coordination.

## Language

**Gateway**:
The standalone service itself. Loads config, initializes service adapters, runs the message routing loop, and communicates with the coordinator.
_Avoid_: Bridge, relay, proxy, chat bot

**Service Adapter**:
A platform integration (Matrix, Telegram, Slack). Each adapter knows how to connect to that platform's API, authenticate, and translate between platform-specific message formats and the gateway's internal format. The adapter **owns conversation routing** — it determines the `conversationId` for each incoming message (room ID, DM peer ID, etc.).
_Avoid_: Connector, driver, integration, channel

**Control Surface**:
A configuration that maps a chat conversation (room, DM, channel) to a behavior. Each conversation gets a **dedicated instance** of its control surface(s), created at engine start time. A control surface is never invoked for a conversation other than its own. Multiple control surfaces can be attached to the same conversation as an ordered array (first-match-wins).
_Avoid_: Handler, rule, mapping, route

A control surface may expose an optional `dispose(): Promise<void>` (see **Surface Disposal**). The engine calls it once at shutdown for every instantiated surface.

**Conversation**:
A single chat conversation identified by a `conversationId`. For Matrix, rooms use the room ID (e.g. `!abc:matrix.org`) and DMs use `dm:@peer:server`. The conversationId is opaque to the engine and control surfaces — only the adapter knows the scheme.
_Avoid_: Channel, thread, room

**Wildcard Control Surface**:
A control surface attached to the reserved conversationId `"*"`. It acts as a catch-all for any conversation that doesn't have an exact match. Configured via the `_default_.json` file in the adapter's conversations directory. Evaluated after exact matches (first-match-wins still applies within the wildcard's surface array).
_Avoid_: Default handler, fallback, catch-all

**Discard Control Surface**:
A built-in control surface type (`type: "discard"`) that silently consumes messages, returning `{ response: null, handled: true }`. Used for explicit "/dev/null" routing (e.g., wildcard catch-all for unknown DMs). Makes the intent observable in logs.
_Avoid_: Null surface, dev-null, black hole

**Persona Assignment**:
A lifecycle-managed control surface that routes all messages in a conversation to a specific persona. The gateway spawns an agent with that persona on the conversation's resolved **Spawn Target Beacon** and with the conversation's resolved **Working Directory**, sends the message as a task, and returns the response. The agent is kept alive between turns, terminated after the **Idle Timeout** (and re-spawned lazily on the next message), re-spawned once if `sendMessage` fails because the agent died, and disposed at gateway shutdown. There is no session resume: a re-spawn starts with fresh in-memory context, and continuity comes from the on-disk **Working Directory**.
_Avoid_: Persona router, persona mapper, persona binding

**Swarm Console**:
A control surface that exposes coordinator commands as chat-accessible dot-notation commands of the form `swarm.<namespace>.<command> [args] [--flags]`. It parses the line itself and calls coordinator REST endpoints directly (no LLM, no agent), and requires the `coordinator` spawn backend. v1 commands: `swarm.help`, `swarm.broadcast`, `swarm.persona.{list,create,update,delete}`, `swarm.skill.{list,create,update,delete}`, `swarm.session.{list,get}`, `swarm.beacon.{list,status,spawn}`, `swarm.agent.{status,terminate,inject,persona}`. A command that needs a coordinator endpoint that does not yet exist (`swarm.agent.focus`, `swarm.agent.interrupt`, `swarm.beacon.policy`, `swarm.session.search`, `swarm.session.delete`) is not in the grammar.
_Avoid_: Admin console, swarm shell, command surface

**Surface Registry**:
The engine's lookup table from a control surface `type` to the factory that builds per-conversation surface instances. Factories receive `(spec, conversationId, ctx)` where `ctx` is a `SurfaceContext` (`spawnBackend` + optional `swarm` API + engine-resolved `targetBeaconId`, `workingDir`, `idleTimeoutMs`). Replaced the earlier hardcoded `switch` in the engine.
_Avoid_: Surface table, factory map

**Spawn Target Beacon**:
The beacon a conversation's agents spawn on. The engine resolves it per conversation as `controlSurfaces[].config.targetBeaconId ?? config.targetBeaconId` (the per-conversation override wins over the gateway-wide default) and injects the resolved value into that conversation's `SurfaceContext`. It is `undefined` in local spawn-backend mode, where there is no beacon. The gateway-wide default is required when `spawnBackend` is `"coordinator"` and merely warned about when it is `"local"`. `CoordinatorSpawnBackend` holds no ambient beacon: it records the beacon on the session it returns, and termination targets that recorded beacon.
_Avoid_: Spawn host, target host, agent location

**Working Directory**:
The directory a conversation's spawned agent runs in, set per surface as `controlSurfaces[].config.workingDir`. There is **no** gateway-wide default. The engine resolves it (validating that it is a non-empty absolute string after `~`/`~/` expansion, ≤ 4096 chars) and injects it as `ctx.workingDir`; the surface passes it to `spawnSession`. Absent means the mode default: local mode inherits the gateway process cwd, coordinator mode omits the field so the beacon applies its `defaultSpawnRoot`. Local mode has no whitelist; coordinator mode is whitelisted by the beacon's `spawnRoots`. The directory gives each bot a pseudo-project for memories and scratch files, and is how continuity survives an idle/death re-spawn.
_Avoid_: cwd, project path, working folder

**Idle Timeout**:
How long a spawning surface keeps its agent alive with no completed turn. Resolved as `controlSurfaces[].config.lifecycle.idleTimeoutMs ?? config.idleTimeoutMs` (gateway-wide) ?? a built-in default (300000 ms). `0` disables the timer. The timer resets on each turn **completion** (never mid-turn) and is `unref()`'d so it cannot hold the process open. On expiry the surface terminates the agent and drops the session; the next message lazily re-spawns.
_Avoid_: keepalive, TTL, expiry

**Surface Disposal**:
The optional `dispose(): Promise<void>` a control surface may implement. The engine calls it once for every instantiated surface at `GatewayEngine.stop()`, after adapters stop, so spawning surfaces terminate their live agents instead of leaking them. Implementations are idempotent and do not throw; the engine logs and swallows any failure.
_Avoid_: teardown, cleanup, destroy

**Allowed Senders**:
An optional per-conversation allowlist (`allowedSenders: string[]`) enforced by the engine at dispatch time. When set, only listed `senderId`s match the conversation; other senders fall through to the wildcard. Unset means every sender is allowed. Authorization lives at the conversation level, never inside a surface.
_Avoid_: ACL, permission list, access list

**Mention Router**:
A control surface that watches for `!persona` mentions in a conversation and routes those messages to the specified persona. Falls through (unhandled) if no mention is detected, allowing other control surfaces to process the message.
_Avoid_: Mention handler, persona mention, dispatch surface

**Adapter Message**:
The internal message format used by the gateway. Contains the adapter ID, conversation ID, message text, and optional sender information. Service adapters translate platform-specific messages into this format.
_Avoid_: Gateway message, internal message, envelope

**Coordinator Client**:
The HTTP client used by the gateway to communicate with the coordinator's web port (8080). Uses Bearer token authentication. Provides methods for spawning agents, listing beacons, and managing spawns.
_Avoid_: Coordinator API, coordinator proxy, coordinator connector

## Config Layout

```
~/.drone-gateway/
  config.json                         # Gateway-level settings
    coordinatorUrl: string            # Required for coordinator mode; optional for local
    coordinatorToken?: string
    spawnBackend: "local"|"coordinator"
    targetBeaconId?: string           # Gateway-wide default spawn beacon;
                                      # required when spawnBackend is "coordinator";
                                      # inert (and warned) in local mode
    idleTimeoutMs?: number            # Gateway-wide default idle timeout (ms)
                                      # for spawning surfaces; 0 disables.
                                      # Overridden per-surface (see below).
    agentPath?: string                # For local spawn backend
  adapters/
    <adapter-id>/
      adapter.json                   # Adapter type, auth, platform config
        id: string
        type: string                 # "matrix", "telegram", "slack"
        homeserverUrl: string        # Matrix-specific
        accessToken: string
        userId: string
        deviceId?: string
        rooms?: string[]             # Allowlist; DMs always included
        dataPath?: string            # Path to SQLite database for the persistent
                                     # sync store (survives restart); the same
                                     # database backs the legacy-crypto
                                     # migration store. Does NOT persist
                                     # Rust-crypto E2EE keys.
        encryption?: boolean         # Opt-in E2EE (default false). On Node the
                                     # Rust-crypto keys live in memory only, so
                                     # they are lost on restart.
      conversations/
        <conv-id>.json              # One file per conversation
          conversationId: string     # Canonical ID (not derived from filename)
          allowedSenders?: string[]  # Optional: only these senderIds match this
                                     # conversation; others fall through to the
                                     # wildcard. Unset = every sender allowed.
          controlSurfaces: [
            { type: "persona-assignment", personaId: "...",
              config: {
                targetBeaconId: "other-beacon",  # optional beacon override
                workingDir: "/srv/bots/me",       # optional; local: any path,
                                                  # coordinator: must be a
                                                  # beacon spawnRoot. Absent =
                                                  # mode default.
                lifecycle: { idleTimeoutMs: 1000 } # optional; 0 disables
              } },
            { type: "swarm-console" },
            { type: "discard" }
          ]
        _default_.json              # Wildcard catch-all (convId = "*")
```

## Architecture Contract

```
Matrix event ──(adapter: ONLY thing that knows room vs DM vs *)──▶ AdapterMessage{
  adapterId, conversationId, text, senderId?, senderName? }
        │
        ▼  engine: perAdapter[adapterId] = Map<convId, ControlSurface[]>
  exact convId? → try in order (first-match-wins)
  else "*" present? → try wildcard in order
  else → unhandled (drop, logged)
        │  surface is invoked ONLY for its own conversation
        ▼
  Dedicated ControlSurface instance (created once at start())
   • never re-checks msg.conversationId
   • reads text + (optionally) senderId/senderName as "decorations"
```
