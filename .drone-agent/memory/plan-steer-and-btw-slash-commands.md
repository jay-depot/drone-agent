---
key: plan-steer-and-btw-slash-commands
tags:
  - plan
  - slash-commands
  - conversation-loop
  - steering
  - drone-agent
  - drone-core
  - drone-coordinator
created: 2026-09-19T20:33:30.355Z
updated: 2026-09-19T20:33:30.355Z
---

# Plan: `/steer` and `/btw` Slash Commands

## Summary

Add two built-in slash commands to `drone-agent`:

| Command | Behaviour |
| --- | --- |
| `/steer <message>` | Opt-in **mid-round injection**. Inserts a user-role turn into the *currently in-flight* round at the next tool-loop boundary. This re-introduces the ADR-040 "mid-round absorption" that ADR 215 deliberately removed, but only when the user **explicitly** asks for it. When no turn is in flight, it degrades to a normal round. |
| `/btw <question>` | **Ephemeral side-query**. Appends the question to a throwaway copy of the assembled context, calls the LLM **once with no tools**, displays the answer, and discards the copy. The main session history is never mutated. |

Both are built-ins (`runtime/builtin-commands.ts`), both `busyBehavior: true`, both take the rest of the line as free text.

## Why

ADR 215 / PR #106 unified deferred user intent into one ordered `pendingEntries` queue drained at exactly two round boundaries, and **deleted mid-round absorption**. That made queued text correct and predictable, but removed any way to influence a round *while it runs*. `CONTEXT.md` still defines a Round as containing "zero or more user steering message turns", and the `ConversationWindowTracker` still classifies such turns — the vocabulary survived, the mechanism did not.

- `/steer` restores steering as an explicit, opt-in control (a *consequence of the new queuing logic*: because plain text now always becomes its own later round, steering needs its own command).
- `/btw` adds a question channel that costs the transcript nothing: the answer is available, the history is untouched, and an audit trail survives in swarm memory.

## Locked decisions (grilling, 17 questions)

1. `/steer` = opt-in mid-round injection (not soft-cancel-then-send, not a plain-text alias).
2. `/btw` context = header system messages + session turns + footer system messages, re-assembled; **exclude** transient per-call nudges/reminders.
3. `/btw` passes **zero tools**; tool-referencing prose in the context is kept verbatim (it is context, and frequently the answer); one framing line is prepended to the question.
4. `/btw` surfaces via **one new event kind** `{ kind: 'aside', question, answer }`.
5. Full audit trail: `aside` is added to the coordinator transcript (`KEPT_EVENT_KINDS` + `renderEvent`), rendering **only** the question and the answer.
6. `/steer` uses a dedicated `steeringMessages: string[]` queue, separate from `pendingEntries`, drained at the loop top after the soft-cancel check; each injected message appends a user turn and emits `userMessage`.
7. Late/un-injected steering messages are **discarded** at round end with a `notice`: `[steering: discarded late steering message: "<msg>"]`.
8. All queued steering messages drain per boundary, in order.
9. A successful mid-round injection emits `[steering: <msg>]` as a `notice`.
10. `steerMessage()` owns the busy/idle decision **and** the lifecycle hooks.
11. Mid-round injection **resets the degeneracy guards** but **not** `iterationCount`.
12. `/btw` runs immediately and concurrently with an in-flight turn; its TUI render is an immediately-committed scrollback entry (never a tail item).
13. `/btw` uses the active provider/model and inherits the session reasoning level; **no new model role**.
14. `/btw` runs `prepareRequestMessages` only and **skips** `describeUndescribedImages`.
15. The `aside` event carries `{ question, answer }` only — no reasoning.
16. Both commands are built-ins; parsing is rest-of-line (`ctx.line.slice(...)`).
17. `steerMessage` + `askAside` are wired into **all three** slash-command context builders (TUI, bare, readline).

### Accepted caveats (documented, fix later)
- A `/steer` message that legitimately contains the token `--now` has it stripped (the universal flag's pre-existing footgun for every rest-of-line command).
- `conversation-service.ts` is 1540 lines — already over the 1000-line rule. This plan avoids worsening it by extracting the pure aside helper into a new module; a dedicated split remains a separate follow-up.

---

## Implementation steps

Steps are atomic and grouped by phase. `agent` is the drone persona that should execute the step.

### Phase 1 — drone-core types

**Step 1 — Add the `aside` conversation event** — agent: `code` — depends on: none
- File: `drone-core/src/session-types.ts`
- Add to the `DroneConversationEvent` union:
```ts
  /** A `/btw` side-query: an ephemeral question answered against a copy of the
   * current context. Never part of session history; carries no correlation
   * semantics of its own. */
  | { kind: 'aside'; question: string; answer: string }
```
- Run `pnpm --dir drone-core run build` (dependents resolve drone-core from `dist/`).

**Step 2 — Extend the slash-command `conversation` context type** — agent: `code` — depends on: none
- File: `drone-core/src/plugin-system.ts` (the `conversation?` sub-object of `DroneSlashCommandContext`)
- Add two **optional** members (optional because minimal hosts may not wire them, mirroring `enqueueUserMessage?`):
```ts
    /** Inject a message into the in-flight round; sends normally when idle. */
    steerMessage?: (content: string) => Promise<void>;
    /** Ask an ephemeral side question against a copy of the current context. */
    askAside?: (question: string) => Promise<string>;
```
- Run `pnpm --dir drone-core run build`.

### Phase 2 — conversation service

**Step 3 — Pure aside-message builder** — agent: `code` — depends on: none
- New file: `drone-agent/src/runtime/aside.ts`
- Export a constant and a pure function so the logic is unit-testable without a service:
```ts
export const ASIDE_FRAMING =
  'SIDE QUESTION (aside): the user is asking a question about the conversation ' +
  'above. Answer it directly and concisely in prose. No tools are available in ' +
  'this context, so do not attempt to call one.';

export function buildAsideMessages(opts: {
  header: DroneChatMessage[];
  sessionMessages: DroneChatMessage[];
  footer: DroneChatMessage[];
  question: string;
}): DroneChatMessage[] {
  return [
    ...opts.header,
    ...opts.sessionMessages,
    ...opts.footer,
    { role: 'user', content: `${ASIDE_FRAMING}\n\n${opts.question}` },
  ];
}
```

**Step 4 — Service state + methods** — agent: `code` — depends on: 1, 2, 3
- File: `drone-agent/src/runtime/conversation-service.ts`
- (a) Type surface — add to `ConversationService` (**required**, matching `enqueueUserMessage`):
```ts
  /** Inject a message into the in-flight round; sends normally when idle. */
  steerMessage: (content: string) => Promise<void>;
  /** Ask an ephemeral side question against a copy of the current context. */
  askAside: (question: string) => Promise<string>;
```
- (b) State — next to `pendingEntries`:
```ts
  // Opt-in mid-round steering (/steer). Separate from pendingEntries because
  // its drain point differs: it is absorbed INSIDE the current round.
  const steeringMessages: string[] = [];
```
- (c) Loop-top drain — immediately **after** the soft-cancel check (`if (cancelled) { ... return CANCEL_SENTINEL; }`), **before** `const tools = getLlmTools();`:
```ts
          // Absorb any /steer messages queued during the previous iteration.
          // Each becomes a real user turn in THIS round, so the model sees it
          // on the very next call. Uses the same direct-hook emission as the
          // pre-loop userMessage (the per-call onEvent is not involved).
          while (steeringMessages.length > 0) {
            const content = steeringMessages.shift()!;
            sessionManager.appendUserMessage(content);
            engine
              .runConversationEventHooks({ kind: 'userMessage', content })
              .catch(err => {
                logger.warn(`Conversation event hook threw: ${err}`);
              });
            // A steer is genuine user intervention: clear the degeneracy
            // guards so a stale streak cannot immediately re-trip, but leave
            // iterationCount alone (tool-call depth stays a hard safety limit).
            identicalToolCallStreak = 0;
            lastIdenticalToolCall = null;
            emptyResponseCount = 0;
            reasoningOnlyResponseCount = 0;
            identicalCallNudgeActive = false;
            brokenResponseHintActive = false;
          }
```
- (d) Discard-on-round-end — in the `finally` of `sendUserMessage`, immediately after `turnInFlight = false;`:
```ts
        // Any steering messages that never reached a loop boundary targeted a
        // round that is now over. Discard them and tell the user (the local
        // `emit` is out of scope here, so use the engine hook directly).
        if (steeringMessages.length > 0) {
          for (const msg of steeringMessages.splice(0)) {
            engine
              .runConversationEventHooks({
                kind: 'notice',
                content: `[steering: discarded late steering message: "${msg}"]`,
              })
              .catch(err => {
                logger.warn(`Conversation event hook threw: ${err}`);
              });
          }
        }
```
- (e) `clearSession` — flush the new queue alongside `pendingEntries.length = 0;`:
```ts
      steeringMessages.length = 0;
```
- (f) Implement the two methods on the `service` object literal:
```ts
    steerMessage: async (content: string) => {
      if (turnInFlight) {
        steeringMessages.push(content);
        engine
          .runConversationEventHooks({
            kind: 'notice',
            content: `[steering: ${content}]`,
          })
          .catch(err => {
            logger.warn(`Conversation event hook threw: ${err}`);
          });
        return;
      }
      // Idle: a steer is just a normal round, with the host lifecycle hooks
      // (mirrors drainPendingEntries('own-round') and the TUI chat branch).
      await engine.runHooks('onBeforePrompt');
      await service.sendUserMessage(content);
      await engine.runHooks('onAfterToolCall');
    },
    askAside: async (question: string) => {
      const llm = getLlmCapability();
      const provider = llm.getActiveProvider();
      const model = llm.getModel();

      const header = await budgetService.buildSystemMessages();
      const footer = await budgetService.buildFooterMessages();
      const base = buildAsideMessages({
        header,
        sessionMessages: sessionManager.getMessages(),
        footer,
        question,
      });

      // Presentation transform only. Deliberately skip describeUndescribedImages:
      // it mutates stored image objects and spends extra LLM calls, and this
      // call can run concurrently with the main loop.
      const hasVision = (await llm.hasVision?.(model)) ?? false;
      const messages = prepareRequestMessages(base, hasVision);

      const response = await provider.chat({
        model,
        messages,
        reasoningLevel,
      });
      const answer = (response.message ?? '').trim();

      engine
        .runConversationEventHooks({ kind: 'aside', question, answer })
        .catch(err => {
          logger.warn(`Conversation event hook threw: ${err}`);
        });
      return answer;
    },
```
- (g) Wire both into `buildBareSlashCommandContext()`'s `conversation` object:
```ts
        steerMessage: c => service.steerMessage(c),
        askAside: q => service.askAside(q),
```
- Note: `getLlmCapability`, `budgetService`, `sessionManager`, `reasoningLevel`, `prepareRequestMessages`, and the guard flags are all already in scope inside `createConversationService`.

**Step 5 — Sweep `ConversationService` implementers and test mocks** — agent: `code` — depends on: 4
- Use `lsp__find_references` on `ConversationService` (and grep as a cross-check) to enumerate every object literal typed as `ConversationService`.
- Add `steerMessage`/`askAside` stubs to each (e.g. `steerMessage: async () => {}`, `askAside: async () => ''`).
- Re-run typecheck; the added members are required, so any missed mock is a hard error.

### Phase 3 — built-in commands

**Step 6 — Register `/steer` and `/btw`** — agent: `code` — depends on: 4
- File: `drone-agent/src/runtime/builtin-commands.ts`
```ts
const steerCommand: DroneSlashCommand = {
  command: '/steer',
  description: 'Inject a message into the current turn (or send normally when idle)',
  // Must run mid-round — queuing would defeat the point.
  busyBehavior: true,
  handler: async (ctx: DroneSlashCommandContext) => {
    const message = ctx.line.slice('/steer '.length).trim();
    if (!message) {
      ctx.logger.error('Usage: /steer <message>');
      return true;
    }
    if (!ctx.conversation?.steerMessage) {
      ctx.logger.error('/steer: not available in this host');
      return true;
    }
    await ctx.conversation.steerMessage(message);
    return true;
  },
};

const btwCommand: DroneSlashCommand = {
  command: '/btw',
  description: 'Ask a side question about the current context (ephemeral; not added to history)',
  // The side-query is independent of the main loop and runs concurrently.
  busyBehavior: true,
  handler: async (ctx: DroneSlashCommandContext) => {
    const question = ctx.line.slice('/btw '.length).trim();
    if (!question) {
      ctx.logger.error('Usage: /btw <question>');
      return true;
    }
    if (!ctx.conversation?.askAside) {
      ctx.logger.error('/btw: not available in this host');
      return true;
    }
    await ctx.conversation.askAside(question);
    return true;
  },
};
```
- Add `steerCommand` and `btwCommand` to the `BUILT_IN_SLASH_COMMANDS` array.
- The handler does **not** log the answer — rendering is driven by the `aside` event (avoids double-render).

### Phase 4 — hosts

**Step 7 — Readline host wiring** — agent: `code` — depends on: 4
- File: `drone-agent/src/interactive.ts` (`runInteractiveLoop`'s inline `conversation` literal)
- Add:
```ts
            steerMessage: c => conversation.steerMessage(c),
            askAside: q => conversation.askAside(q),
```

**Step 8 — TUI rendering of asides** — agent: `code` — depends on: 1
- `drone-agent/src/tui/types.ts`: add `'aside'` to the `ChatEntry['kind']` union; optionally add `steerMessage?`/`askAside?` to `DroneTuiOptions.conversation` for accuracy (the TUI passes the whole service, so these are present at runtime).
- `drone-agent/src/tui/components/ChatLog.tsx`: add a `renderEntry` case:
```tsx
    case 'aside':
      return (
        <Text>
          <ColorTag color={scheme.info}>{'💬 btw: '}</ColorTag>
          <ColorTag color={scheme.info}>{entry.text}</ColorTag>
        </Text>
      );
```
- `drone-agent/src/tui/app.tsx`: in the global `onConversationEvent` switch, add a case that **commits immediately** (no tail item, so it cannot collide with the streaming main message):
```tsx
        case 'aside': {
          const text = `btw: ${event.question}\n${event.answer}`;
          appendFn({ text, kind: 'aside' });
          break;
        }
```
  (Using `appendFn` directly, matching how `notice`/`compaction` write straight to the scrollback.)

**Step 9 — Plain-output + listen-mode rendering** — agent: `code` — depends on: 1
- `drone-agent/src/output-handlers.ts`:
  - Extend the handler's inline event param type with `question?: string; answer?: string;`.
  - Add a case:
```ts
      case 'aside':
        output.write(
          `\x1b[36m💬 btw: ${event.question ?? ''}\n${event.answer ?? ''}\x1b[0m\n`
        );
        break;
```
  - Add `| { kind: 'aside'; question: string; answer: string }` to `OutputEvent`.
- `drone-agent/src/interactive.ts` (`runSwarmListenMode`'s NDJSON listener switch): add an `aside` case emitting `ndjsonHandler({ kind: 'aside', question, answer })` so remote asides are observable in the structured stream.

### Phase 5 — coordinator transcript

**Step 10 — Surface `aside` in the readable transcript** — agent: `code` — depends on: 1
- File: `drone-coordinator/src/transcript.ts`
  - Add `'aside'` to `KEPT_EVENT_KINDS`.
  - Add `question?: string; answer?: string;` to `ParsedEvent`, and extract them in `parseEvent`:
```ts
  if (typeof parsed.question === 'string') result.question = parsed.question;
  if (typeof parsed.answer === 'string') result.answer = parsed.answer;
```
  - Add a `renderEvent` case (question + answer only):
```ts
    case 'aside':
      return [
        `[aside Q] ${event.question ?? ''}`,
        `[aside A] ${event.answer ?? ''}`,
      ];
```
- No route/schema change is needed (`POST /sync/events/push` stores any `type` string).

### Phase 6 — tests

**Step 11 — Pure builder + handler tests** — agent: `code` — depends on: 3, 6
- New: `drone-agent/test/aside.test.ts` — `buildAsideMessages` ordering (header → session → footer → framed question) and framing content.
- New: `drone-agent/test/slash-steer-btw.test.ts` — via a mock registration: both commands registered with `busyBehavior: true`; empty arg → usage error + `true`; missing service method → error + `true`; non-empty arg delegates to `steerMessage`/`askAside`; the handler does not log the answer.

**Step 12 — Conversation-service behaviour tests** — agent: `code` — depends on: 4
- Extend `drone-agent/test/conversation-service.test.ts` (or add `conversation-service-steering.test.ts`), mirroring the existing queue suite:
  - busy `steerMessage` does not send immediately; the message is absorbed at the next loop boundary (assert it appears in the session before the next LLM call, via the fake provider's received messages).
  - the absorbed message emits a `userMessage` event and resets the degeneracy guards but not `iterationCount`.
  - idle `steerMessage` runs a full round and fires `onBeforePrompt` / `onAfterToolCall`.
  - a late steering message is discarded at round end with the `[steering: discarded late steering message: ...]` notice on cancel **and** on normal completion.
  - `clearSession` flushes `steeringMessages`.
  - `askAside` sends exactly one request with no `tools`, whose messages end with the framed question and begin with the header run; it emits one `aside` event carrying question + answer and returns the answer.
  - concurrent: calling `askAside` while a turn is in flight does not disturb the main loop's queue/cursor.

**Step 13 — TUI render test** — agent: `code` — depends on: 8
- Extend the TUI tests to fire an `aside` event through the mocked `onConversationEvent` and assert a committed entry with the `aside` kind appears (poll for content with the `waitUntilFrame(inst, predicate)` helper — never a fixed tick).

**Step 14 — Transcript test** — agent: `code` — depends on: 10
- Add/extend a `drone-coordinator` transcript test: an `aside` event survives `buildSessionTranscript` and renders `[aside Q]` / `[aside A]`; a non-listed kind is still dropped.

**Step 15 — Output-handler test** — agent: `code` — depends on: 9
- Extend `drone-agent/test/output-handlers*` (create if absent) to assert the plain handler writes an aside without throwing.

### Phase 7 — documentation

**Step 16 — Document the commands** — agent: `code` — depends on: 6
- `AGENTS.md`, slash-command section: add `/steer` and `/btw` to the command discussion, note both are `busyBehavior: true`, and record the `--now`-in-message caveat as a known future fix.

### Phase 8 — verification

**Step 17 — Review pass** — agent: `review` — depends on: 1–16
- Blunt review of the full diff against the locked decisions; flag any divergence, dead code, or missing test.

**Step 18 — Run the validation criteria** — agent: `code` — depends on: 17
- Execute every item in the Validation Criteria section below and report results.

---

## Validation criteria

All of the following must pass before the feature is considered done.

### Static gates
1. **LSP diagnostics are clean** on every touched file (`lsp__get_diagnostics`), with zero new errors. *Exception:* the 8 pre-existing stale-`dist` errors in `drone-beacon/test/wiki-indexer.test.ts` (`wordCount`/`linkCount` missing on `DroneWikiPageMeta`) are out of scope — re-confirm after `pnpm -r run build` that they are unrelated to this change and unchanged in count.
2. **`pnpm -r run build`** exits 0. Run **after** the drone-core type changes (steps 1–2) and again at the end.
3. **`pnpm -r run lint`** exits 0. (Prettier runs on success — re-read all touched files before any further edit.)

### Test gates
4. **`pnpm -r run test`** (the fast suite; root `pnpm test` is the canonical runner) passes with zero failures, including all new tests from Phase 6.
5. **New-code coverage:** every new branch is exercised — busy vs idle `steerMessage`, boundary absorption, discard-on-cancel, discard-on-normal-completion, `clearSession` flush, `askAside` tool-less single call, `aside` event emission, and both transcript render lines.

### Feature gates
6. **`/steer` while busy:** a `/steer <msg>` typed mid-round produces a `[steering: <msg>]` notice, and the *next* LLM request's messages contain `<msg>` as a user turn **before** the round's final assistant reply is produced.
7. **`/steer` while idle:** `/steer <msg>` behaves exactly like sending `<msg>` as a normal message (a full round with `onBeforePrompt`/`onAfterToolCall`).
8. **Late steer:** a `/steer` sent as the round's final response is being generated yields `[steering: discarded late steering message: "<msg>"]` and does **not** appear in the session.
9. **`/btw`:** `/btw <question>` renders a distinct `💬 btw:` scrollback entry containing the question and the answer, while `sessionManager.getMessages()` is byte-identical before and after (`git diff`-level proof via a test assertion on the message array).
10. **`/btw` tool-less:** the outgoing request carries no `tools` (assert on the fake provider's captured request).
11. **`/btw` while busy:** it runs concurrently — the main round's spinner and transcript are unaffected, and no tail item collides.
12. **Remote parity:** `/steer` and `/btw` work through the remote path (`submitUserMessage` → bare context) and the readline host (readline builder wired).
13. **Transcript:** a completed session that used `/btw` shows `[aside Q]` / `[aside A]` lines in `GET /api/sessions/:id/transcript`.
14. **Manual TUI smoke** (hand to the user): (a) `/steer` mid-round changes the agent's direction without a new round; (b) `/steer` late shows the discard notice; (c) `/steer` idle behaves as a normal message; (d) `/btw` answers a question about the session and leaves `history` untouched under `/compact show`; (e) `/btw --now foo` and the `--now`-in-message caveat behave as documented.

### Hygiene gates
15. No dead code, no unused variables, no fluff comments (only jsdoc / complex-algorithm / TODO comments).
16. Project-memory and `.drone-agent` scratch changes are committed with the feature branch (not to `main`).

---

## Open follow-ups (explicitly out of scope)

- Strip `--now` less aggressively so it cannot be eaten out of a `/steer`/`/btw` message (and other rest-of-line commands).
- Split `drone-agent/src/runtime/conversation-service.ts` (1540 lines) below the 1000-line threshold.
- Readline builder's pre-existing missing `enqueueUserMessage` / `cancelCurrentRequest`.
- Optionally carry reasoning for `/btw` (additive `reasoning?` on the `aside` event).

## Related

- `drone-agent-message-queue-and-steering-machinery` (swarm memory) — the as-is queue/drain reference this builds on.
- `drone-agent-one-shot-ephemeral-llm-queries` (swarm memory) — the side-channel `provider.chat()` reference.
- ADR 215 (`decisions/215-slash-commands-during-work`) — the queuing change that removed mid-round absorption.
- ADR 040 (`decisions/040-message-queue-cancel`) — the original queue/soft-cancel design and the immediate/queued split.
- `drone-agent-session-events-transcript-ingest-pipeline` (swarm memory) — the `KEPT_EVENT_KINDS` gate.
