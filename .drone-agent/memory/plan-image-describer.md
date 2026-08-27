---
key: plan-image-describer
tags:
  - plan
  - image_describer
  - vision
  - llm
  - roles
created: 2026-08-26T22:23:30.948Z
updated: 2026-08-27T01:16:06.586Z
---

# PLAN: `image_describer` role — describe images for non-vision models, as abstract context

Branch: `feat/model-role-bindings` (same branch as prerequisite `plan-model-role-bindings`). Write this on the same branch, after `plan-model-role-bindings` is complete/merged.

## Prerequisite (locked)

`plan-model-role-bindings` COMPLETE: `llm.modelRoles: Record<string,string>` config (user scope only, per-key merge, startup validation), `DroneLlmCapability.resolveModelForRole(role)` → `{ provider, providerId, model, reasoningLevel? }`, well-known roles `['summarizer','wizard','describer']`, shared `resolveConfiguredReasoningLevel` helper, shared `withBoundedSilentRetry` (extracted T1 loop) existing.

`image_describer` SLOTS INTO the open role namespace: add `'image_describer'` to `WELL_KNOWN_MODEL_ROLES` (drone-core/src/model-selection.ts). All base-plan machinery (fallback-on-broken-role, warn-once-per-role, stateless resolution, scope policy, docs) applies unchanged.

## Summary

When a tool result contains an image (e.g. `file__read_image`) and the target model is NOT vision-capable, describe the image (via the `image_describer` model) and store the description alongside the image in the abstract context. Presentation is derived per-request: vision-capable target → send image (status quo); non-vision target → send description (image omitted). The stored turn is model-agnostic (image + description both persisted); exactly one representation crosses the wire per model. Describer failures degrade fail-open (never worse than today). Also a V1 "loosening" that makes file-tool images structured at the seam, teeing up the V2 content refactor (`image-content-refactor-v2` memory).

## Locked decisions

| #   | Decision |
| --- | --- |
| D1  | Seam: conversation-service tool loop, BESIDE truncation, BEFORE append. Parallel across batch (Promise.all). Synchronous-with-batch (description needed before next LLM send). Timeout-guarded ~60s (aligned with retry maxWaitMs). |
| D2  | Abstract context: stored turn holds image + description (both persisted); presentation derived per-request by target `hasVision`. `image_describer` model must itself be vision-capable (receives the image it describes). |
| D3  | Generation: LAZY-ONCE cached. Generate only when a non-vision model is about to receive the image; persist description into stored message; subsequent requests reuse. Vision-capable sessions never generate. Must land before compaction. |
| D4  | Pre-compaction flush: shared `describeImages(images)` capability broker-side (owns role resolution + provider access), returns images with descriptions filled; caller (conversation-service, compaction) owns write-back onto its turns. Idempotent (skip already-described). Triggers: (a) request seam lazy, (b) pre-compaction before formatTurnsForSummary. |
| D5  | Durability (C2): description lands in log/swarm persisted store, gated `log.enabled \|\| swarm active`. EAGER-when-persisting at append time iff that gate; else lazy (D3). Structural guarantee, no shutdown race. NOT on safety-drop. |
| D6  | Storage: `description?: string` on `DroneImageContent` (drone-core/src/session-types.ts:42-47), per-image, persisted verbatim. Survives log/swarm JSON round-trips. Multi-image tool results: describe each independently. |
| D7  | Token accounting (Q5): per-image budget contribution = `max(256, estimateTextTokens(description))` in `estimateMessageTokens` (token-estimate.ts:15-33). Model-agnostic. Do NOT fix the base64 double-count — pre-existing, deferred to V2. |
| D8  | Describer vision fallback chain (Q6): (1) configured `image_describer` if vision-capable → (2) active selection if vision-capable → (3) SAME PROVIDER ENTRY as pinned describer: any vision-capable model under that exact `config.providers.<id>` → (4) breadth: any configured+instantiated vision-capable model in broker precedence order → (5) none: warn + skip, lazy/idempotent so later model change can retry. NO name-similarity/context-window ranking. |
| D9  | Degradation (Q7): fail-open. Request seam timeout/failure → warn + send bare image (today's behavior). Flush failure → warn + skip (idempotent, retried later). Never hard-error on describer failure. |
| D10 | Retry (Q7b): borrow T1 ONLY (bounded silent auto-retry on 429/5xx honoring Retry-After + session.retry backoff), via a SHARED `withBoundedSilentRetry` helper used by BOTH `runWithRetry`'s T1 branch (conversation-service.ts:492) and the describer — one source of truth. NO T2. No separate T3 (already fails open). Outer ~60s timeout is the hard cap. |
| D11 | V1 loosening (Q8): per-tool image-extractor registry at the append/extraction seam — `file__read_image` gets a STRUCTURED extractor producing `DroneImageContent[]` directly; content-scan heuristic becomes the DEFAULT FALLBACK for unregistered tools. PLUS presentation-only base64 stripping on the wire, BOTH vision and non-vision targets. Storage/persistence/estimator unchanged. MCP stays on the content-heuristic fallback. |

## Implementation steps

### Phase 1 — drone-core: storage + token accounting + role name
1. `session-types.ts:42-47` — add `description?: string` to `DroneImageContent`.
2. `model-selection.ts` — add `'image_describer'` to `WELL_KNOWN_MODEL_ROLES`.
3. `token-estimate.ts:15-33` — per-image charge = `max(256, estimateTextTokens(description))`.
4. Tests (drone-core/test): DroneImageContent accepts description; token estimate uses max(256, desc); description persisted unchanged through JSON round-trip.
5. Run `pnpm -r run build` before Phase 3.

### Phase 2 — shared T1 silent-retry helper extraction (if not done in base plan)
6. Extract T1 branch of `runWithRetry` into exported `withBoundedSilentRetry` honoring `session.retry.{maxRetries,maxWaitMs,backoffBaseMs,backoffFactor}` + `Retry-After` on 429/5xx. `runWithRetry`'s T1 branch calls it; describer calls it too.
7. Tests: helper retries on 429/5xx, honors Retry-After + backoff, gives up at maxRetries.

### Phase 3 — broker: describer resolution + describeImages capability
8. Add internal vision-capability resolution reusing `resolveModelMetadata` to test a model's `hasVision`. Implement the D8 fallback chain.
9. Extend `DroneLlmCapability` with `describeImages: (images) => Promise<DroneImageContent[]>`.
10. Tests: D8 chain each step; statelessness; describeImages fills description, skips already-described, fails open + idempotent; describer chat uses resolved model + reasoningLevel + receives the image; warn-once dedup.
11. Sweep: LSP find-references + grep for `DroneLlmCapability` mocks/implementers; every complete test mock gains `describeImages`.

### Phase 4 — conversation-service: request-seam description + presentation stripping
12. Per-tool image-extractor registry (D11): register a structured extractor for `file__read_image`; keep `extractImageFromToolResult` as default fallback.
13. In the tool loop after extraction: when a tool message has images, run `describeImages` when EITHER (a) `log.enabled || swarm active` (D5 eager) OR (b) target model `hasVision === false` (D3 lazy). Store descriptions into the message's `DroneImageContent.description`.
14. Presentation stripping (D11): at request-assembly, for BOTH vision and non-vision targets, strip redundant base64 blob from content (leave marker). Vision → image via images[]; non-vision → substitute description text in content, image omitted.
15. Guard: ~60s describer timeout (D9) wraps describeImages in the request seam; on timeout/failure, send bare image, warn.
16. Tests: request seam describes when non-vision target (lazy, once-cached), NOT when vision target (unless durability gate on); durability gate forces eager describe at append; presentation strips blob for both cases; non-vision target gets description instead of image; vision target gets image via images[]; idempotency; tool-loop parallel-safety under Promise.all.

### Phase 5 — compaction: pre-compaction flush
17. Before building the summary (before `formatTurnsForSummary`): for each image-bearing tool message in those turns, call `llm.describeImages(...)` to flush descriptions, writing back onto the turns. Idempotent.
18. Test: pre-compaction flush describes undescribed images before summarization; already-described skipped; flush failure doesn't block compaction (fail-open, D9).

### Phase 6 — docs
19. `docs/agents/provider-model-config.md`: add `image_describer` to the well-known-roles table; document the vision-capability requirement + D8 fallback chain; document lazy-vs-eager durability gate; document that describer failures fail open. Add a short "Images & vision" note.

### Phase 7 — final verification
See Validation criteria; run in order.

## Dependencies / order
Strictly sequential: P1 → P2 (if helper absent) → P3 → P4 → P5 → P6 → P7.

## Validation criteria
1. `pnpm -r run build` — zero errors.
2. LSP diagnostics — zero errors across all packages (pre-existing coordinator-ui CSS warnings out of scope).
3. `pnpm lint` — zero errors.
4. `pnpm test` (fast suite) — fully green, including all image-describer tests.
5. Grep/behavior sweeps: `describeImages` present on broker capability + called at (request seam, pre-compaction, durability-eager); no `getActiveProvider().chat(` direct describer calls outside broker/runWithRetry; compaction still flushes before `formatTurnsForSummary`; no token-accounting regression (D7 exact `max`, not additive).
6. Manual smoke (optional).

---

## STATUS: COMPLETE (2026-08-27)

All 7 phases implemented and verified. The plan was largely implemented in prior commits on `feat/model-role-bindings`; this session closed the remaining gaps against the locked decisions:

**Fixed deviations:**
- **D8 breadth precedence**: breadth step now sorts providers by broker precedence (ollama=0, remote=1) via a shared `providerPrecedence` helper, instead of config insertion order. `getAvailableProviders` reuses the same helper.
- **D10 retry config**: describer now sources `session.retry.{maxRetries,maxWaitMs,backoffBaseMs,backoffFactor}` with `DEFAULT_RETRY_CONFIG` fallback, matching the main loop's `runWithRetry` T1 policy (was hardcoded 2/30s/1s/2).
- **D1 parallel-across-batch**: request-seam describe now runs across the batch via `Promise.all`, then applies results to the session store sequentially (was serial `await` per result).
- **D9 compaction timeout**: pre-compaction flush now wraps `describeImages` in a ~60s `withTimeout` guard so a hung describer can't block compaction (was unguarded).
- **Docs fail-open**: added the "both representations stored + describer failures fail open" paragraph to the Images & vision section.

**Tests added:**
- D8 breadth precedence ordering (ollama wins over openrouter even when declared second).
- D1 parallel-across-batch (durability gate on, two tool calls → two concurrent describe calls).
- Typed the recording driver in `llm-model-roles.test.ts` (fixes a pre-existing LSP error `'sent.messages' is of type 'unknown'`).

**Verification:** `pnpm -r run build` ✓, `pnpm lint` ✓, `pnpm test` (2350 passed, 9 skipped) ✓, LSP zero errors in touched files ✓, grep sweeps ✓.

**Key files:** `drone-core/src/{session-types,model-selection,token-estimate,capabilities}.ts`, `drone-agent/src/plugins/llm/index.ts`, `drone-agent/src/runtime/conversation-service.ts`, `drone-agent/src/plugins/compaction/index.ts`, `docs/agents/provider-model-config.md`, plus tests in `drone-core/test/` and `drone-agent/test/`.