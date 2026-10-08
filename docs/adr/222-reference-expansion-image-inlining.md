---
tags: [decision, drone-agent, drone-core, reference-expansion, vision, images]
related:
  [
    decisions/218-reference-expansion-and-tab-completion.md,
    decisions/221-reference-expansion-host-wiring.md,
    decisions/167-image-content-refactor-v2.md,
    concepts/reference-expansion.md,
    concepts/vision-support.md,
    modules/drone-core.md,
    modules/drone-agent.md,
  ]
---

# 222 — Image-file inlining in `@`-reference expansion

**Summary**: `@pic.png` (and `@assets/*.png`) now attach the image to the **user turn** through the existing vision path, instead of being rejected by the file resolver's binary sniff (`[skipped binary: @pic.png]`). The images contract was already reserved and threaded end-to-end — this teaches the `file:` resolver to recognize images by extension, return them via `images[]`, and reuse the tool-image bounds.

## Context

`DroneReferenceResolution.images` / `DroneReferenceExpansion.images` existed and were documented as _"v1: always empty; reserved for image refs"_, and `expandAndAppend` already forwarded `result.images` into `sessionManager.appendUserMessage(text, images?)`. The describe/present/budget/compaction pipeline is role-agnostic and needed **no change** (lazy `describeUndescribedImages`, `prepareRequestMessages`, compaction `flushImageDescriptions`, token `max(256, desc)`). The only blocker was the resolver's NUL-byte binary sniff classifying every PNG/JPEG/GIF/WebP as binary.

## Decision (12 locked choices)

| #   | Choice                                                                                                                                                                                                            |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | **Extension-based** recognition inside the existing `file` kind — no new `@image:` namespace, no magic-byte sniffing; reuse `read_image`'s extension set                                                          |
| Q2  | Image refs produce **no text block** (`block: ''`) — the image rides only in `images[]`                                                                                                                           |
| Q3  | Reuse `session.maxImageSizeBytes` (per image) and **generalize `session.maxImagesPerMessage` to all messages** via one shared cap helper                                                                          |
| Q4  | Adopt the **established tool-image standard verbatim** (size cap, count cap kept-first-N, omission marker, `max(256,desc)` accounting); the 1 MiB reference **text** budget is untouched (images never charge it) |
| Q5  | Success receipt `[expanded @pic.png (image/png, 12.3 KB)]` — same `[expanded @…]` vocabulary; MIME replaces the line count                                                                                        |
| Q6  | **Direct file refs AND glob refs** attach images; directory listings stay name-only                                                                                                                               |
| Q7  | Directory-listing inlining ("inlining a directory's images") is **DEFERRED**                                                                                                                                      |
| Q8  | The extension→MIME helper lives in **`drone-core`**                                                                                                                                                               |
| Q9  | Oversize image → skip + notice `[image too large: @pic.png (24.5 MB > 20 MB)]`, checked **before reading** the file                                                                                               |
| Q10 | Read failure → **`[could not read: @…]`**, uniform for text and image; `ENOENT` stays `[unresolved reference: @…]`; fs-level retry DEFERRED                                                                       |
| Q11 | Over-cap marker `[N additional images omitted. Retrieve them individually if needed.]`; globs do **not** enumerate omitted names                                                                                  |
| Q12 | The capability learns the image size limit via a **constructor option** on `createReferenceCapability`, threaded from `index.tsx`                                                                                 |

## Implementation

- **`drone-core/src/image-mime.ts`** (new, dependency-free): `IMAGE_MIME_BY_EXT`, `SUPPORTED_IMAGE_EXTENSIONS`, `imageMimeForExtension`, `imageMimeForPath` (handles `/` and `\`, case-insensitive) — the single source of truth shared by `file__read_image` and the resolver.
- **`plugins/file.ts`**: the inline private `mimeMap` in `file__read_image` was deleted; it now calls `imageMimeForPath` and builds its error from `SUPPORTED_IMAGE_EXTENSIONS` (tool contract unchanged).
- **`file-kinds.ts`**: new `ReferenceLimits` type; `buildFileBlock` gains an **image branch before the binary sniff** (stat → oversize → read → `images:[{mimeType,data}]`, `block:''`, receipt, no budget charge); `resolveGlob` threads `limits` and accumulates images; `resolveFileReference` splits the read-failure notice by error code.
- **`capability.ts`** + **`index.tsx`**: `createReferenceCapability` gains `maxImageBytes` (default 20 MiB), fed `session.maxImageSizeBytes`.
- **`runtime/image-cap.ts`** (new): `DEFAULT_MAX_IMAGES_PER_MESSAGE = 20`, `capImages` (kept-first-N), `toolImageOmissionMarker`, `referenceImageOmissionMarker`. `conversation-service.ts` applies the cap in `expandAndAppend` (user-turn images + reference marker); the tool-result cap site uses the tool marker **byte-identically to before**.

## Consequences

1. A user turn can now drop content the prose still references (recoverable for a direct ref, opaque for a glob).
2. Extension-based recognition trusts the filename.
3. No partial-write detection.

## Out of scope

Directory-listing inlining (Q7); fs-level retry (Q10); partial/half-written detection; magic-byte sniffing (Q1); non-TUI tab completion for image refs; any new reference image budget (Q4).

## Follow-ups

- The `plugin-engine.ts` implicit-capability fallback (`createReferenceCapability()` with no options) keeps the hard-coded 20 MB default; only a host that seeds the capability itself (as `index.tsx` does) gets the config value.

## Validation

- New suites: `drone-core/test/image-mime.test.ts`, `drone-agent/test/image-cap.test.ts`; `reference-expansion.test.ts` gained an "image references" describe (14 tests: attach/no-block, all extensions, case-insensitivity, oversize, at-limit, glob images, mixed glob, **budget exemption**, dir name-only, ENOENT, uniform could-not-read); integration + a describer-on-user-turn regression test.
- Three deviations recorded during execution; V1–V10 all passed. The manual TUI acceptance (vision + non-vision models) was substituted — no LLM was available — and covered instead by a permanent describer-on-user-turn regression test plus a dist-level behavioural script. `pnpm test` 3194 passed / 14 skipped / 0 failed.

## Related

- [218-reference-expansion-and-tab-completion](218-reference-expansion-and-tab-completion.md) — the reference-expansion feature this extends
- [221-reference-expansion-host-wiring](221-reference-expansion-host-wiring.md) — the sibling fix that made expansion actually fire in hosts
- [167-image-content-refactor-v2](167-image-content-refactor-v2.md) — the structured `DroneToolResult.images[]` + `maxImagesPerMessage` standard reused here
- reference-expansion / vision-support — concept pages
- [drone-core](../../drone-core/) (`image-mime.ts`) / [drone-agent](../../drone-agent/) (`image-cap.ts`)
