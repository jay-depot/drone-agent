---
key: plan-swarm-session-param-events
tags:
  []
created: 2026-09-04T22:02:22.195Z
updated: 2026-09-04T22:02:22.195Z
---

# Plan: F1 — Emit session-parameter events to coordinator (APPROVED 2026-09-04)

## Summary
Four session-parameter changes — persona change, focus change, macro execution, and subagent session-start — are currently invisible to the swarm event pipeline and therefore absent from the readable transcript that the swarm-memory ingest agent (librarian) consumes. Today persona changes ride a column PATCH (only the FINAL persona lands in the transcript header), focus and macros emit no event, and subagent sessions have no start marker.

F1 makes these four changes first-class DroneConversationEvent kinds emitted by the plugins that own them, then adds them to the coordinator's readable-transcript allow-list so the ingest agent sees them — with ZERO coordinator ingestion changes (the swarm_events `type` column is an open string).

## Confirmed decisions (Q&A)
- Q1: Distinct kinds: `personaChanged`, `focusChanged`, `macroExecuted`, `sessionStarted`.
- Q2: No correlationId → each is its own transcript "turn" / standalone line.
- Q3: Keep the persona column PATCH path (becomes "last set persona"); event is additive.
- Q4: Terse transcript lines (persona changed / focus set / macro executed / session started as subagent).
- Q5: Unified runtime event-emitter API = Option A: add `registration.emitEvent(event)` to DronePluginRegistration, backed by engine dispatch. Plugins own emission.
- Q5-final: **A1 only** now — rely on already-graceful accept-and-ignore on the consumer side; NO probe/declared-kinds registry in F1.
- Q6: Synthetic `sessionStarted` fires on every session start when isSubagent, at the TOP of the log (before real events), carrying subagentId (+ persona).

## Implementation steps
### Step 1 — drone-core/src/session-types.ts: add 4 event kinds to the union
Append to DroneConversationEvent union (after `notice`, ~:214-218):
```
| { kind: 'personaChanged'; from: string | null; to: string | null }
| { kind: 'focusChanged'; focus: string | null }
| { kind: 'macroExecuted'; command: string }
| { kind: 'sessionStarted'; subagentId: string | null; personaId: string | null }
```
Add doc comments (emitted outside conversation rounds, so no correlationId).

### Step 2 — drone-core/src/plugin-system.ts: add emitEvent to DronePluginRegistration
In DronePluginRegistration (:87) add:
```
emitEvent: (event: DroneConversationEvent) => void;
```
(JSdoc: fire-and-forget; feeds same stream as conversation service + _runtime.emitEvent.)

### Step 3 — drone-agent/src/runtime/plugin-engine.ts: back registration.emitEvent with dispatch
Near hooks.onConversationEvent wiring (:595), add emitEvent closure calling dispatchConversationEvent(event) (same :373-385 path; catch+log on error, mirroring _runtime.emitEvent at :845-849).

### Step 4 — Emit sites
- 4a persona (drone-agent/src/plugins/persona/index.ts): in notifyChange() (:225-228), emit {kind:'personaChanged', from: prevId, to: activePersona?.id ?? null}. Track prior id via closure var (init null). Keep column-PATCH path untouched (Q3).
- 4b focus (drone-agent/src/plugins/focus.ts): in /focus handler (:38-86), on set → emit {kind:'focusChanged', focus}; on clear → {focus:null}. show/usage: no emit.
- 4c macros (drone-agent/src/plugins/macros/index.ts): top of per-macro handler (:57), before step loop, emit {kind:'macroExecuted', command}.
- 4d subagent session-start (drone-agent/src/plugins/swarm/index.ts): in onSessionStart (:214-220), after persona sync, request('runtime').isSubagent → emit {kind:'sessionStarted', subagentId, personaId: active?.id ?? persona}. Fires at top of session (Q6).

### Step 5 — drone-coordinator/src/transcript.ts: surface the 4 kinds
- Add to KEPT_EVENT_KINDS (:21-28): personaChanged, focusChanged, macroExecuted, sessionStarted.
- Extend ParsedEvent (:45-56) + parseEvent (:58-102) to carry new fields (generic extra map simplest).
- renderEvent (:121-152) cases:
  - personaChanged → `persona changed: {from ?? 'none'} -> {to ?? 'none'}`
  - focusChanged → `focus {set: X | cleared}`
  - macroExecuted → `macro executed: {command}`
  - sessionStarted → `session started as subagent: {subagentId ?? personaId ?? ''}`

### Step 6 — Tests
- Coordinator transcript.test.ts: each new kind renders to its Q4 line; unknown kinds still dropped.
- Agent: new tests (persona/focus/macros/swarm subagent-start) capturing emitEvent from a mock registration; follow existing plugin-registration test patterns.
- LSP / build / lint all pass.

## Validation criteria
- LSP diagnostics clean (typescript) across all new/changed files.
- pnpm -r run build passes (rebuild after drone-core change so dependents resolve new types).
- pnpm -r run lint passes (eslint + prettier).
- Coordinator + agent tests pass (new transcript + emission tests).
- Full fast suite passes: pnpm test.
- Manual: subagent start pushes sessionStarted at top; persona/focus/macro surfaces in GET /api/sessions/:id/transcript.

## Key reference facts
- DroneConversationEvent union: drone-core/src/session-types.ts:175-218.
- DronePluginRegistration: drone-core/src/plugin-system.ts:87.
- Engine dispatchConversationEvent: drone-agent/src/runtime/plugin-engine.ts:373-385.
- _runtime.emitEvent today: plugin-engine.ts:845-849 (capability via request('runtime')).
- registration.hooks.onConversationEvent wiring: plugin-engine.ts:595.
- Swarm buffer onConversationEvent: drone-agent/src/plugins/swarm/hooks.ts:293-308.
- Transcript KEPT_EVENT_KINDS: drone-coordinator/src/transcript.ts:21-28; renderEvent :121-152; parseEvent :58-102.
- Persona notifyChange: drone-agent/src/plugins/persona/index.ts:225-228, 232-250.
- Focus slash handler: drone-agent/src/plugins/focus.ts:38-86.
- Macro handler loop: drone-agent/src/plugins/macros/index.ts:51-105.
- Subagent flags: _runtime.isSubagent/subagentId (plugin-engine.ts:837-839); cli --subagent-id / DRONE_SUBAGENT_ID (cli.ts:143-144,232).
- Swarm onSessionStart (persona sync): drone-agent/src/plugins/swarm/index.ts:214-220.