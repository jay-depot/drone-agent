---
key: review-lsp-eacces-scan
tags:
  - bug
  - lsp
  - error-handling
  - review
created: 2026-08-11T02:34:44.072Z
updated: 2026-08-11T02:34:44.072Z
---

BUG: LSP plugin crashes the conversation loop when run from a directory with an unreadable subdirectory (e.g. ~/.dropbox-dist). Root cause: `collectWorkspaceFiles` in drone-agent/src/plugins/lsp/server/helpers.ts does an unguarded recursive `readdir` (throws EACCES), while the sibling function `hasMatchingFiles` in the same file guards every `opendir` with `.catch(() => null)`. The error propagates through `syncServerDocuments` → `refreshIfNeeded` → `onBeforePrompt` hook. In TUI mode (tui/app.tsx:469) it's caught and logs "Error: EACCES..." but aborts the turn before sendUserMessage runs; in plain/--chat/--once modes (interactive.ts:111, index.tsx:296) runHooks('onBeforePrompt') is unguarded and the session terminates. Fix: guard per-directory readdir in collectWorkspaceFiles like hasMatchingFiles does. Also note onAfterToolCall is defended (conversation-service.ts:569) but onBeforePrompt is not.