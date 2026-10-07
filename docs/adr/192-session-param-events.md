---
tags: [decision, drone-core, drone-agent, drone-coordinator, drone-agent-plugins, sessions, events]
related: [modules/drone-core.md, modules/drone-agent.md, modules/drone-agent-plugins.md, modules/drone-coordinator.md, entities/Session.md, flows/tool-call-loop.md, concepts/memory-pipeline.md, decisions/093-session-status-mismatch-fix.md]
---

# 192: Session-parameter events to the coordinator transcript

**Status**: Implemented (2026-09-04, branch `feat/memory-wiki-browser-improvements`, from completed plan `plan-swarm-session-param-events`)

## Context

Four session-parameter changes were invisible to the swarm event pipeline and
absent from the readable transcript consumed by the swarm-memory ingest agent
([[concepts/memory-pipeline]]): persona changes, focus-string changes, macro
executions, and subagent session starts. The librarian reading a session
transcript could not see *which* persona was active, *what* the focus was, or
*that* a macro ran — it only saw chat and tool turns.

## Decision

Make them first-class `DroneConversationEvent` kinds emitted by the plugins
that own them, and surface them in the coordinator's readable-transcript
allow-list. Zero coordinator ingestion changes (the `swarm_events.type` column
is an open string).

1. **Event kinds** (`drone-core/src/session-types.ts`):
   `personaChanged`, `focusChanged`, `macroExecuted`, `sessionStarted` join the
   `DroneConversationEvent` union.
2. **Unified emission API** (`drone-core/src/plugin-system.ts` +
   `drone-agent/src/runtime/plugin-engine.ts`): new required
   `registration.emitEvent(event)` on `DronePluginRegistration`, dispatched
   through the engine's `dispatchConversationEvent` (catch + log). Plugins own
   emission — no shared emitter registry (accept-and-ignore on the consumer
   side; a probe/registry was rejected).
3. **Emit sites** (`drone-agent/src/plugins/`):
   - `persona`: `notifyChange()` emits `personaChanged` with `from`/`to`
     (tracked via a `lastNotifiedId` closure). The persona column PATCH path
     (agent-connected updates) is untouched — it remains "last set persona".
   - `focus`: `/focus set` and `/focus clear` emit `focusChanged` with the
     focus string or `null`. `show`/`usage` emit nothing.
   - `macros`: top of each macro handler emits `macroExecuted(command)`.
   - `swarm`: `onSessionStart` emits `sessionStarted(subagentId, personaId)`
     when `runtime.isSubagent` — a synthetic event at the top of the log
     marking the session as a subagent run.
4. **Transcript surfacing** (`drone-coordinator/src/transcript.ts`): the four
   kinds join `KEPT_EVENT_KINDS`; `ParsedEvent` gains
   `from`/`to`/`focus`/`command`/`subagentId`/`personaId`; `renderEvent`
   renders them as terse lines ("persona changed: X → Y", "focus set: …",
   "focus cleared", "macro executed: /name", "session started (subagent)").

## Consequences

- The librarian's transcript now shows persona/focus context for the session
  it is summarizing, and can attribute page content to macro-driven work.
- Each event is its own transcript turn (no `correlationId` grouping) —
  deliberate; they are standalone annotations, not part of a round.
- `emitEvent` is a required registration method: adding it swept **29 test
  registration mocks** in `drone-agent/test/` (bulk-updated; two misplacements
  from multi-line field anchors were caught by esbuild transform failures).

## Tests

- `drone-coordinator/test/transcript.test.ts`: +2 (all four kinds render;
  null-aware clears, persona none→none, `subagentId` fallback to `personaId`).
- `drone-agent/test/session-param-events.test.ts` (new, 6): subagent
  `sessionStarted`, no emission when not a subagent, event-buffer passthrough,
  focus set/clear, `personaChanged` from/to via `selectPersona`.
- `drone-agent/test/macros.test.ts`: `macroExecuted` emission; existing
  stream-events test updated (it is now the first event in a macro run).

## Related

- [[concepts/memory-pipeline]] — the librarian is the consumer motivating this
- [[entities/Session]] — `DroneConversationEvent` union
- [[flows/tool-call-loop]] — event dispatch path
