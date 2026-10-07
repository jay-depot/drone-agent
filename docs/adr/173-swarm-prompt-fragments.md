---
tags: [decision, swarm, beacon, coordinator, prompt-fragments, websocket]
related: [architecture/swarm-architecture.md, concepts/scope-hierarchy.md, decisions/151-memory-pipeline-infra.md, modules/drone-beacon.md]
---

# 173: Swarm prompt fragments (beacon/coordinator → agent system prompts)

**Status**: Implemented (2026-08-29)

## Context

Operators needed a way to inject standing content — maintenance banners, task
directives, and later machine-authored context (e.g. a RAG pipeline) — into the
system prompts of running agent sessions, either to one specific session
(targeted) or to all sessions (broadcast). Existing mechanisms were all wrong
for standing content: `RuntimeFlagRegistry` is flat KV rendered as short
`key: value` lines, `SystemReminderQueue` is one-shot non-persisted and 8-max,
and fire-and-forget WS messages vanish on reconnect. Personas/skills are
addressed per-identity rather than per-session-content.

## Decision

Fragments are **stored, addressed DB assets** (not pushes): keyed upsert by a
caller-chosen stable `(id, target)` pair, idempotent replace, TTL backstop for
orphans, and a live current-set broadcast model with a hard count/payload cap.
REST is the source of truth; WS push + full-state resync is a delivery
optimization, so there is no ack protocol — resync is the ack.

### Asset model

`DroneSwarmFragment` (`drone-core/src/swarm-fragment-types.ts`): `{ id, target,
content, phase: 'header'|'footer', scope: 'local'|'coordinator', createdAt,
updatedAt, expiresAt: number|null }`. Ids must match `^[a-zA-Z0-9:_-]+$`
(URL-safe and prompt-display-safe — ids are rendered into the prompt as
`## [<id>]` so the model can reference them). The beacon's `fragments` table
uses PK `(id, target)` so one id can exist simultaneously as a targeted row and
a broadcast (the CLI's `--target` disambiguates; ambiguous deletes are 400
unless `?target=` is given).

### Targeting

`target` is an `agentId` (== swarm sessionId; spawner persists
`spawns.agent_id`, so spawned agents have stable ids) or the reserved sentinel
`broadcast`. Unknown agentIds are **accept-and-queue** (200) — the row is
served when that agent connects (WS connect requires registration, so
`POST /agents` remains the gate; `POST /agents` rejects registering the
reserved `broadcast` sentinel as an agentId). Targeted rows default to a 24h
TTL unless explicit `expiresAt`; broadcasts never expire by default (the
persistent-swarm-banner use case) but are capped at 5 rows and 16 KB content
per beacon. A 60s TTL sweep deletes expired rows and pushes removals to
connected agents.

### Dual-fragment render seam

The agent's swarm plugin registers **two** prompt fragments —
`swarm.fragments.header` (header phase, renders `# Swarm Fragments`) and
`swarm.fragments.footer` (footer phase, renders `# Swarm Directives`) —
instead of one "connector" fragment that would have to decide per-round where
content belongs. `render()` reads an in-memory Map only (no network in the
render path); `false` when the bucket is empty. Fragments are registered
unconditionally at registration time so prompt output is stable whether or not
the beacon is reachable.

### Delivery

Beacon→agent WS messages (no client→server protocol changes):

- `fragmentSync` on every connect (after unread replay): the full merged
  current set — TTL-filtered targeted-for-agent + broadcast rows, with
  coordinator-scoped rows shadowing beacon rows of the same id. Full-state
  resync makes reconnects converge without acks.
- `fragment` `{op: 'set'|'remove'}` for targeted deltas (only to connected
  agents); broadcast upserts/deletes fan out `fragmentSync` to all agents
  (≤5 rows keeps payloads tiny).
- A `fragmentAck` message type is reserved as a no-op for forward
  compatibility.

### Coordinator scope (rework scaffolding)

The coordinator stores fragments (same table shape) and serves read-only
`GET /api/fragments`; the beacon pulls it on the persona-precedence sync
interval (5 min default), stores rows as `scope='coordinator'` (which shadow
beacon rows of the same id), and fans out a resync on merged-content hash
change. This sync-hop is deliberately throwaway — the coming persistent-WS
rework moves coordinator authoring/push to a reverse channel with no
agent-side changes.

### Observability

Reuses the existing `notice` event kind (no new theme/TUI work). Static
plugins can't emit events, so the plan added additive `_runtime.emitEvent`
(ADR-170 `_runtime.debugFlags` precedent) implemented as fire-and-forget
dispatch through the engine's existing conversation-event hook list.
One notice per fragment op; the initial resync after connect is silent
(guarded by a `fragmentsResynced` flag) to avoid replay noise.

### CLI surface

`drone-swarm fragments list|set|delete` (list works against beacon +
coordinator; set/delete beacon-only). Agent-side authoring tool deferred.

### Security trade-off (explicit)

Fragment content is prompt injection by design: whoever can reach the beacon's
write API controls agent prompts. Accepted for the single-user swarm; the
beacon binds localhost/LAN by default, WS connections are gated by
`isLocalConnection`, and coordinator trust requires careful TOFU. Documented
before release in `docs/agents/swarm-plugin.md`.

## Key Points

- Stored addressed assets, keyed `(id, target)` upsert; no replacement sets,
  acks, or agent tool in v1.
- Two prompt seams; render reads memory only; ids model-visible (`## [<id>]`).
- `fragmentSync` full-state resync + targeted `fragment` deltas; broadcast ops
  resync everyone; TTL sweep pushes removals.
- Coordinator mirror via sync-interval pull is scaffolding for the
  persistent-WS rework.
- Limits: 5 broadcasts, 50 targeted/agent, 16 KB content, 24h targeted TTL,
  60s sweep (provisional constants, per user).
- `fragmentAck` reserved no-op for forward compatibility.

## Related

- [[concepts/swarm-prompt-fragments]] — the concept page
- [[modules/drone-beacon]] — beacon REST/WS server
- [[architecture/swarm-architecture]] — swarm connection flow
- [[concepts/session-management]] — where prompt fragments render per round