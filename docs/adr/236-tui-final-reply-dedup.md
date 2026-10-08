---
tags: [decision, tui, bug-fix]
related:
  [046-tui-tail-region-refactor.md, drone-agent-tui.md, flows/tool-call-loop.md]
---

# 236 — TUI final reply rendered exactly once

**Summary**: Removed a redundant `log(response, 'plain')` call in the TUI's `runSlashCommand` so the final assistant reply is committed to the scrollback a single time, via the `assistantMessage`/`assistantMessageComplete` event path.

## Context

The conversation service (`conversation-service.ts`) emits two event kinds when a non-tool assistant turn completes:

```ts
emit({ kind: 'assistantMessage', content: assistantMessage });
emit({ kind: 'assistantMessageComplete' });
```

The TUI event listener handles both: `assistantMessage` adds a live `AssistantMessageBlock` tail item, and `assistantMessageComplete` commits that item to the `<Static>` scrollback as a `plain` entry (via `commitItem` + `appendEntry`). This is the correct, single render path — it also drives the live streaming tail.

Before this fix, `runSlashCommand` in `app.tsx` additionally did:

```ts
const response = await opts.conversation.sendUserMessage(trimmed);
if (response.length > 0) {
  log(response, 'plain');
}
```

`sendUserMessage` returns the **same text** that was already emitted via `assistantMessage` (`conversation-service.ts` returns `assistantMessage` directly). So the reply was written to the scrollback **twice** — once via the event commit, once via the explicit `log()`.

## Decision

Remove the redundant `log(response, 'plain')` block. The assistant reply is rendered **only** through the conversation-event pipeline (tail → atomic Static commit).

The `response` return value is still used — but exclusively for the `CANCEL_SENTINEL` early-return check. No lifecycle hook, plugin, or other code depends on the returned text for side effects (verified by grep: `response` is referenced only at the `sendUserMessage` call and the `CANCEL_SENTINEL` check).

The try/catch `log(\`Error: ${msg}\`, 'error')`for hook-thrown errors is **preserved**, as is the in-stream`error` event. Tool/hook errors still render exactly once.

## Why this is safe

- The `assistantMessage` event pair already renders the full reply — nothing is lost by dropping the `log()`.
- The plain-output mode (`interactive.ts`) and JSON mode (`output-handlers.ts`) use the return value, not the events — they were never double-rendering and remain unaffected.
- Other `sendUserMessage` callers (macros, persona, skills workflows) only consume the return value; they have no second render path.

## Consequences

- TUI: final assistant reply appears exactly once in the scrollback (was twice).
- Error rendering unchanged: in-stream `error` event + try/catch hook-error log both still fire once.
- No new regression test was added (covered by dogfooding; see decision-bug-fixes-go-in-decisions convention — this is a bug fix, documented here).

## Implementation note / gap

The TUI's conversation-event render path (assistantMessage/assistantMessageComplete → tail → Static scrollback) is not exercised by any test — `tui.test.tsx` mocks `onConversationEvent` as a no-op and only asserts status bar / mid-panel / help. That gap is what let this double-render ship undetected. A regression test emitting the event pair via a real `onConversationEvent` mock and asserting the reply appears once in the frame would prevent recurrence (recommended, not yet added).

## Source

- Commit `9df25139` — `fix(tui): stop double-rendering the final assistant reply in the TUI`
- Plan: `tui-duplicate-final-response-fix-plan` (project memory, now deleted after ingest)
