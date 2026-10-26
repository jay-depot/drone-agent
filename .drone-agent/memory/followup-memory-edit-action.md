---
key: followup-memory-edit-action
tags:
  - followup
  - memory
  - diff
  - concurrency
created: 2026-10-26T23:57:44.295Z
updated: 2026-10-26T23:57:44.295Z
---

Added `action="edit"` to `memory__manage` (branch feat/more-diff-improvements, 2026-10-26), mirroring `swarm__wiki_edit`.

## What it does
`memory__manage({action:"edit", key, diff?, tags?})` applies a unified diff (same format as `file__apply_diff`; `@@` header optional) to the entry BODY and/or replaces tags. `createdAt` preserved, `updatedAt` bumped. Returns `{success, key, tags, createdAt, updatedAt, summary?, diff?}`.

## Design
- `edit` lives on the `DroneMemoryCapability` (drone-agent/src/plugins/memory/types.ts) — the shared API — as `edit(key, patch: (entry)=>{value, tags?}) => Promise<MemoryEntry|null>`. The whole read→patch→write runs atomically under `withKeyLock(\`memory:${sanitizeKey(key)}\`)`.
- `store` and `delete` were ALSO wrapped in the same key lock (user decision: lock all 3 mutating methods). All three lock the SAME key, so the tool must NOT double-lock (re-entrant `withKeyLock` self-deadlocks).
- Diff logic stays in the tool (`applyPatchToBody` helper); the capability only owns the lock + cache + disk. A `MemoryEditAbort` sentinel thrown from inside the patch callback aborts the write when zero hunks apply.
- Partial success mirrors wiki_edit: good hunks written, failures surfaced in the error. Zero applied hunks writes nothing.

## Files
- drone-agent/src/plugins/memory/types.ts (edit on capability)
- drone-agent/src/plugins/memory/index.ts (withKeyLock wrap on store/delete + edit impl; tool action enum/execute; applyPatchToBody + MemoryEditAbort + MEMORY_EDIT_RECOVERY_TIP)
- drone-agent/src/tui/components/MemoryManageBlock.tsx (edit render case)
- AGENTS.md (memory line: store/recall/edit/delete)
- drone-agent/test/memory-index.test.ts (+8 tests incl. concurrent-edit serialization)

## Open item (deliberately NOT fixed here)
`capability.recall()` reads `cache.get(rawKey)` while the cache is keyed by SANITIZED key (writeMemoryEntry/readMemoryEntry sanitize). So recall() cache-misses for keys containing `/`, `..`-free but separator-bearing, etc. — it still works via disk fallback, just skips the cache. Pre-existing; left alone to keep this change focused.