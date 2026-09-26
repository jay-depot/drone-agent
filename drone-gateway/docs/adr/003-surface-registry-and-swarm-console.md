# ADR 003: Engine Surface Registry & Swarm Console Control Surface

**Status:** Accepted

**Context:** Roadmap 4.4 calls for a "Swarm Console" control surface that lets a human drive the swarm from chat. The spec (project memory `swarm-console-command-spec`) defines ~25 dot-notation commands across global, beacon, and agent namespaces. Two structural facts shaped this work:

1. The engine resolved control surface types through a hardcoded `switch` in `createControlSurface` (`engine.ts`). With only two surfaces (`persona-assignment`, `discard`) a switch was adequate; the console would be the third, and `mention-router` (4.5) is anticipated.
2. Several spec commands have no backing coordinator endpoint. The console's value is exercising the gateway, not building new coordinator features.

## Decision 1: Direct REST execution

**Decision:** The console parses the command text and calls the coordinator's REST API directly (via the `SwarmApi` interface). It never spawns an agent or invokes an LLM.

**Rationale:**

- The spec's commands map 1:1 onto endpoints the gateway already uses (`CoordinatorClient`) or trivially adds. Routing them through an LLM adds latency and nondeterminism for zero benefit — `swarm.beacon.list` must never hallucinate.
- A console is a control plane; control actions should be predictable and safe to repeat.
- No persistent agent process is needed just to run `swarm.beacon.list`, and `persona-assignment` already covers the "talk to an agent" case.

**Alternatives considered:**

- Agent-mediated (relay the command to a persona agent): rejected — latency, nondeterminism, cost.
- Hybrid (deterministic fast path + agent fallback): rejected for v1 as unnecessary scope.

## Decision 2: Dot-notation grammar with a required `swarm.` root

**Decision:** Commands use `swarm.<namespace>.<command> [args] [--flags]`. There are no `!` or `/` aliases.

**Rationale:**

- The prefix requirement enables composition: a room can configure `[swarm-console, persona-assignment]`, where console commands are handled and everything else falls through to the persona. A prefix-less surface would swallow all messages.
- The hierarchical grammar maps naturally onto an autocomplete tree for a future Web UI.

## Decision 3: Gateway-side parser over an abstract `SwarmApi`

**Decision:** The parser and command registry live in the gateway. Handlers depend on an abstract `SwarmApi` interface, not the concrete HTTP client. The console requires coordinator mode; in local mode it returns a clear error.

**Rationale:**

- Roadmap 4.4 is a _gateway_ feature. A coordinator-side "command bus" would expand scope into the coordinator and the Web UI.
- Depending on `SwarmApi` keeps a future promotion of the command layer to a server-side bus a _move_, not a rewrite.
- Local mode has no coordinator, so coordinator-scoped commands cannot work there; failing loudly is honest and cheap.

## Decision 4: v1 ships only endpoint-backed commands

**Decision:** v1 registers `swarm.help`, `swarm.broadcast`, `swarm.persona.{list,create,update,delete}`, `swarm.skill.{list,create,update,delete}`, `swarm.session.{list,get}`, `swarm.beacon.{list,status,spawn}`, and `swarm.agent.{status,terminate,inject,persona}`. Commands with no backing endpoint are omitted entirely (not stubbed) and tracked as a separate follow-up.

**Rationale:**

- Every shipped command is a thin, tested mapping onto an existing endpoint.
- Omitting un-backed commands avoids dead grammar and phantom commands; an unmatched name yields the standard "Unknown command … Try swarm.help" reply.

## Decision 5: Conversation-level `allowedSenders`, enforced by the engine

**Decision:** Authorization is an optional `allowedSenders: string[]` field on the conversation file, enforced in the engine's dispatch step (not inside surfaces). Matching is on `senderId` only. A disallowed sender is not a match for that conversation, so dispatch falls through to the wildcard. Unset means every sender is allowed.

**Rationale:**

- Authorization is orthogonal to surface behavior. ADR 002 states surfaces should only handle `text` and optional sender decorations; putting access control inside a surface violates that and would be re-implemented by every privileged surface.
- One enforcement point covers surfaces added later.
- Falling through (rather than hard-dropping) keeps the engine's dispatch semantics uniform and lets a `_default_.json` `discard` surface make the refusal observable in logs.

**Consequences:** A conversation-level gate is conversation-wide; "surface X for me, surface Y for guests" is expressed by splitting conversations (e.g. console in your DM, personas in rooms), which matches the single-user control-plane intent.

## Decision 6: Human-readable output with a `--json` escape hatch

**Decision:** Replies default to a compact markdown list (one entity per line). A global `--json` flag returns the raw coordinator payload in a fenced block. List commands pass `--limit`/`--offset` through and append an explicit `… N more (use --limit/--offset)` tail when truncated.

**Rationale:**

- The console is chat-first, so the default must be legible — but raw payloads are exactly what end-to-end testing wants. One flag provides both.
- Formatters are pure `(payload) => string`, which keeps them deterministic and unit-testable.

## Decision 7: `swarm.agent.terminate` kills the process

**Decision:** `swarm.agent.terminate <agentId>` resolves the agent's spawn and calls `DELETE /api/spawn/:beaconId/:spawnId` (which kills the process, ending the session as a side effect). Endpoint errors are surfaced verbatim. No separate session-end command in v1.

**Rationale:**

- "Terminate an agent" should stop the running process. Ending only the session record (as the coordinator UI does today) leaves the process alive and burning tokens.
- The process-kill endpoint currently has no client exercising it; the console provides that coverage.

## Decision 8: `agentId` → spawn resolution is client-side

**Decision:** Because no route maps `agentId` to a `spawnId`, `swarm.agent.terminate` lists beacons, lists each beacon's spawns, and matches on `spawn.agentId`. It does not use `GET /api/agents/location` (the `agent_locations` table may be unpopulated). Zero matches or multiple matches produce an error listing candidates.

**Rationale:**

- `agentId` is the swarm session id (`agent-<uuid>`), which is what an operator knows from session listings — not the `spawnId`.
- The scan is cheap and deterministic for a single-user swarm, and it sidesteps a latent unwired endpoint.
- Passing `DELETE`'s own `running`/`spawning` guard through as the failure reason keeps a single source of truth for "why can't this be killed".

## Decision 9: Engine-level surface registry

**Decision:** Control surface types are resolved through a `SurfaceRegistry` of `(spec, conversationId, ctx) => DroneControlSurface` factories. `persona-assignment`, `discard`, and `swarm-console` all register through it, replacing the hardcoded switch. `SurfaceContext` formalizes the dependencies a factory may receive (`spawnBackend`, optional `swarm`).

**Rationale:**

- Rule of three: a switch is fine for two surfaces; a registry is the right shape at three, with `mention-router` anticipated.
- The project has done this before at other seams (runtime-level `ToolRegistry`, structural mid-panel widget discovery).
- A `SurfaceContext` with injected dependencies is cleaner than surfaces closing over engine privates.

## Decision 10: Shell-like tokenizer

**Decision:** A pure `tokenize` function splits the line, honoring single/double quotes (unterminated quote consumes the rest) and collapsing whitespace. Flag parsing consumes a value only for flags a command declares as value flags, and only when the next token is not itself a flag.

**Rationale:**

- Free-text commands (`swarm.broadcast`, `--task`) require quoting.
- A pure function is deterministic and trivially testable, which is the point of this feature for gateway testing.

**Consequences:** `--count` was dropped from `swarm.beacon.spawn` (the endpoint spawns exactly one agent per call).

## Consequences

- The engine's surface dispatch is now data-driven; adding a surface is a `registry.register` call.
- Conversation files gain an optional `allowedSenders` field; `ResolvedServiceAdapter.conversations` now maps to `ResolvedConversation` (`{ allowedSenders?, surfaces }`).
- `CoordinatorClient` implements `SwarmApi` and gains session/persona/skill/broadcast methods.
- Commands without endpoints (`swarm.agent.focus`, `swarm.agent.interrupt`, `swarm.beacon.policy`, `swarm.session.search`, `swarm.session.delete`) are documented as a coordinator-side follow-up.
