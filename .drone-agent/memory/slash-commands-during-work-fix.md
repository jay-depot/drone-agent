---
key: slash-commands-during-work-fix
tags:
  - conversation-loop
  - slash-commands
  - plan
  - adr-040
created: 2026-09-11T18:12:50.140Z
updated: 2026-09-11T19:01:45.360Z
---

# EXECUTED 2026-09-11 — completion summary (appended)

All 10 steps completed on `feat/slash-commands-during-working-fix`. Full suite green:
209 test files passed (3 skipped), 2941 tests passed (14 skipped), 0 failures; `pnpm
typecheck`, `pnpm -r run build`, and `pnpm lint` all clean; LSP clean on every touched file.

### What landed
1. **drone-core** — `DroneSlashInvocation` (`{ subcommand, flags }`), `busyBehavior?:
   boolean | ((inv) => boolean)` on `DroneSlashCommand`, opt-in `ctx.subcommand/flags/
   invocation`, `ctx.conversation.enqueueSlashCommand`. Exported `DroneSlashInvocation`.
2. **slash-parse.ts** (new runtime util) — `parseSlashInvocation` + `stripNowFlag`
   (first `--now` only, whitespace-delimited). 12 unit tests.
3. **plugin-engine** — `classifySlashCommand(line)` returns unknown | { command, behavior,
   invocation, strippedLine }; match rule shared with `dispatchSlashCommand` via
   `resolveSlashCommand`; dispatch derives args from the STRIPPED line and attaches
   parsed metadata. `--now` → immediate universally and never leaks into args.
4. **conversation-service** — unified `pendingEntries` queue (`{kind:'text'}|{kind:'slash'}`),
   two-point drain (A: finally on normal completion — slash dispatch / text own-full-round;
   B: start of next send — slash dispatch / text append-only), `completedNormally` gating,
   preserved-on-cancel, `clearSession` flushes both kinds, `submitUserMessage` routes
   leading-`/` (unknown→warn, immediate-or-idle→dispatch, busy+queue→push slash),
   `setSlashCommandContext` host-wiring with bare default.
5. **TUI** — busy `onSubmit` classifies instead of enqueueing-as-text; immediate →
   `dispatchSlashLine` (NO isLlmActive toggle — fixes a real bug where `/help --now` mid-turn
   cleared the busy spinner); queued → `(deferred — runs when the current task finishes)`
   notice + `enqueueSlashCommand`; unknown → error. Rich host ctx (colored logger/exit/
   printHelp) wired via `setSlashCommandContext` on mount.
6. **busyBehavior metadata** — all 23 slash commands: builtins immediate (`/exit /quit /help
   /plugins /tools /systemprompt`) / queue (`/clear /tool /exec /debug`); plugins subcommand-
   aware (focus show/model no-arg/reasoning no-arg/context/search-files/skills-non-create/
   todo show/compact show/swarm-memory status/swarm-session list immediate; focus set|clear/
   persona select|create/skills create/todo add|clear/compact drop|force/swarm-memory
   refresh|scope/swarm-session import queue; `/macro` immediate, per-macro queue;
   `/trust-coordinator` immediate).
7. **interactive.ts** — `enqueueSlashCommand` passthrough in the host ctx (verify-only).
8. **Tests** — new `slash-parse.test.ts` (12) + `slash-queue-conversation.test.ts` (9,
   both drain points / both kinds / own-round hooks / cancel preservation / clear flush /
   submit routing); TUI busy-slash (3: queued notice+enqueue, immediate dispatch no-enqueue,
   unknown error); session-param-events `/focus` classify + `--now` (3); mock sweep
   (helpers `classifySlashCommand`/`dispatchSlashCommand` overrides + all TUI test mocks).
   Two pre-existing breakages fixed en route: `plugin-engine.test.ts` footer expectations
   updated for the d829e2d `<system-reminder>` wrap, and `submit-user-message.test.ts`
   updated to v6 own-round drain semantics (queued text at point A consumes a chat call;
   mockImplementationOnce bypasses the base shift queue).
9. **Docs** — AGENTS.md Slash Commands: `busyBehavior`, `--now` escape hatch, deferred queue
   semantics.

### Notable findings
- The TUI busy-immediate branch originally called `runSlashCommand`, which toggles
  `isLlmActive` in a finally — clearing the busy spinner for a genuine in-flight turn and
  flipping the next submit back to the idle branch. Extracted `dispatchSlashLine`
  (no indicator toggle) for busy-immediate commands.
- Ink TUI input tests must pace per-character above `useBracketedPaste`'s 30ms debounce
  (batch `stdin.write(line)+\r` concatenates `/blocking/help`); a `typeAndSubmit` helper
  pacing at 40ms/char makes `onSubmit` deterministic.

# Plan: Slash Commands During Work — complete the ADR 040 immediate/queued split (uniform)

## Summary & why

A slash command typed while the LLM is working (e.g. `/focus set clear`) is delivered as a
plain-text steering message instead of being executed. Root cause: (1) TUI `onSubmit` routes
any non-`/cancel` input to `enqueueUserMessage` while busy — ADR 040 (commit 5e9e263)
explicitly deferred the read-only/immediate split; (2) the remote steering path
(`_runtime.submitUserMessage` → `conversation.submitUserMessage`, fed by the coordinator UI
`sendMessage(steer)`) never checks leading `/` at all. Fix: finish ADR 040 — uniform command
channel at every user-role entry point, plugin-supplied busy-behavior classifier, universal
`--now` escape hatch, shared subcommand/flag parsing, unified ordered entries queue, and
uniform drain timing for BOTH text and slash entries.

## Locked design decisions (user-confirmed)

1. Complete ADR 040 split; a slash command is NEVER sent as plain text.
2. UNIFORM handling at ALL user-role entry points via the conversation-service chokepoint
   (TUI onSubmit, readline already, submitUserMessage/remote steering).
3. `busyBehavior?: undefined | boolean | ((inv) => boolean)` on DroneSlashCommand:
   undefined/false = queue (--now overrides); true = immediate; fn = subcommand-aware.
4. Universal `--now` flag overrides queue→immediate for ANY queued command; STRIPPED from the
   line before dispatch (never leaks into handler args). Bare `--now` only in v1.
5. Runtime-level subcommand/flag API: shared `parseSlashInvocation`; `ctx.flags`/`ctx.subcommand`
   /`ctx.invocation` opt-in; `ctx.args` stays backward-compatible (only `--now` stripped).
6. Queued entries PRESERVED on soft cancel (matches text-queue preserve policy).
7. Command channel = leading `/` on the WHOLE user-role line; mid-utterance `/` is natural
   language (matches readline/TUI-idle today). Agent-role output is a separate channel, untouched.
8. --now allowed universally incl. destructive (/clear --now, /exec --now). /exit /quit stay
   host-special (Ctrl-C is the immediate exit).
9. UNIFIED ORDERED ENTRIES QUEUE (v6): `pendingEntries: Array<{kind:'text', content} |
{kind:'slash', line}>`. enqueueUserMessage → {kind:'text'}; enqueueSlashCommand (new) →
   {kind:'slash'}. ONE queue — arrival order preserved across kinds. clearSession flushes.
   NO separate text path. This is the single source of truth for ALL deferred user intent —
   steering text that doesn't land in time drains from the SAME queue as pending slash commands.
10. UNIFORM DRAIN TIMING (v6) — NO mid-round absorption (drops ADR 040 boundary-2 for text):
    Rule = "is a turn in flight?" → queue; "idle?" → send directly. Drain at exactly TWO points:
    A. finally on NORMAL completion (after turnInFlight=false + roundComplete):
    slash → dispatch (awaited); text → run as its OWN full round (append + full machinery
    - own roundComplete + onBeforePrompt/onAfterToolCall hooks) so the agent ANSWERS it.
      B. start of next sendUserMessage, BEFORE turnInFlight=true and before appending the new
      prompt: slash → dispatch (awaited); text → APPEND only (bundled into upcoming round).
      NOT drained on cancel/throw (preserved per Q6). completedNormally flag set before each
      real-content return; NOT set on CANCEL_SENTINEL/throws; finally checks it.
      While entries remain and turnInFlight false → keep draining (terminates; each drained once).

## Some implementation details

- submitUserMessage(content): leading-`/` + known → classify: unknown → logger.warn + return '';
  immediate-or-idle → dispatch(strippedLine) + return ''; busy+queue → push {kind:'slash'}. Text →
  idle: send now; busy: push {kind:'text'}. Inside submitChain serialization (atomic).
- TUI busy branch (onSubmit): /cancel unchanged; startsWith('/') → classify: immediate (incl
  --now) → dispatchSlashLine WITHOUT toggling isLlmActive; queued → log notice `"<cmd> (deferred
— runs when the current task finishes)"` + enqueueSlashCommand; unknown → error. Plain text →
  enqueueUserMessage (unchanged).
- Host dispatch ctx: createConversationService gains optional slashCommandContext builder; TUI
  supplies colored-logger/exit/printHelp ctx on mount; default bare ctx (own logger, no exit/printHelp).
- engine.classifySlashCommand(line) → { kind:'unknown' } | { kind:'command', command, behavior,
  invocation, strippedLine } (match rule same as dispatch; --now overrides → immediate).
- dispatchSlashCommand: derive args from STRIPPED line; attach ctx.flags/subcommand/invocation.

## Files map

- drone-core/src/plugin-system.ts — types (DroneSlashInvocation, busyBehavior, ctx.flags/
  subcommand/invocation)
- drone-agent/src/runtime/slash-parse.ts (new) — parseSlashInvocation, stripNowFlag
- drone-agent/src/runtime/plugin-engine.ts — classifySlashCommand + dispatch upgrade
- drone-agent/src/runtime/conversation-service.ts — unified queue + two-point drain + own-round
  follow-ups + submitUserMessage routing (+ internal onBeforePrompt/onAfterToolCall for own rounds)
- drone-agent/src/tui/{app.tsx,types.ts} — busy routing + host ctx wiring
- drone-agent/src/runtime/builtin-commands.ts — busyBehavior metadata (exit/quit/help/plugins/
  tools/systemprompt → immediate; clear/tool/exec/debug → queue)
- drone-agent/src/plugins/* — busyBehavior (focus: show immediate, set/clear queue; persona;
  llm /model no-arg immediate; macros /macro mgmt immediate, per-macro queue; search-files
  immediate; todo/skills/compaction/swarm-* read-only subcommands immediate)
- interactive.ts — verify only (+ enqueueSlashCommand passthrough in ctx shape)
- swarm websocket + coordinator UI — no change (already via submitUserMessage)

## Steps

1. drone-core types (build after)
2. slash-parse.ts + unit tests
3. engine classifySlashCommand + dispatch upgrade
4. conversation-service unified queue/timing/submitUserMessage routing
5. TUI wiring (types, app, host ctx)
6. busyBehavior metadata (built-ins + plugins)
7. other hosts verify (interactive.ts passthrough)
8. tests: slash-parse; conversation-service (both drain points, both kinds, own-round hooks,
   preserved-on-cancel, clearSession flush, submit routing, roundComplete per follow-up round);
   tui (busy slash queue + notice, busy /help immediate no spinner clear, unknown error);
   session-param-events (/focus classify + --now); sweep engine/conversation/context mocks
9. docs (AGENTS.md Slash Commands: --now + busyBehavior)
10. FINAL validation (see criteria)

## Validation criteria

- LSP clean (zero errors/warnings) after `pnpm -r run build` (drone-core dist current).
- `pnpm -r run lint` zero errors; `pnpm -r run build` zero errors; `pnpm -r run test` (fast)
  passes incl. new tests. No dead code/unused vars; all new code unit-tested.
- Manual TUI smoke: (a) /focus set clear during long chain → deferred notice, runs after round,
  focus cleared; (b) /help → immediate; (c) /model --now openai/gpt-4o → immediate mid-round;
  (d) /bogus → Unknown command; (e) ESC cancel → queued entry still runs on next send;
  (f) remote coordinator UI /focus set clear (steer) → dispatched, not text; (g) steering text
  sent mid-final-response-generation → own follow-up round, agent answers it.
