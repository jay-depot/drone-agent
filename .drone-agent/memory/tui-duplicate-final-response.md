---
key: tui-duplicate-final-response
tags:
  - bug
  - tui
  - duplication
  - conversation-service
  - app
created: 2026-07-07T16:49:31.910Z
updated: 2026-07-07T16:49:31.910Z
---

ROOT CAUSE: Final LLM response is rendered twice in the Ink TUI.

The conversation service emits an 'assistantMessage' + 'assistantMessageComplete' event pair (conversation-service.ts:492-494) every time a non-tool assistant turn completes. In app.tsx, the conversation event listener handles 'assistantMessage' by adding a live tail item (AssistantMessageBlock) and 'assistantMessageComplete' by committing it to the <Static> scrollback (app.tsx ~lines 405-430). That is correct: ONE committed entry.

The DUPLICATE comes from runSlashCommand in app.tsx (~lines 320-340). After awaiting conversation.sendUserMessage(trimmed), it checks `if (response.length > 0) { log(response, 'plain'); }`. The `response` IS the assistantMessage text (conversation-service returns `assistantMessage` at line 496). So the response is ALSO written to the chat log via `log(...)` (a 'plain' kind entry appended to the Static scrollback).

So the assistant message gets committed to scrollback BOTH via:
1. The assistantMessage/assistantMessageComplete event path (live tail -> Static commit, kind 'plain' from currentMessageText.current), and
2. The explicit `log(response, 'plain')` call in runSlashCommand.

FIX OPTIONS:
- Remove the `if (response.length > 0) log(response, 'plain')` block in runSlashCommand, since the event listener already renders the assistant message into scrollback.
- OR suppress the assistantMessage* events when in TUI mode and rely solely on log(). But the event path also drives the live streaming tail, so removing log() is the cleaner fix.