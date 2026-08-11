---
key: review-lsp-eacces-scan
tags:
  - bug
  - lsp
  - error-handling
  - review
created: 2026-08-11T02:34:44.072Z
updated: 2026-08-11T02:40:00.000Z
---

BUG: LSP plugin crashes the conversation loop when run from a directory with an unreadable subdirectory (e.g. ~/.dropbox-dist). Root cause: `collectWorkspaceFiles` in drone-agent/src/plugins/lsp/server/helpers.ts does an unguarded recursive `readdir` (throws EACCES), while the sibling function `hasMatchingFiles` in the same file guards every `opendir` with `.catch(() => null)`. The error propagates through `syncServerDocuments` → `refreshIfNeeded` → `onBeforePrompt` hook. In TUI mode (tui/app.tsx:469) it's caught and logs "Error: EACCES..." but aborts the turn before sendUserMessage runs; in plain/--chat/--once modes (interactive.ts:111, index.tsx:296) runHooks('onBeforePrompt') is unguarded and the session terminates. Fix: guard per-directory readdir in collectWorkspaceFiles like hasMatchingFiles does. Also note onAfterToolCall is defended (conversation-service.ts:569) but onBeforePrompt is not.

FIXED on branch fix/lsp-eacces-scan (commit after 25b960b):
1. `collectWorkspaceFiles` now guards each per-directory `readdir` with `.catch(() => [])`, skipping unreadable dirs (matches `hasMatchingFiles`).
2. `runHooks` in drone-agent/src/runtime/plugin-engine.ts now makes `onBeforePrompt` non-fatal: on hook error it logs `onBeforePrompt hook error (non-fatal)` and continues, so the user's message is still processed and the loop never terminates. Other hooks still rethrow.
3. Added drone-agent/test/lsp-helpers.test.ts reproducing the EACCES scenario (mock readdir throws EACCES on a subdir) — verified it fails without the fix and passes with it.
All checks green: LSP clean, build passes, prettier clean, full suite 1789 tests pass.
