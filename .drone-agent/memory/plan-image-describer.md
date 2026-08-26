---
key: plan-image-describer
tags:
  - plan
  - image_describer
  - vision
  - llm
  - roles
created: 2026-08-26T22:23:30.948Z
updated: 2026-08-26T22:23:30.948Z
---

# PLAN: `image_describer` role — describe images for non-vision models, as abstract context

Branch: `feat/model-role-bindings` (same branch as prerequisite `plan-model-role-bindings`). Write this on the same branch, after `plan-model-role-bindings` is complete/merged.

## Prerequisite (locked)
`plan-model-role-bindings` COMPLETE: `llm.modelRoles: Record<string,string>` config (user scope only, per-key merge, startup validation), `DroneLlmCapability.resolveModelForRole(role)` → `{ provider, providerId, model, reasoningLevel? }`, well-known roles `['summarizer','wizard','describer']`, shared `resolveConfiguredReasoningLevel` helper, shared `withBoundedSilentRetry` (extracted T1 loop) existing.

`image_describer` SLOTS INTO the open role namespace: add `'image_describer'` to `WELL_KNOWN_MODEL_ROLES` (drone-core/src/model-selection.ts). All base-plan machinery (fallback-on-broken-role, warn-once-per-role, stateless resolution, scope policy, docs) applies unchanged.

## Summary
When a tool result contains an image (e.g. `file__read_image`) and the target model is NOT vision-capable, describe the image (via the `image_describer` model) and store the description alongside the image in the abstract context. Presentation is derived per-request: vision-capable target → send image (status quo); non-vision target → send description (image omitted). The stored turn is model-agnostic (image + description both persisted); exactly one representation crosses the wire per model. Describer failures degrade fail-open (never worse than today). Also a V1 "loosening" that makes file-tool images structured at the seam, teeing up the V2 content refactor (`image-content-refactor-v2` memory).

## Locked decisions

| # | Decision |
|---|----------|
| D1 | Seam: conversation-service tool loop, BESIDE truncation, BEFORE append. Parallel across batch (Promise.all). Synchronous-with-batch (description needed before next LLM send). Timeout-guarded ~60s (aligned with retry maxWaitMs). |
| D2 | Abstract context: stored turn holds image + description (both persisted); presentation derived per-request by target `hasVision`. `image_describer` model must itself be vision-capable (receives the image it describes). |
| D3 | Generation: LAZY-ONCE cached. Generate only when a non-vision model is about to receive the image; persist description into stored message; subsequent requests reuse. Vision-capable sessions never generate. Must land before compaction. |
| D4 | Pre-compaction flush: shared `describeImages(images)` capability broker-side (owns role resolution + provider access), returns images with descriptions filled; caller (conversation-service, compaction) owns write-back onto its turns. Idempotent (skip already-described). Triggers: (a) request seam lazy, (b) pre-compaction before formatTurnsForSummary. |
| D5 | Durability (C2): description lands in log/swarm persisted store, gated `log.enabled \|\| swarm active`. EAGER-when-persisting at append time iff that gate; else lazy (D3). Structural guarantee, no shutdown race. NOT on safety-drop (safety trim drops turns wholesale, no carrier; dropped turns never reach store). |
| D6 | Storage: `description?: string` on `DroneImageContent` (drone-core/src/session-types.ts:42-47), per-image, persisted verbatim. Survives log/swarm JSON round-trips (no schema validation on those stores). Multi-image tool results: describe each independently. |
| D7 | Token accounting (Q5): per-image budget contribution = `max(256, estimateTextTokens(description))` in `estimateMessageTokens` (token-estimate.ts:15-33). Model-agnostic (no hasVision at estimate time). Do NOT fix the base64 double-count (content-text + images[]) — pre-existing, deferred to V2. |
| D8 | Describer vision fallback chain (Q6): (1) configured `image_describer` if vision-capable → (2) active selection if vision-capable → (3) SAME PROVIDER ENTRY as pinned describer: any vision-capable model under that exact `config.providers.<id>` → (4) breadth: any configured+instantiated vision-capable model in broker precedence order → (5) none: warn + skip, lazy/idempotent so later model change can retry. NO name-similarity/context-window ranking (guessing without price probe). NOTE: "fall back to active" alone is WRONG at the request seam (active is the non-vision model that triggered describing). |
| D9 | Degradation (Q7): fail-open. Request seam timeout/failure → warn + send bare image (today's behavior). Flush failure → warn + skip (idempotent, retried later). Never hard-error on describer failure. |
| D10 | Retry (Q7b): borrow T1 ONLY (bounded silent auto-retry on 429/5xx honoring Retry-After + session.retry backoff), via a SHARED `withBoundedSilentRetry` helper used by BOTH `runWithRetry`'s T1 branch (conversation-service.ts:492) and the describer — one source of truth. NO T2 (no user prompting for background artifact work). No separate T3 (already fails open). Outer ~60s timeout is the hard cap. |
| D11 | V1 loosening (Q8): per-tool image-extractor registry at the append/extraction seam — `file__read_image` gets a STRUCTURED extractor producing `DroneImageContent[]` directly (knows its own return shape); content-scan heuristic (`extractImageFromToolResult`/`findDataUri`, conversation-service.ts:1121-1160) becomes the DEFAULT FALLBACK for unregistered tools. PLUS presentation-only base64 stripping on the wire, BOTH vision and non-vision targets (image carried via `images[]`; leave marker in content text). Storage/persistence/estimator unchanged. MCP stays on the content-heuristic fallback (raw image blocks deferred to V2). |

## Implementation steps

### Phase 1 — drone-core: storage + token accounting + role name
Assignee: coder. Files: `drone-core/src/`.

1. `session-types.ts:42-47` — add `description?: string` to `DroneImageContent` (jsdoc: "Model-generated description of the image, used as the wire representation when the target model is not vision-capable. Stored as part of the abstract context.").
2. `model-selection.ts` — add `'image_describer'` to `WELL_KNOWN_MODEL_ROLES` (becomes `['summarizer','wizard','describer','image_describer']`).
3. `token-estimate.ts:15-33` — change the per-image charge from flat `256` to `256 + estimateTextTokens(description ?? '')`... CAREFUL — locked decision D7 is `max(256, estimateTextTokens(description))`, NOT additive. Implement: for each image, `const descTokens = estimateTextTokens(image.description ?? ''); sum += Math.max(256, descTokens)`. Verify the existing 256/image call site is the one to change.
4. Tests (drone-core/test): DroneImageContent accepts description; token estimate uses max(256, desc) for a present description and 256 for absent; description persisted unchanged through JSON round-trip.
5. Run `pnpm -r run build` (dependent packages resolve drone-core types from dist/) before Phase 3.

### Phase 2 — shared T1 silent-retry helper extraction (if not done in base plan)
Assignee: coder. NOTE: if `withBoundedSilentRetry` already exists from `plan-model-role-bindings` (it was proposed there for the describer; verify), SKIP this phase and just consume it.

6. Extract the T1 branch of `runWithRetry` (conversation-service.ts:492+) into an exported helper `withBoundedSilentRetry(request, config, attempt)` (name TBD; location e.g. drone-core or a runtime/shared module) honoring `session.retry.{maxRetries,maxWaitMs,backoffBaseMs,backoffFactor}` + `Retry-After` on 429/5xx. `runWithRetry`'s T1 branch calls it; describer calls it too.
7. Tests: helper retries on 429/5xx, honors Retry-After + backoff, gives up at maxRetries; main loop behavior unchanged (existing runWithRetry tests stay green).

### Phase 3 — broker: describer resolution + describeImages capability
Assignee: coder. File: `drone-agent/src/plugins/llm/index.ts`.

8. Add internal vision-capability resolution reusing `resolveModelMetadata` (llm/index.ts:254-302) to test a model's `hasVision`. Implement the D8 fallback chain producing a `{ provider, providerId, model, reasoningLevel? }` describer selection: pinned image_describer (if vision) → active (if vision) → same provider entry → breadth (precedence) → null (warn+skip).
9. Extend `DroneLlmCapability` (drone-core/src/capabilities.ts:146-198) with:
   ```ts
   /** Describe images that lack descriptions, using the image_describer model (or a vision-capable fallback). Returns images with `description` filled; skips already-described. */
   describeImages: (images: DroneImageContent[]) => Promise<DroneImageContent[]>;
   ```
   Implementation: filter undescribed images → resolve describer via D8 chain → call `describerProvider.chat({ model, reasoningLevel, messages: [describerSystemPrompt, { role:'user', content: 'Describe this image...', images: [img] }] })` per image (or batched; decide batch strategy) wrapped in `withBoundedSilentRetry` + ~60s timeout → on success set `img.description = text`; on failure/timeout/no-describer → leave undescribed (idempotent), warn-once-per-session. Uses the plugin's existing logger.
10. Tests (test/plugins/llm/*): D8 chain each step (pinned-vision → active-vision → same-entry → breadth → none+skip); statelessness (never mutates active selection); describeImages fills description, skips already-described, fails open + idempotent; describer chat uses resolved model + reasoningLevel + receives the image; warn-once dedup.
11. Sweep: LSP find-references + grep for `DroneLlmCapability` mocks/implementers; every complete test mock gains `describeImages` (structural inline types in consumers do NOT break; full mocks DO).

### Phase 4 — conversation-service: request-seam description + presentation stripping
Assignee: coder. File: `drone-agent/src/runtime/conversation-service.ts`.

12. Per-tool image-extractor registry (D11): register a structured extractor for `file__read_image` producing `DroneImageContent[]` from its JSON result; keep `extractImageFromToolResult` as default fallback. (Where the registry lives: a small map in conversation-service or a shared module; file.ts just gains an entry or a marker.)
13. In the tool loop after extraction (the block near :710-728 that does Anthropic-inline vs synthetic user message): when a tool message has images, run the D4 `describeImages` when EITHER (a) `log.enabled || swarm active` (D5 eager) — ALWAYS describe at append if the durability gate is on — OR (b) the target model `hasVision === false` (D3 lazy). Store descriptions into the message's `DroneImageContent.description`.
14. Presentation stripping (D11): at request-assembly (where tool messages become LLM request parts), for BOTH vision and non-vision targets, if the image is carried via `images[]`, strip the redundant base64 blob from the content string (leave a marker like `[Image: <path> attached]`). Vision → image via images[]; non-vision → substitute description text in content, image omitted. Storage/estimator untouched.
15. Guard: the ~60s describer timeout (D9) wraps describeImages in the request seam; on timeout/failure, send bare image (today's behavior), warn.
16. Tests: request seam describes when non-vision target (lazy, once-cached), NOT when vision target (unless durability gate on); durability gate forces eager describe at append; presentation strips blob for both cases; non-vision target gets description instead of image; vision target gets image via images[]; idempotency (second send reuses stored description); tool-loop parallel-safety under Promise.all.

### Phase 5 — compaction: pre-compaction flush
Assignee: coder. File: `drone-agent/src/plugins/compaction/index.ts`.

17. Before building the summary (before `formatTurnsForSummary` on the oldest non-summary turns being compacted): for each image-bearing tool message in those turns, call `llm.describeImages(...)` to flush descriptions, writing back onto the turns. Idempotent — only undescribed images described. This ensures the summary (which may be produced by a non-vision `summarizer`) sees the description text and captures its semantics, so abstract context survives the compaction boundary even though image bytes are destroyed.
18. Test: pre-compaction flush describes undescribed images before summarization; already-described skipped; flush failure doesn't block compaction (fail-open, D9).

### Phase 6 — docs
Assignee: coder.

19. `docs/agents/provider-model-config.md`: add `image_describer` to the well-known-roles table; document the vision-capability requirement + D8 fallback chain; document lazy-vs-eager durability gate; document that describer failures fail open. Add a short "Images & vision" note: non-vision models receive descriptions, vision models receive images, both representations stored.

### Phase 7 — final verification
Assignee: tester/reviewer. See Validation criteria; run in order.

## Dependencies / order
Strictly sequential: P1 → P2 (if helper absent) → P3 → P4 → P5 → P6 → P7. P1 ends with a full rebuild. P4 and P5 both depend on P3's capability. P5 (compaction flush) is independent of P4's request-seam logic but shares the capability.

## Validation criteria
1. `pnpm -r run build` — zero errors.
2. LSP diagnostics — zero errors across all packages (pre-existing coordinator-ui CSS warnings out of scope).
3. `pnpm lint` — zero errors (re-read files after prettier reformats).
4. `pnpm test` (fast suite) — fully green, including: drone-core image type + token `max(256, desc)` tests; broker D8 chain + statelessness + describeImages + fail-open tests; conversation-service request-seam lazy/eager + presentation-stripping + idempotency tests; compaction pre-flush test.
5. Grep/behavior sweeps: `describeImages` present on broker capability + called at (request seam, pre-compaction, durability-eager); no `getActiveProvider().chat(` direct describer calls outside broker/runWithRetry; compaction still flushes before `formatTurnsForSummary`; no token-accounting regression (D7 exact `max`, not additive).
6. Manual smoke (optional, host-permitting): pin `image_describer` to a vision model + active to a non-vision model; `file__read_image` then a user turn; observe the non-vision model receives the description (not the blob), the stored/logged turn holds both image + description, and a later vision-capable `/model` switch shows the image again (presentation re-derives, no regeneration).
