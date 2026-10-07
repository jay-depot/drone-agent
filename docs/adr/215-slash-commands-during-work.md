---
tags: [decision, slash-commands, conversation-loop, tui, queue, adr]
related: [decisions/040-message-queue-cancel.md, decisions/015-unified-slash-commands.md, decisions/198-coordinator-ui-launch-interact.md, concepts/session-management.md, flows/tool-call-loop.md, modules/drone-agent.md, modules/drone-agent-tui.md, entities/DronePlugin.md, drone-core.md]
---

# 215: Slash commands are never sent as plain text while the LLM is working

**Status**: Implemented (2026-09-11) · **Branch**: `feat/slash-commands-during-working-fix` · **Plan**: project-memory `slash-commands-during-work-fix` — *deleted from project memory after ingest*

**Summary**: A slash command typed while a turn was in flight (e.g. `/focus set clear`) was delivered to the LLM as a **plain-text steering message** instead of being executed. Two causes: the TUI's busy `onSubmit` routed any non-`/cancel` input to `enqueueUserMessage`, and the remote-steering path (`_runtime.submitUserMessage`, fed by the coordinator UI's `sendMessage(steer)`) never checked for a leading `/` at all. This ADR completes the split that [[decisions/040-message-queue-cancel]] explicitly deferred — a slash command is **never** sent as plain text, at **every** user-role entry point — and adds a plugin-supplied busy-behavior classifier, a universal `--now` escape hatch, shared subcommand/flag parsing, and one unified ordered entry queue.

## Context

[[decisions/040-message-queue-cancel]] added a message queue and soft cancel to the conversation service, and routed TUI input by `isLlmActive`. It deliberately left the read-only/immediate vs. mutating/queued distinction unimplemented: while busy, *everything* except `/cancel` became queued **text**. So a command like `/focus set clear` was appended to the session as a user utterance and sent to the model, which is both wrong (the command never ran) and confusing (the model sees command syntax as natural language).

The gap was wider than the TUI. The coordinator UI's "Send"/"Stop & Send" path reaches the agent through `_runtime.submitUserMessage` → `conversation.submitUserMessage`, which performed **no** leading-`/` check whatsoever. Any remote operator typing a command mid-turn hit the same defect, with no TUI involved.

## Decision

The locked decisions, in the user's terms:

1. **Complete the ADR 040 split; a slash command is NEVER sent as plain text.**
2. **Uniform handling at ALL user-role entry points**, enforced through the conversation-service chokepoint: TUI `onSubmit`, the readline loop, and `submitUserMessage`/remote steering.
3. **`busyBehavior?: undefined | boolean | ((invocation) => boolean)`** on `DroneSlashCommand`: `undefined`/`false` = queue (`--now` overrides); `true` = run immediately; a function receives the parsed `DroneSlashInvocation` for subcommand-aware decisions.
4. **A universal `--now` flag** overrides queue→immediate for ANY queued command, including destructive ones (`/clear --now`, `/exec --now`). It is **stripped** from the line before dispatch and never leaks into handler args. Bare `--now` only in v1.
5. **Runtime-level subcommand/flag API**: a shared `parseSlashInvocation`; opt-in `ctx.flags` / `ctx.subcommand` / `ctx.invocation`. `ctx.args` stays backward-compatible (only `--now` is stripped).
6. **Queued entries are PRESERVED on soft cancel**, matching the existing text-queue preserve policy.
7. **The command channel is a leading `/` on the whole user-role line**; a mid-utterance `/` is natural language. Agent-role output is a separate channel, untouched.
8. **`--now` is allowed universally**, including for destructive commands. `/exit` and `/quit` stay host-special (Ctrl-C remains the immediate exit).
9. **One unified ordered entry queue.** `pendingEntries: Array<{kind:'text', content} | {kind:'slash', line}>`. `enqueueUserMessage` pushes `text`; the new `enqueueSlashCommand` pushes `slash`. Arrival order is preserved across kinds, and `clearSession` flushes the whole queue. There is no separate text path — this is the single source of truth for all deferred user intent.
10. **Uniform drain timing — no mid-round absorption.** The rule is "is a turn in flight? → queue; idle? → send directly." Drain happens at exactly **two** points: (A) in a `finally` on *normal* completion, after `turnInFlight=false` and `roundComplete`; (B) at the start of the next `sendUserMessage`, before `turnInFlight=true` and before appending the new prompt.

## The own-round semantics of point A

Point A is the subtle part. At a normal completion, a queued **slash** is dispatched (awaited), but a queued **text** entry runs as its **own full round** — appended and run through the full machinery (its own `roundComplete`, `onBeforePrompt`, `onAfterToolCall` hooks) so the agent actually *answers* it. A `completedNormally` flag is set before each real-content return and is **not** set on `CANCEL_SENTINEL` or a throw; the `finally` checks it, which is what makes cancel preservation work. While entries remain and `turnInFlight` is false, draining continues — each entry drains exactly once, so it terminates.

At point B, a queued **slash** is dispatched (awaited) and a queued **text** entry is only **appended**, bundled into the upcoming round rather than given its own.

## Implementation

- `drone-core/src/plugin-system.ts` — `DroneSlashInvocation` (`{ subcommand, flags }`), `busyBehavior` on `DroneSlashCommand`, opt-in `ctx.subcommand`/`ctx.flags`/`ctx.invocation`, `ctx.conversation.enqueueSlashCommand`. `DroneSlashInvocation` exported.
- `drone-agent/src/runtime/slash-parse.ts` (new) — `parseSlashInvocation` + `stripNowFlag` (first `--now` only, whitespace-delimited). 12 unit tests.
- `drone-agent/src/runtime/plugin-engine.ts` — `classifySlashCommand(line)` returns `unknown | { kind:'command', command, behavior, invocation, strippedLine }`; the match rule is shared with `dispatchSlashCommand` via `resolveSlashCommand`. Dispatch derives args from the **stripped** line and attaches the parsed metadata.
- `drone-agent/src/runtime/conversation-service.ts` — the unified `pendingEntries` queue, the two-point drain with `completedNormally` gating, preserved-on-cancel, `clearSession` flushing both kinds, `submitUserMessage` routing leading-`/` (unknown → warn; immediate-or-idle → dispatch; busy+queue → push slash), and `setSlashCommandContext` host wiring with a bare default.
- `drone-agent/src/tui/app.tsx` + `types.ts` — busy `onSubmit` classifies instead of enqueueing-as-text; immediate → `dispatchSlashLine`; queued → the `(deferred — runs when the current task finishes)` notice + `enqueueSlashCommand`; unknown → error. Rich host context (colored logger/exit/printHelp) wired via `setSlashCommandContext` on mount.
- `drone-agent/src/runtime/builtin-commands.ts` + `drone-agent/src/plugins/*` — `busyBehavior` metadata across all 23 slash commands. Built-ins: `/exit /quit /help /plugins /tools /systemprompt` immediate; `/clear /tool /exec /debug` queue. Plugins are subcommand-aware: `focus show`, `/model` no-arg, `reasoning` no-arg, `/context`, `search-files`, `skills` non-create, `todo show`, `compact show`, `swarm-memory status`, `swarm-session list` immediate; `focus set|clear`, `persona select|create`, `skills create`, `todo add|clear`, `compact drop|force`, `swarm-memory refresh|scope`, `swarm-session import` queue; `/macro` immediate with per-macro queue; `/trust-coordinator` immediate.
- `drone-agent/src/interactive.ts` — `enqueueSlashCommand` passthrough in the host context (verify-only; the readline loop was already correct).
- `AGENTS.md` — Slash Commands section documents `busyBehavior`, the `--now` escape hatch, and deferred queue semantics.

## Notable findings en route

1. **The TUI busy-immediate branch originally cleared the busy spinner.** It called `runSlashCommand`, which toggles `isLlmActive` in a `finally` — so `/help --now` mid-turn cleared the spinner for a still-in-flight turn, and flipped the next submit into the idle branch. Fixed by extracting `dispatchSlashLine` (no indicator toggle) for busy-immediate commands.
2. **Ink TUI input tests must pace per-character above `useBracketedPaste`'s 30ms debounce.** Batching `stdin.write(line) + '\r'` concatenates (`/blocking/help`). A `typeAndSubmit` helper pacing at 40ms/char makes `onSubmit` deterministic. (This is the project's general TUI-test rule: poll for content, never race on fixed ticks.)
3. **Two pre-existing breakages were fixed en route**: `plugin-engine.test.ts` footer expectations updated for the `d829e2d` `<system-reminder>` wrap, and `submit-user-message.test.ts` updated to the v6 own-round drain semantics (queued text at point A consumes a chat call; `mockImplementationOnce` bypasses the base shift queue).

## Consequences

- Typing a command mid-turn now does what the user meant: immediate commands execute instantly; mutating commands defer with a visible notice and run at the next boundary.
- Remote steering is no longer a second, divergent code path — it shares the classifier and the queue with the TUI, so the two cannot drift.
- `--now` gives an escape hatch for the rare case where a queued command must run mid-turn, including destructive ones.
- One queue for all deferred intent means steering text and pending commands preserve relative arrival order, and a cancel does not silently discard either kind.
- The `busyBehavior` classifier is per-command metadata, so plugins own their own policy rather than the host guessing.

## Validation

All 10 steps completed. Full suite green: 209 test files passed (3 skipped), 2941 tests passed (14 skipped), 0 failures. `pnpm typecheck`, `pnpm -r run build`, and `pnpm lint` all clean; LSP clean on every touched file.

New tests: `slash-parse.test.ts` (12) and `slash-queue-conversation.test.ts` (9 — both drain points, both kinds, own-round hooks, cancel preservation, clear flush, submit routing); TUI busy-slash (3 — queued notice + enqueue, immediate dispatch with no enqueue, unknown error); `session-param-events` `/focus` classify + `--now` (3); plus a mock sweep (`classifySlashCommand`/`dispatchSlashCommand` overrides in helpers and all TUI test mocks).

**Manual TUI smoke (handed to the user)**: (a) `/focus set clear` during a long chain → deferred notice, runs after the round, focus cleared; (b) `/help` → immediate; (c) `/model --now openai/gpt-4o` → immediate mid-round; (d) `/bogus` → Unknown command; (e) ESC cancel → the queued entry still runs on the next send; (f) remote coordinator UI `/focus set clear` (steer) → dispatched, not text; (g) steering text sent mid-final-response-generation → own follow-up round, and the agent answers it.

## Related

- [[decisions/040-message-queue-cancel]] — the queue/soft-cancel foundation whose deferred split this completes
- [[decisions/015-unified-slash-commands]] — the unified slash-command registry
- [[decisions/198-coordinator-ui-launch-interact]] — the remote steering path that shares this chokepoint
- [[concepts/session-management]] — queue, drain, and cancel semantics
- [[flows/tool-call-loop]] — where drain points sit in the loop
