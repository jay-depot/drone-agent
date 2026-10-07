---
tags: [decision, slash-commands, conversation-loop, steering, tui, adr]
related: [decisions/215-slash-commands-during-work.md, decisions/040-message-queue-cancel.md, decisions/198-coordinator-ui-launch-interact.md, decisions/208-beancounter-usage-cost-widget.md, concepts/session-management.md, flows/tool-call-loop.md, modules/drone-agent.md, modules/drone-agent-tui.md, modules/drone-core.md, modules/drone-coordinator.md]
---

# 217: `/steer` and `/btw` built-in slash commands

**Status**: Implemented (2026-09-19) · **Branch**: `feat/btw-and-steer-commands` · **Plan**: project-memory `plan-steer-and-btw-slash-commands` — *deleted from project memory after ingest*

**Summary**: Two new built-in slash commands, both `busyBehavior: true`. **`/steer <message>`** injects a message as a user turn into the **currently in-flight** round at the next tool-loop boundary — the opt-in restoration of the mid-round absorption that [215-slash-commands-during-work](215-slash-commands-during-work.md) deliberately removed for plain text. (Because the new queue always turns mid-turn text into its *own later round*, live steering needs its own explicit command.) When no turn is in flight it degrades to an ordinary round. **`/btw <question>`** asks an **ephemeral side question**: it re-assembles the current context into a throwaway copy, sends it to the LLM with **no tools**, displays the answer, and discards the copy — session history is never touched. It surfaces as one new `aside` conversation event that renders in the TUI and is recorded in the coordinator's readable transcript.

## Context

[215-slash-commands-during-work](215-slash-commands-during-work.md) unified all deferred user intent into one ordered `pendingEntries` queue drained at exactly two round boundaries, and **deleted mid-round absorption** (the ADR 040 boundary-2). That made queued text correct and predictable, but it removed any way to influence a round *while it runs*: a message typed mid-turn now becomes its own later round, never reaching the in-flight model.

The project's own vocabulary never dropped steering, though. `drone-agent/CONTEXT.md` still defines a **Round** as containing "zero or more user steering message turns," and the swarm memory pipeline's `ConversationWindowTracker` still classifies a late `userMessage` in the same round as a `steering[]` turn. The mechanism was gone; the language remained. There was also no way to ask a question *about* the current context without it becoming part of the conversation.

## Decision

The locked decisions (17, from a grilling session), in the user's terms:

1. **`/steer` = opt-in mid-round injection** — not soft-cancel-then-send, not a plain-text alias. It restores ADR 040's absorption, but only when the user explicitly asks.
2. **`/btw` context = header system messages + session turns + footer system messages**, re-assembled; transient per-call nudges and drained reminders are **excluded**.
3. **`/btw` passes ZERO tools.** Tool-referencing prose in the context is kept verbatim (it is context, and often the answer); a one-line framing ("SIDE QUESTION … answer in prose; no tools") is prepended to the question.
4. **`/btw` surfaces via one new event kind** `{ kind: 'aside', question, answer }`.
5. **Full audit trail**: `aside` is added to the coordinator transcript's `KEPT_EVENT_KINDS` and rendered as `[aside Q]` / `[aside A]` (question and answer only).
6. **`/steer` uses a dedicated `steeringMessages: string[]` buffer**, separate from `pendingEntries`, drained at the loop top after the soft-cancel check and before `getLlmTools()`; each absorbed message appends a user turn and emits `userMessage`.
7. **Late/un-absorbed steers are discarded** at round end with a `[steering: discarded late steering message: "<msg>"]` notice.
8. **All queued steering messages drain per boundary, in order.**
9. **A successful injection emits `[steering: <msg>]`** — moved to *absorption* time (see findings) so it never contradicts the discard notice.
10. **`steerMessage()` owns both the busy/idle decision and the lifecycle hooks** (idle path runs `onBeforePrompt` → `sendUserMessage` → `onAfterToolCall`).
11. **Mid-round injection resets the degeneracy guards but NOT `iterationCount`** — a steer can break a loop, but cannot extend the tool-call depth safety limit.
12. **`/btw` runs immediately and concurrently with an in-flight turn**; the TUI `aside` render is an immediately-**committed** scrollback entry (never a tail item).
13. **`/btw` uses the active provider/model and inherits the session reasoning level** — no new model role.
14. **`/btw` runs `prepareRequestMessages` only** and **skips `describeUndescribedImages`** (that step mutates shared image state and spends extra LLM calls, and this call can run concurrently with the main loop).
15. **`aside` carries `{question, answer}` only** — no reasoning field.
16. **Both commands are built-ins**, parsing the rest of the line via `ctx.line.slice('/cmd '.length).trim()`.
17. **Both service methods are wired into all three slash-command context builders** (TUI, bare, readline).

### Accepted caveats

- A `/steer` or `/btw` message that legitimately contains the standalone token `--now` has it stripped — the universal-flag footgun every rest-of-line command shares (deferred fix).
- `conversation-service.ts` is now ~1700 lines (pre-existing over the size rule; the split remains a separate follow-up).

## Implementation

- **`drone-core/src/session-types.ts`** — new `DroneConversationEvent` member `{ kind: 'aside'; question: string; answer: string }`.
- **`drone-core/src/plugin-system.ts`** — two optional members on the slash-command `conversation` surface: `steerMessage?: (content: string) => Promise<void>` and `askAside?: (question: string) => Promise<string>` (optional, mirroring `enqueueUserMessage?`).
- **`drone-agent/src/runtime/aside.ts`** (new) — pure module: `ASIDE_FRAMING` (the "no tools" line) + `buildAsideMessages({header, sessionMessages, footer, question})` ordering header → session → footer → framed question.
- **`drone-agent/src/runtime/conversation-service.ts`** — a `steeringMessages: string[]` buffer; a loop-top absorption block (after the soft-cancel check, before `getLlmTools()`) that shifts each entry, appends a user turn, emits `userMessage`, emits the `[steering: <msg>]` notice, and resets the six degeneracy-guard flags; a `finally` discard that emits the late-steer notice for anything left; `clearSession` now flushes `steeringMessages`; the `steerMessage`/`askAside` implementations; a shared `resolveEffectiveReasoningLevel(providerId, model)` helper (used by both the main loop and `askAside`); and the bare-context builder gains both methods.
- **`drone-agent/src/runtime/builtin-commands.ts`** — `steerCommand` and `btwCommand` appended to `BUILT_IN_SLASH_COMMANDS`.
- **`drone-agent/src/tui/types.ts`** — `ChatEntry['kind']` gains `'aside'`; `DroneTuiOptions.conversation` lists `steerMessage?`/`askAside?`.
- **`drone-agent/src/tui/components/ChatLog.tsx`** — an `aside` render case (`💬 btw` header + text).
- **`drone-agent/src/tui/app.tsx`** — the global `onConversationEvent` switch gains an `aside` case that commits immediately via `appendFn` (no tail item, so it cannot collide with a streaming main reply).
- **`drone-agent/src/output-handlers.ts`** — `OutputEvent` gains the `aside` member; the plain handler gains an `aside` case.
- **`drone-agent/src/interactive.ts`** — readline context wires `steerMessage`/`askAside`; `runSwarmListenMode`'s NDJSON listener gains an `aside` case.
- **`drone-coordinator/src/transcript.ts`** — `'aside'` added to `KEPT_EVENT_KINDS`; `parseEvent` extracts `question`/`answer`; `renderEvent` returns `[aside Q] …` / `[aside A] …`.
- **`AGENTS.md`** — Slash Commands section documents both commands, the two notices, and the `--now` caveat.

## Notable findings en route

1. **A review pass caught two blockers before commit.** (a) The new test file passed *partial* conversation literals to its helper, which fails `tsc -p tsconfig.test.json` while `pnpm test` (vitest/esbuild) stays green — vitest does not typecheck tests. (b) A failed `/btw`, or an idle `/steer`, could take down the process: the slash handlers `await` the promise, `engine.dispatchSlashCommand` has no try/catch, and the TUI's busy branch calls it with `void` — so a routine 429/500 became an unhandled rejection (Node default `--unhandled-rejections=throw` terminates). Both service methods now catch and emit an `error` event instead of throwing.
2. **The success notice originally lied.** It fired at *enqueue* time, so a late steer printed `[steering: foo]` immediately followed by `[steering: discarded late steering message: "foo"]`. Moved to absorption time.
3. **`/btw` initially bypassed the configured reasoning level.** It passed the raw session variable, while the main loop resolves `reasoningLevel ?? resolveConfiguredReasoningLevel(config, selection)`. Extracted `resolveEffectiveReasoningLevel` and reused it in both places.
4. **`file__apply_diff` silently no-op'd several hunks** (reported `patched: true`, did not apply) — four times, plus one tail-fragment corruption in `transcript.ts`. Every apply must be verified with a read-back plus a typecheck/test run; a silent no-op left `parseEvent`'s `question`/`answer` extraction missing until a failing unit test caught it.
5. **`pnpm lint` reformats unrelated files** (its `lint:prettier` step is `prettier --write .`). The run rewrote `pnpm-lock.yaml` (a 5,863-line churn from prettier style drift), two unrelated test files, and unrelated `.drone-agent` memory/insight files — all reverted with `git checkout --` before the feature commit. Use `npx prettier --check <paths>` to verify formatting without side effects.

## Consequences

- Steering is back, but strictly opt-in: plain mid-turn text still becomes its own later round (ADR 215 semantics preserved), and `/steer` is the explicit lever for influencing the live round.
- `/steer` interacts sanely with the guardrails — it clears the degeneracy streaks (so it can break a loop) while leaving the tool-call depth limit intact (so it cannot hold a runaway round open forever).
- `/btw` adds a question channel that costs session history nothing, while still leaving an audit trail: the `aside` event is rendered in the TUI and recorded in the coordinator transcript, but is **ignored by the round-window tracker and the wakelock** (they react only to `userMessage`/`roundComplete`, which `aside` never emits) and never enters session history.
- Because `aside` is in `KEPT_EVENT_KINDS`, it also flows into the swarm-memory ingest — a librarian may learn from asides, which is intentional.
- Nits accepted as-is: an idle `/btw` shares the previous round's `correlationId` in the transcript (it never fires `onBeforePrompt`); its event flushes with the next tool round; `runJsonListenMode`'s per-call handler omits `aside` (unreachable there — adding it would be dead code); `askAside` sends without a budget guard.

## Validation

- **Static**: `pnpm -r run build` exit 0; `pnpm lint` (root, canonical) exit 0; `npx tsc -p tsconfig.test.json` exit 0; LSP clean on every touched file (the 8 pre-existing `drone-beacon/test/wiki-indexer.test.ts` `wordCount`/`linkCount` errors were stale-`dist` and cleared by the build).
- **Tests**: `pnpm test` **3079 passed / 14 skipped / 0 failed** (219 files passed, 3 skipped). New: `aside.test.ts` (3), `slash-steer-btw.test.ts` (8), `conversation-service-steering.test.ts` (10 — busy vs idle, boundary absorption, guard-reset, depth-limit-unaffected, discard-on-cancel **and** discard-on-normal-completion, `clearSession` flush, tool-less single call, history-untouched, concurrency), `tui-aside.test.tsx` (2), plus `output-handlers.test.ts` (+1) and `transcript.test.ts` (+2).
- **Manual TUI smoke** (handed to the user): mid-round `/steer`, late `/steer` (discard notice), idle `/steer`, `/btw` leaving history untouched, and the `--now`-in-message caveat.

## Related

- [215-slash-commands-during-work](215-slash-commands-during-work.md) — the queue that removed mid-round absorption and made `/steer` necessary as an explicit opt-in
- [040-message-queue-cancel](040-message-queue-cancel.md) — the original queue/soft-cancel design whose mid-round absorption `/steer` restores
- [198-coordinator-ui-launch-interact](198-coordinator-ui-launch-interact.md) — the remote `submitUserMessage`/steering path that shares this chokepoint
- [208-beancounter-usage-cost-widget](208-beancounter-usage-cost-widget.md) — the other `busyBehavior`-true, event-driven built-in of the same vintage
- session-management — queue, drain, steering, and guard semantics
- tool-call-loop — where the steering absorption sits in the loop
- [drone-core](../../drone-core/) — the `aside` event + slash-context surface
- [drone-coordinator](../../drone-coordinator/) — the transcript rendering
- [drone-agent-tui](../../drone-agent/src/tui/) — the `aside` scrollback entry
