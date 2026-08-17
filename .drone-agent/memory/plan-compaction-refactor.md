---
key: plan-compaction-refactor
tags:
  - compaction
  - plan
  - architecture
created: 2026-08-17T23:25:36.441Z
updated: 2026-08-17T23:25:36.441Z
---

# Implementation Plan: Compaction Plugin Refactor

## Summary
This plan resolves critical race conditions, eliminates dangerous configuration mutations, and fixes token estimation gaps in the `compaction` plugin. The primary goal is to move the plugin toward a pure-logic core with a strictly controlled entry-point for lock and state management.

## Step-by-Step Instructions

### 1. Architecture & Type Updates
- **File:** `drone-agent/src/plugins/compaction/index.ts`
- **Action:** Define a `CompactionOptions` type and update function signatures.
- **Details:**
    - Add `type CompactionOptions = { force?: boolean; slicePercentOverride?: number };`.
    - Update `maybeCompact` and `runCompaction` to accept `options: CompactionOptions` as a parameter.

### 2. Extract Fallback Calculation Logic
- **File:** `drone-agent/src/plugins/compaction/index.ts`
- **Action:** Create a standalone helper function for the context window fallback.
- **Code Sample:**
  ```typescript
  function calculateFallbackContextWindow(
    baseSystemMessages: DroneChatMessage[],
    fragmentMessages: DroneChatMessage[],
    softThresholdPercent: number
  ): number {
    const totalSystemTokens = [
      ...baseSystemMessages,
      ...fragmentMessages
    ].reduce((sum, m) => sum + estimateMessageTokens(m), 0);
    
    return Math.max(1, Math.round(totalSystemTokens / Math.max(0.01, softThresholdPercent / 100)));
  }
  ```
- **Integration:** Replace the inline calculations in both `maybeCompact` and `getStatus` with calls to this helper.

### 3. Refactor `maybeCompact` (The Pure Logic Core)
- **File:** `drone-agent/src/plugins/compaction/index.ts`
- **Action:** Remove lock management and implement option-based overrides.
- **Details:**
    - **REMOVE:** `input.context.compactionInFlight.value = false;` at the end of the function.
    - **UPDATE:** Change the enabled check: `if (!config.enabled && !options.force) return;`.
    - **UPDATE:** Change slice size calculation to use `options.slicePercentOverride ?? config.slicePercent`.

### 4. Fix `runCompaction` & Fragment Awareness
- **File:** `drone-agent/src/plugins/compaction/index.ts`
- **Action:** Integrate actual prompt fragments.
- **Details:**
    - Update `runCompaction` to accept `fragments: DroneChatMessage[]` and pass them into `maybeCompact`.
    - Ensure the caller of `runCompaction` (e.g., `hookBody`) retrieves active fragments from the registration context.

### 5. Clean up `CompactionCapability` & `hookBody`
- **File:** `drone-agent/src/plugins/compaction/index.ts`
- **Action:** Remove config mutations and consolidate lock ownership.
- **Details:**
    - **In `forceEvaluate`**: Remove the `originalEnabled` flip. Call `runCompaction(context, ..., { force: true })`.
    - **In `forceEvaluateAll`**: Remove the `originalSlice` flip. Call `runCompaction(context, ..., { force: true, slicePercentOverride: 100 })`.
    - **In `hookBody`**: Ensure the `finally` block is the *only* place the lock is released.

## Validation Criteria

### Functional Tests
- [ ] **Manual Compaction**: Calling `/compact` when `compaction.enabled` is `false` should still work (via `force: true`).
- [ ] **Full Compaction**: Calling `/compact --all` should compact all eligible turns regardless of the `slicePercent` config.
- [ ] **Lock Safety**: Verify that `compactionInFlight` is correctly toggled and not released prematurely.

### Technical Checks
- [ ] **LSP Pass**: No TypeScript errors in `drone-agent/src/plugins/compaction/index.ts`.
- [ ] **Build Pass**: `pnpm -r run build` completes without errors.
- [ ] **Lint Pass**: `pnpm -r run lint` completes without errors.
- [ ] **Token Accuracy**: Verify that `summarizeTokenCounts` is receiving non-empty `fragmentMessages` if fragments are registered.