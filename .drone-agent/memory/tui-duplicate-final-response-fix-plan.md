---
key: tui-duplicate-final-response-fix-plan
tags:
  - plan
  - bug
  - tui
  - duplication
created: 2026-07-07T16:55:22.119Z
updated: 2026-07-07T16:55:22.119Z
---

# Plan: Fix TUI double-render of final LLM response

## Summary

In the Ink TUI, the final assistant reply is committed to the <Static> scrollback TWICE:
once via the `assistantMessage`/`assistantMessageComplete` conversation events (tail→Static
commit, kind 'plain'), and again via an explicit `log(response, 'plain')` call in
`runSlashCommand` (app.tsx:399). The returned `response` is identical to the event content.

## Agreement

- Use fix approach A: remove the redundant `log(response, 'plain')` in `runSlashCommand`.
- Audit showed: nothing depends on the `response` return value for side effects (it is only
  checked for CANCEL_SENTINEL and then logged; runSlashCommand is called as `void`).
- The `assistantMessage` event pair already renders the full reply — nothing lost.
- The `error` event (app.tsx:338) already carries errors into scrollback; the try/catch
  `log()` at app.tsx:404 covers hook throws and must stay.
- No new regression test (covered by dogfooding). User confirmed.

## Steps

1. (coder) In `drone-agent/src/tui/app.tsx`, inside `runSlashCommand`, remove the block:
   if (response.length > 0) {
   log(response, 'plain');
   }
   Keep the CANCEL_SENTINEL check. Result body:
   const response = await opts.conversation.sendUserMessage(trimmed);
   if (response === CANCEL_SENTINEL) { return; }
   await opts.engine.runHooks('onAfterToolCall');
2. (coder) Confirm no other code path in app.tsx relies on `response` (verified: none).
3. (reviewer) Confirm the assistant reply still appears exactly once by reasoning through the
   event flow: assistantMessage (addItem tail) -> assistantMessageComplete (commitItem +
   appendEntry to Static). Verify the try/catch error log at app.tsx:404 is preserved.
4. (tester) Run `pnpm typecheck`, `pnpm lint`, `pnpm test` (incl. tui.test.tsx) — all green.

## Validation criteria

- `pnpm typecheck` passes (LSP errors resolved).
- `pnpm lint` passes.
- `pnpm test` passes (vitest, including tui.test.tsx and conversation-service tests).
- Manual dogfood: send a chat message in the TUI; final reply appears exactly once.
- Manual dogfood: a tool error and a thrown hook error still show exactly one error line.
