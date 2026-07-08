# ADR 002: Gateway Config Model — Folder Hierarchy with Per-Conversation Control Surfaces

**Status:** Accepted

**Context:** The initial gateway config model (ADR 001) used a flat `config.json` with `serviceAdapters[].controlSurfaces[]` where each control surface specified a `conversationId`. This worked for simple cases but broke down when we needed per-peer DM routing (e.g., "you → swarm console, friends → mention router, everyone else → PR persona or discard"). The flat model couldn't express:

- A per-adapter wildcard catch-all for unmatched conversations
- Per-conversation dedicated control surface instances (each DM peer needs its own surface state)
- Composition of multiple surfaces per conversation (mention-router + persona-assignment in the same room)

## Decision 1: Folder Hierarchy

**Decision:** Gateway config is stored as a folder hierarchy rather than a single JSON file.

**Layout:**

```
~/.drone-gateway/
  config.json                         # Gateway-level settings
  adapters/
    <adapter-id>/
      adapter.json                   # Adapter type, auth, platform-specific config
      conversations/
        <conv-id>.json               # One file per conversation
        _default_.json               # Wildcard catch-all (conversationId = "*")
```

**Rationale:**

- Each adapter is self-contained in its own directory — easy to add, remove, or version-control independently.
- Conversations scale to dozens or hundreds without nesting depth issues in a single JSON file.
- The wildcard `_default_.json` is a natural filesystem convention (reserved filename).
- Conversation IDs containing special characters (`!`, `@`, `:`, `/`) are encoded to safe filenames via a lossless mapping (`convIdToFilename`/`filenameToConvId`), but the canonical ID is always read from the in-file `conversationId` field — never derived from the filename.

**Alternatives considered:**

- Single nested `config.json`: Rejected because it becomes unwieldy with many DM peers.
- Database-backed config: Rejected for simplicity — JSON files are human-editable and version-controllable.

## Decision 2: Per-Conversation Dedicated Control Surface Instances

**Decision:** Each conversation gets its own dedicated ordered list of control surface instances, created at engine `start()` time. A control surface instance is never invoked for a conversation other than its own.

**Rationale:**

- Surfaces like `persona-assignment` maintain session state (the agent session). If a surface were shared across conversations, sessions would collide.
- The engine guarantees the dispatch contract: exact conversationId match first, then wildcard (`"*"`), then unhandled. Surfaces never re-check `msg.conversationId`.
- This makes surface implementations simpler and more testable — they only need to handle `text` and optional `senderId`/`senderName` decorations.

**Consequences:**

- `createPersonaAssignmentSurface` no longer guards with `if (msg.conversationId !== conversationId)` — the engine guarantees it.
- The `controlSurfaces` field in the engine is now `Map<adapterId, Map<convId, DroneControlSurface[]>>`.

## Decision 3: Adapter Owns Conversation Routing

**Decision:** The service adapter is the _only_ component that knows whether an incoming message came from a room, a DM, or the wildcard. It translates platform events into `AdapterMessage { adapterId, conversationId, text, senderId?, senderName? }` using its own conversation ID scheme.

**Rationale:**

- The Matrix adapter uses `roomId` for rooms and `dm:@peer:server` for DMs. A future Telegram adapter might use `chatId` or `@username`. The engine and control surfaces should not need to understand these schemes.
- This cleanly separates concerns: adapters handle platform-specific routing; the engine handles dispatch; surfaces handle behavior.

**Consequences:**

- The `conversationId` is opaque to the engine and surfaces — they only use it for dispatch and response routing.
- The wildcard `"*"` is a reserved conversationId that any adapter can emit (though in practice it's only used by the config loader for the `_default_.json` catch-all).

## Decision 4: Ordered Control Surface Array per Conversation

**Decision:** Each conversation file specifies an ordered array of control surface specs. The engine tries them in order (first-match-wins) for that conversation.

**Rationale:**

- This preserves the composition path for future control surfaces (4.4 swarm-console, 4.5 mention-router). A single room can have `[mention-router, persona-assignment]` — the mention router handles `!coder ...` messages, and the persona assignment handles everything else.
- The ordering is explicit in the config, making behavior predictable and debuggable.

**Consequences:**

- The `ControlSurfaceSpec` type has `type`, `personaId?`, and `config?` fields.
- The `discard` surface type is built-in: always returns `{ response: null, handled: true }`. Used for explicit "/dev/null" routing.

## Decision 5: Built-in Discard Control Surface

**Decision:** A `discard` control surface type is built into the engine. It always returns `{ response: null, handled: true }`, silently consuming messages.

**Rationale:**

- Without it, "everyone else → /dev/null" has no defined sink — unknown DMs would be silently dropped by the engine's "no surface, no wildcard → unhandled" path, which is functionally `/dev/null` but invisible and unobservable.
- A real `discard` surface makes the intent explicit and logs "dropped via discard surface" rather than "mysteriously nothing happened."
- It keeps the engine's "unhandled → drop" path reserved for genuine misconfiguration.

## Consequences

- The gateway config is now a folder hierarchy, not a single file.
- The `loadConfig` function in `index.ts` delegates to `loadGatewayConfig` in `config/load.ts`.
- The old `ServiceAdapterConfig` and `ControlSurfaceConfig` types are replaced by `ResolvedServiceAdapter` and `ControlSurfaceSpec`.
- The engine's `createAdapter` method is now `async` (uses dynamic `import()` for adapter modules).
- The Matrix adapter is the first adapter implementation, wired via `case 'matrix'` in `createAdapter`.
- The `discard` surface is available immediately for any adapter.
