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

Each inbound turn is tagged with the speaker's name (see **Chat Tag**). In a multi-user room the turn also carries a per-turn **Room Instruction** telling the model it may decline to respond; a reply equal to the **No-Response Sentinel** (or a `null` reply) posts nothing. Because it defines `handleBatch`, it is **batch-eligible**: a burst of messages in a single-surface conversation is coalesced and answered once (see **Message Batcher**).
_Avoid_: Persona router, persona mapper, persona binding

**Swarm Console**:
A control surface that exposes coordinator commands as chat-accessible dot-notation commands of the form `swarm.<namespace>.<command> [args] [--flags]`. It parses the line itself and calls coordinator REST endpoints directly (no LLM, no agent), and requires a configured `coordinatorUrl`. v1 commands: `swarm.help`, `swarm.broadcast`, `swarm.persona.{list,create,update,delete}`, `swarm.skill.{list,create,update,delete}`, `swarm.session.{list,get}`, `swarm.beacon.{list,status,spawn}`, `swarm.agent.{status,terminate,inject,persona}`. A command that needs a coordinator endpoint that does not yet exist (`swarm.agent.focus`, `swarm.agent.interrupt`, `swarm.beacon.policy`, `swarm.session.search`, `swarm.session.delete`) is not in the grammar.
_Avoid_: Admin console, swarm shell, command surface

**Surface Registry**:
The engine's lookup table from a control surface `type` to the factory that builds per-conversation surface instances. Factories receive `(spec, conversationId, ctx)` where `ctx` is a `SurfaceContext` (`spawnBackend` + optional `swarm` API + engine-resolved `targetBeaconId`, `workingDir`, `idleTimeoutMs`, `debounceMs`). Replaced the earlier hardcoded `switch` in the engine. The engine also holds a **Spawn Backend Registry** — the same register/get/types shape, keyed by `SpawnBackendType`, from which each surface's backend is resolved.
_Avoid_: Surface table, factory map

**Spawn Target Beacon**:
The beacon a conversation's agents spawn on, taken per surface as `controlSurfaces[].config.targetBeaconId` and injected into that conversation's `SurfaceContext`. **Its presence selects the spawn mode**: present ⇒ coordinator mode (spawn on that beacon); absent ⇒ local mode (no beacon). There is **no** gateway-wide beacon default, so a coordinator surface always names its beacon inline. Only a **spawning** surface may carry it — a `targetBeaconId` on any other surface is warned about and dropped, and an invalid one (not a non-empty string) on a spawning surface is a load error. `CoordinatorSpawnBackend` holds no ambient beacon: it records the beacon on the session it returns, and termination targets that recorded beacon.
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
The internal message format used by the gateway. Contains the adapter ID, conversation ID, message text, optional sender information (`senderId?`/`senderName?`), and a required `conversationKind: 'dm' | 'room'` set by the adapter (only it knows group-ness). Service adapters translate platform-specific messages into this format.
_Avoid_: Gateway message, internal message, envelope

**Chat Tag**:
The `[Alice] fix the build` prefix applied to each inbound turn by a spawning surface (via `chat-format.ts`). The name falls back `senderName → senderId → 'unknown'`, and only the first line of a multi-line message is prefixed. Applied in **both rooms and DMs**, with no toggle. Kept in the surface (not the engine) so `swarm-console` still sees raw `swarm.` lines.
_Avoid_: Speaker prefix, username label, attribution

**Message Batcher**:
The engine's per-conversation coalescer (`batcher.ts`). When a message resolves to an **exact** conversation whose **sole** surface defines `handleBatch`, the message is buffered and the flush timer is (re)armed for the **Batch Debounce**. On flush the buffer is dispatched as **one** turn through the conversation's serial tail, and one merged reply is posted. Every other case (the wildcard, non-batch surfaces, multi-surface conversations) keeps the immediate per-message path.
_Avoid_: Coalescer, debouncer, aggregator

**Batch Debounce**:
How long a batch waits for stragglers before flushing. Resolved as `controlSurfaces[].config.batch.debounceMs ?? config.batch.debounceMs` (gateway-wide) ?? a built-in default (500 ms). `0` disables the debounce (flush on the next tick). Inert in a multi-surface conversation, where surface `batch.debounceMs` is silently ignored (batching is single-surface only).
_Avoid_: batch window, coalesce interval

**No-Response Sentinel**:
The exact string `<<NO_RESPONSE>>` an agent replies with to decline to respond. A spawning surface checks the reply with an exact match modulo trim and, on a match, returns `{ response: null, handled: true }` so the engine posts nothing (and logs it distinctly). The sentinel and the **Room Instruction** that names it live together in the gateway (`chat-format.ts`), the single source of truth.
_Avoid_: silence token, mute marker

**Room Instruction**:
The gateway-owned per-turn instruction delivered (only in a multi-user room) as a non-persisted system reminder, telling the model to decide whether a reply is warranted and naming the **No-Response Sentinel**. It rides the turn payload as `systemReminder`, which the agent's listen host queues via `queueSystemReminder` (drained as a `<system-reminder>`, never entering session history).
_Avoid_: group prompt, room prompt

**Coordinator Client**:
The HTTP client used by the gateway to communicate with the coordinator's web port (8080). Uses Bearer token authentication. Provides methods for spawning agents, listing beacons, and managing spawns.
_Avoid_: Coordinator API, coordinator proxy, coordinator connector

**Injection**:
Outbound posting of text into a conversation by an external process (a cron job, CI hook, or script). It bypasses control surfaces entirely — the text is handed straight to the adapter's `sendMessage` — and it does **not** serialize on the conversation's dispatch tail, so it may interleave with a live agent turn.
_Avoid_: push, publish, post

**Injection API**:
The daemon's loopback HTTP control API (`POST /inject`, `GET /status`, `GET /conversations`), served by `ControlApiServer`. Disabled by default (`controlApi.enabled`); when enabled and no `token` is set, loopback callers are trusted. Typed errors map to statuses: unknown adapter/conversation → 404, conversation not opted in → 403, bad body → 400.
_Avoid_: control endpoint, admin API, injection endpoint

**Injection Target**:
A conversation whose file sets `injection: { enabled: true }`. These are the only conversations the **Injection API** will post to. The **Wildcard Control Surface** (`*`) is never an injection target — an `injection` block on `_default_.json` is ignored with a warning.
_Avoid_: injectable conversation, injection sink

**Agent Helper**:
The `drone-gateway-inject run-agent` subcommand. It spawns a local one-shot `drone-agent --once --output-json` child, writes a `{ type: "kickoff", task }` event to the child's stdin (then closes it), and injects the child's **final chat message** (the last `assistantMessage`) via the **Injection API**. With `--no-response-sentinel`, a final message equal to the **No-Response Sentinel** injects nothing and exits 0.
_Avoid_: runner, agent launcher

**Message Helper**:
The `drone-gateway-inject inject-message` subcommand. It injects a literal string via the **Injection API** with no LLM involved.
_Avoid_: poster, message sender

## Config Layout

```
~/.drone-gateway/
  config.json                         # Gateway-level settings
    coordinatorUrl: string            # Optional; required iff a loaded surface needs
                                      # the coordinator (a coordinator-mode spawner
                                      # or a swarm-console surface)
    coordinatorToken?: string
    idleTimeoutMs?: number            # Gateway-wide default idle timeout (ms)
                                      # for spawning surfaces; 0 disables.
                                      # Overridden per-surface (see below).
    controlApi?: {                    # Opt-in inbound control API for external-process
      enabled: boolean               #   injection. Disabled by default.
      host: string                   # Default 127.0.0.1 (loopback only).
      port: number                   # Default 8090.
      token?: string                 # Optional Bearer token; unset = trust loopback.
    }
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
          injection?: { enabled: boolean }  # Opt this conversation into external-process
                                            # injection. Not allowed on _default_.
          controlSurfaces: [
            { type: "persona-assignment", personaId: "...",
              config: {
                targetBeaconId: "other-beacon",  # optional; ITS PRESENCE SELECTS
                                                  # coordinator mode. Absent = local
                                                  # mode. Only a spawning surface
                                                  # may set it.
                workingDir: "/srv/bots/me",       # optional; local: any path,
                                                  # coordinator: must be a
                                                  # beacon spawnRoot. Absent =
                                                  # mode default.
                lifecycle: { idleTimeoutMs: 1000 }, # optional; 0 disables
                batch: { debounceMs: 500 }        # optional; 0 disables the
                                                  # debounce. Single-surface
                                                  # conversations only.
              } },
            { type: "swarm-console" },
            { type: "discard" }
          ]
        _default_.json              # Wildcard catch-all (convId = "*")
```

## Architecture Contract

```
Matrix event ──(adapter: ONLY thing that knows room vs DM vs *)──▶ AdapterMessage{
  adapterId, conversationId, text, senderId?, senderName?, conversationKind }
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
