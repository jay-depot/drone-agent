---
key: plan-swarm-session-param-events
tags: []
created: 2026-09-04T22:02:22.195Z
updated: 2026-09-04T22:17:12.365Z
---

# Plan: F1 — Emit session-parameter events to coordinator (APPROVED 2026-09-04)

## STATUS: COMPLETED 2026-09-04. All steps implemented, tested, committed on feat/memory-wiki-browser-improvements.

## Summary

Four session-parameter changes — persona change, focus change, macro execution, and subagent session-start — were invisible to the swarm event pipeline and absent from the readable transcript consumed by the swarm-memory ingest agent (librarian). F1 makes them first-class DroneConversationEvent kinds emitted by the plugins that own them, then surfaces them in the coordinator's readable transcript allow-list. Zero coordinator ingestion changes (swarm_events `type` is an open string).

## Confirmed decisions (Q&A)

- Q1: Distinct kinds: `personaChanged`, `focusChanged`, `macroExecuted`, `sessionStarted`.
- Q2: No correlationId → each is its own transcript "turn" / standalone line.
- Q3: Kept the persona column PATCH path (becomes "last set persona"); event additive.
- Q4: Terse transcript lines (persona changed / focus set / macro executed / session started as subagent).
- Q5: Unified API = Option A: `registration.emitEvent(event)` on DronePluginRegistration, backed by engine dispatch. Plugins own emission.
- Q5-final: A1 only — rely on accept-and-ignore on the consumer side; no probe/registry.
- Q6: Synthetic `sessionStarted` fires on every session start when isSubagent, at top of log, carrying subagentId (+ persona).

## Implementation (what was done)

1. drone-core/src/session-types.ts: added 4 kinds to DroneConversationEvent union.
2. drone-core/src/plugin-system.ts: added `emitEvent(event)` to DronePluginRegistration (required).
3. drone-agent/src/runtime/plugin-engine.ts: registration.emitEvent → dispatchConversationEvent (catch+log).
4. Emit sites:
   - persona plugin notifyChange(): emits personaChanged with from/to (tracks lastNotifiedId closure var). Column-PATCH path untouched.
   - focus plugin /focus set + clear: emits focusChanged (focus / null). show/usage no emit.
   - macros plugin: top of per-macro handler emits macroExecuted(command).
   - swarm plugin onSessionStart: when runtime.isSubagent, emits sessionStarted(subagentId, personaId).
5. drone-coordinator/src/transcript.ts: added 4 kinds to KEPT_EVENT_KINDS; ParsedEvent gained from/to/focus/command/subagentId/personaId; parseEvent extracts them; renderEvent has terse cases.

## Tests

- drone-coordinator/test/transcript.test.ts: 2 new cases (all 4 kinds render; null-aware clears + persona none->none + subagentId fallback to personaId).
- drone-agent/test/session-param-events.test.ts (new, 6 tests): swarm sessionStarted on subagent start; no sessionStarted when not subagent; event-buffer passthrough; focus set/clear focusChanged; personaChanged from/to via selectPersona.
- drone-agent/test/macros.test.ts: new macroExecuted emission test; existing stream-events test updated (macroExecuted is now the first event).

## Sweep

- Adding required `emitEvent` to DronePluginRegistration broke 29 drone-agent test registration mocks → swept all (28 via node script + memory-trigger manually). Fixed 2 misplacements from multi-line listMountedTools variants (compaction.test.ts stray inside offer body; builtin-commands.test.ts stray inside a DroneSlashCommandContext ctx object) caught by esbuild transform failures.

## Validation (all pass)

- pnpm -r run build PASS
- eslint project-wide PASS; prettier clean
- Full monorepo test: 2747 passed / 14 skipped

## Key facts learned

- `tsc -b` src-only build does NOT cover test files; the test suite (vitest/esbuild) catches syntax, not types. LSP type-checks tests but can serve stale diagnostics.
- Node-script sweeping test mocks by a tail-field anchor (listMountedTools:) is fragile for multi-line field values (e.g. `listMountedTools: () =>\n  map(...)`) — it can insert inside a sibling object. Verify transforms after a scripted sweep.
- file__apply_diff fuzz escapes `\n` as `\\n` in patch strings — verify string-literal content (macro test content must have real newlines).
