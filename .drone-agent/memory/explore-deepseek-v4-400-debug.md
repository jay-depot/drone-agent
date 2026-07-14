---
key: explore-deepseek-v4-400-debug
tags: []
created: 2026-07-14T20:58:35.052Z
updated: 2026-07-14T20:58:35.052Z
---

# explore/deepseek-v4-400-debug

## Summary

Branch created to investigate a DeepSeek V4 Flash 400 error that appears at ~50% context when using Ollama Cloud. Added debug logging and TUI polish to make compaction and error events visible.

## Changes Made

### Compaction Event Emission

- Added `compaction` event kind to `DroneConversationEvent` union in `drone-core/src/session-types.ts`
- Added optional `emitEvent` callback to `CompactionPluginDeps` and `RegistrationContext`
- Wired `emitEvent` in `index.tsx` via `runConversationEventHooks`
- Compaction plugin now emits `started`/`completed`/`failed` events during:
  - Summary generation (started → completed or failed)
  - Self-purge of old summaries (completed)
- HTTP status codes included in compaction failure logs

### TUI Polish

- Added `compaction` kind to `ChatEntry` and `TailItem` types
- Added `compaction` color slot to `DroneColorScheme` (cyan)
- TUI handles compaction events: shows 📦 in tail region during compaction, commits to scrollback when done
- Added `compaction` case to `renderEntry()` in ChatLog

### Better Error Logging

- Ollama provider now extracts `status_code` from `ResponseError` and includes it in error messages
- Logs full error details at warn level before throwing
- Safety trim now logs model, context window, and usage when it fires

### Tests

- 3 new tests for compaction event emission:
  - Successful compaction emits started → completed
  - Failed compaction emits started → failed
  - Self-purge emits completed

## Status

- Committed on branch `explore/deepseek-v4-400-debug`
- All 1463 tests pass, build and lint clean
- Not yet merged to main — still an exploration branch
