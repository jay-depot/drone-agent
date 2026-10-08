---
tags: [decision, llm, vision, image-describer, model-roles, compaction]
related:
  [
    decisions/164-model-role-bindings.md,
    decisions/160-unified-llm-error-retry-semantics.md,
    decisions/155-provider-model-config.md,
    concepts/vision-support.md,
    concepts/provider-model-selection.md,
    modules/drone-core.md,
    modules/drone-agent.md,
    modules/drone-agent-plugins.md,
    flows/tool-call-loop.md,
  ]
---

# 165: `image_describer` role — describe images for non-vision models

**Status**: Implemented (2026-08-26, branch `feat/model-role-bindings`, commits `fe2185c`..`04a372e`)

## Context

When a tool result contains an image (e.g. `file__read_image`) and the **target model is not vision-capable**, the image bytes are useless to that model — it cannot see them. Before this feature, the conversation service would inject the base64 image into the request regardless, and a non-vision model would simply ignore it (or worse, choke on it). The image's _semantics_ were lost to the model.

The fix: describe the image with a **vision-capable** model (the `image_describer` role) and store the text description alongside the image in the abstract context. Presentation is then derived per-request: a vision-capable target receives the image bytes; a non-vision target receives the description text. The stored turn is model-agnostic (both representations persisted); exactly one representation crosses the wire per model.

This slots into the open model-role namespace established by [164-model-role-bindings](164-model-role-bindings.md) — `image_describer` is a new well-known role alongside `summarizer`/`wizard`/`describer`.

## Decision

### 1. Storage: `description?: string` on `DroneImageContent`

`DroneImageContent` (drone-core/src/session-types.ts) gains an optional `description?: string` — the model-generated description used as the wire representation when the target model is not vision-capable. Stored as part of the abstract context, per-image, persisted verbatim (survives log/swarm JSON round-trips — no schema validation on those stores). Multi-image tool results describe each image independently.

### 2. Broker capability `describeImages(images)`

`DroneLlmCapability` gains `describeImages(images: DroneImageContent[]) → Promise<DroneImageContent[]>`:

- Filters to **undescribed** images (idempotent — already-described images are skipped).
- Resolves a vision-capable describer via the **D8 fallback chain**:
  1. configured `image_describer` role if vision-capable
  2. active selection if vision-capable
  3. same provider entry as the pinned describer: any vision-capable model under that exact `config.providers.<id>`
  4. breadth: any configured+instantiated vision-capable model in **broker precedence order** (ollama=0, remote=1 — via a shared `providerPrecedence` helper, not config insertion order)
  5. none → warn-once-per-session + skip (lazy/idempotent so a later model change can retry)
- Calls the describer's `chat()` per image with a `DESCRIBER_SYSTEM_PROMPT` + `{ role:'user', content:'Describe this image:', images:[img] }`, wrapped in `withBoundedSilentRetry` + a ~60s timeout.
- **Fails open** (D9): on describer failure/timeout/no-describer, images are returned unchanged (idempotent — a later call can retry). Never hard-errors.

### 3. Retry: borrow T1 only (D10)

The describer reuses the shared `withBoundedSilentRetry` helper (extracted from `runWithRetry`'s T1 branch into `runtime/llm-retry.ts`), sourcing its retry config from `session.retry.{maxRetries,maxWaitMs,backoffBaseMs,backoffFactor}` with `DEFAULT_RETRY_CONFIG` fallback — the **same policy as the main loop**. No T2 (no user prompting for background artifact work); the outer ~60s timeout is the hard cap.

### 4. Conversation-service request seam (D1/D3/D5/D11)

In the tool loop, after tool results are appended:

- **Per-tool image-extractor registry (D11)**: `file__read_image` registers a structured extractor producing `DroneImageContent[]` directly (knows its own return shape); unregistered tools fall back to the content-scan heuristic (`extractImageFromToolResult`/`findDataUri`). MCP stays on the heuristic fallback. **Superseded 2026-08-27 (V2)**: the extractor registry and content-scan heuristic were deleted — images now flow purely via the structured `DroneToolResult.images[]` channel (see [167-image-content-refactor-v2](167-image-content-refactor-v2.md)).
- **Durability gate (D5)**: when `log.enabled || swarm active`, images are described **eagerly at append** so the description lands in the persisted store (structural guarantee, no shutdown race). Otherwise description is **lazy** (D3).
- **Parallel across batch (D1)**: describe calls run via `Promise.all` across the batch, then results are applied to the session store sequentially.
- **Lazy-once (D3)**: at request assembly, when the target model `hasVision === false`, undescribed images are described now (once-cached into the stored message). Vision-capable targets skip generation.
- **Presentation stripping (D11)**: `prepareRequestMessages` derives the wire representation per target — vision target → image via `images[]` (base64 blob stripped from content, `[Image attached]` marker left); non-vision target → description substituted into content, image omitted. Storage/estimator untouched.

### 5. Pre-compaction flush (D4)

Before building the summary (`formatTurnsForSummary`), compaction calls `llm.describeImages(...)` on undescribed images in the turns being compacted, writing descriptions back in place. This ensures the summary — which may be produced by a non-vision `summarizer` — sees the description text and captures its semantics, so abstract context survives the compaction boundary even though image bytes are destroyed. Idempotent; fails open (a flush failure never blocks compaction). `formatTurnsForSummary` also renders `image: <description>` lines for described images.

### 6. Token accounting (D7)

Per-image budget contribution in `estimateMessageTokens` changes from a flat `256` to `max(256, estimateTextTokens(description))` — model-agnostic (no `hasVision` at estimate time). The pre-existing base64 double-count (content-text + images[]) is intentionally NOT fixed (deferred to the V2 content refactor). **Resolved 2026-08-27 (V2)**: V2 removes base64 from `content`, so the double-count disappears (see [167-image-content-refactor-v2](167-image-content-refactor-v2.md)).

## Implementation notes

- `WELL_KNOWN_MODEL_ROLES` becomes `['summarizer','wizard','describer','image_describer']`.
- The compaction plugin declares `llm` as an **optional** dependency (so `/compact` list works without the LLM broker).
- The D8 breadth step and `getAvailableProviders` both use the shared `providerPrecedence` helper — a precedence rule is a shared contract every consumer must honor (the initial implementation iterated config insertion order, which was corrected).
- Docs (`docs/agents/provider-model-config.md`) gained an "Images & vision" section documenting the role, the fallback chain, the lazy-vs-eager durability gate, and that describer failures fail open.

## Validation

Full fast suite green (2350 passed, 9 skipped), `pnpm -r run build` clean, `pnpm lint` clean, LSP clean in touched files. New tests: drone-core image type + token `max(256, desc)`; broker D8 chain each step + statelessness + describeImages + fail-open + warn-once; D8 breadth precedence ordering; conversation-service request-seam lazy/eager + presentation-stripping + idempotency + D1 parallel-across-batch; compaction pre-flush (describes-before-summarize, fail-open-still-compacts).

## Related

- [164-model-role-bindings](164-model-role-bindings.md) — the model-role namespace `image_describer` slots into
- [160-unified-llm-error-retry-semantics](160-unified-llm-error-retry-semantics.md) — the shared `withBoundedSilentRetry` T1 policy the describer rides
- [155-provider-model-config](155-provider-model-config.md) — `hasVision` as resolved model metadata
- vision-support — image input handling across providers
- provider-model-selection — selection identity + resolution chains
