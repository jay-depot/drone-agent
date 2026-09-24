---
key: plan-reference-expansion-image-inlining
tags:
  - plan
  - drone-agent
  - drone-core
  - reference-expansion
  - vision
  - images
  - feature
  - completed
created: 2026-09-21T02:31:55.188Z
updated: 2026-09-21T02:52:20.561Z
---

# Plan: Image-File Inlining in `@`-Reference Expansion

**Status**: COMPLETE (2026-09-20)
**Branch**: `feat/inline-object-refs`
**Implementation commit**: `7d6c0355`
**Created**: 2026-09-20
**Origin**: planning session (grilling, 12 questions) after confirming `@`-reference
expansion works end-to-end in the real app (host-wiring fix landed 2026-09-21).
**Related memories**: `plan-fix-reference-expansion-host-wiring`
**Related wiki**: `reference-expansion-and-tab-completion` (coordinator),
`drone-agent-image-content-refactor-v2` (coordinator),
`drone-agent-reference-expansion-internals` (coordinator),
`drone-agent-vision-image-pipeline` (coordinator)

---

## Original plan (unchanged, kept for reference)

### Summary (what and why)

`@`-references expand in user messages today for **text** files and skills
(`@README.md`, `@src/foo.ts`, `@skill:code-review`). An **image** reference
(`@pic.png`) does NOT work: the `file` resolver's binary sniff (a NUL byte in the
first 8000 bytes) classifies every PNG/JPEG/GIF/WebP as binary and emits
`[skipped binary: @pic.png]`.

This feature makes `@pic.png` (and `@assets/*.png`) attach the image to the **user
turn** through the existing vision path — the same path tool results already use.

The plumbing is already in place and deliberately reserved for this:

- `DroneReferenceResolution.images` / `DroneReferenceExpansion.images` exist and
  are documented in `drone-core/src/reference-types.ts:26-27` as
  *"v1: always empty; reserved for image refs"*.
- `expandAndAppend` (`drone-agent/src/runtime/conversation-service.ts:426-446`)
  **already forwards** `result.images` into
  `sessionManager.appendUserMessage(text, images?)`.
- The entire describe/present/budget/compaction pipeline is **role-agnostic** and
  needs **no change**: lazy `describeUndescribedImages` (:1693-1709),
  `prepareRequestMessages` (:1723-1749), compaction `flushImageDescriptions`
  (`plugins/compaction/index.ts:807-834`), and token accounting
  `max(256, estimateTextTokens(description))` (`drone-core/src/token-estimate.ts:17-34`).

So the work is: teach the `file` resolver to recognize images, return them via
`images[]` instead of a text block, and reuse the tool-image bounds.

### Locked decisions (all 12)

| # | Decision |
|---|----------|
| Q1 | **Extension-based** recognition inside the existing `file` kind. No new `@image:` namespace, no magic-byte sniffing. Reuse `read_image`'s extension set. |
| Q2 | Image references produce **no text block** — `block: ''`; the image rides only in `images[]`. |
| Q3 | Reuse `session.maxImageSizeBytes` (per image) and **generalize `session.maxImagesPerMessage` to all messages** via one shared cap helper. |
| Q4 | Adopt the **established tool-image standard verbatim** (size cap, count cap kept-first-N, omission marker, `max(256,desc)` accounting). The 1 MiB reference text budget is **untouched** (images never charge it). |
| Q5 | Success receipt: `[expanded @pic.png (image/png, 12.3 KB)]` — same `[expanded @…]` vocabulary; MIME type replaces the line count. |
| Q6 | **Direct file refs AND glob refs** attach images. Directory listings stay name-only (never attach). |
| Q7 | Directory-listing expansion ("inlining a directory's images") is **DEFERRED**. |
| Q8 | The extension→MIME helper lives in **`drone-core`** (the user anticipates coordinator use). |
| Q9 | Oversize image → **skip + notice** `[image too large: @pic.png (24.5 MB > 20 MB)]`, checked **before reading the file**. |
| Q10 | Read failure → **`[could not read: @…]`**, **uniform for text and image**. Split by error code: `ENOENT` → `[unresolved reference: @…]` (unchanged), everything else → `[could not read: @…]`. **Fs-level retry is DEFERRED**. |
| Q11 | Over-cap marker: `[N additional images omitted. Retrieve them individually if needed.]`. Globs do **not** enumerate the omitted names. |
| Q12 | The capability learns the image size limit via a **constructor option** on `createReferenceCapability`, threaded from `index.tsx`. |

### Accepted consequences

1. A user turn can now drop content the prose still references (recoverable for
   direct refs, opaque for globs).
2. Extension-based recognition trusts the name.
3. No partial-write detection.

### Explicitly NOT in scope

- Directory-listing inlining (Q7).
- Fs-level retry for reads (Q10).
- Partial/half-written file detection.
- Magic-byte image sniffing (Q1).
- Non-TUI tab completion for image refs.
- Any new reference image budget (Q4).

### Implementation steps (all executed)

1. `drone-core/src/image-mime.ts` (new) + index re-export
2. `drone-agent/src/plugins/file.ts` — consume the core helper
3. `file-kinds.ts` — image branch, `ReferenceLimits`, glob images, uniform notice
4. Plumb `maxImageBytes` (`capability.ts` + `index.tsx`)
5. `drone-agent/src/runtime/image-cap.ts` (new) + both call sites
6. Tests
7. Docs
8. Final verification

---

## EXECUTION SUMMARY (2026-09-20) — COMPLETE

Executed on branch `feat/inline-object-refs`. All 8 steps done; commit `7d6c0355`
(16 files, +676 / −51).

### What changed

- **Step 1** — new `drone-core/src/image-mime.ts`: dependency-free
  `IMAGE_MIME_BY_EXT`, `SUPPORTED_IMAGE_EXTENSIONS`, `imageMimeForExtension`,
  `imageMimeForPath` (handles `/` and `\` separators, case-insensitive).
  Re-exported from `drone-core/src/index.ts`.
- **Step 2** — `drone-agent/src/plugins/file.ts`: the inline private `mimeMap` in
  `file__read_image` was deleted; it now calls `imageMimeForPath` and builds its
  error message from `SUPPORTED_IMAGE_EXTENSIONS`. The throw-on-failure tool
  contract, `maxImageSizeBytes` check, `enhanceFsError` wrapping, and the
  structured `{ content, images }` return are unchanged.
- **Step 3** — `reference-expansion/file-kinds.ts`: new `ReferenceLimits` type;
  `buildFileBlock` gained an **image branch before the binary sniff** (stat →
  oversize check → full read → `images:[{mimeType,data}]`, `block: ''`, receipt
  `[expanded @x (mime, size)]`, `bytes: size`, **no budget charge**);
  `resolveGlob` threads `limits` and accumulates images (images counted in
  `included`/`bytes` for the aggregate receipt); `resolveDirectory` untouched;
  `resolveFileReference` takes `limits` and splits the read-failure notice by
  error code (`ENOENT` → unresolved, else → `[could not read: @…]`).
  `index.ts` re-exports `ReferenceLimits`.
- **Step 4** — `capability.ts`: `createReferenceCapability` gained a
  `maxImageBytes?` option (default `20 * 1024 * 1024`) and builds a
  `ReferenceLimits` passed to every `resolveFileReference` call. `index.tsx:196`
  passes `resolvedConfig.config.session.maxImageSizeBytes`. The
  `plugin-engine.ts:968` fallback was intentionally left as
  `createReferenceCapability()` (built-in default).
- **Step 5** — new `drone-agent/src/runtime/image-cap.ts`:
  `DEFAULT_MAX_IMAGES_PER_MESSAGE = 20`, `capImages` (kept-first-N),
  `toolImageOmissionMarker`, `referenceImageOmissionMarker`. `conversation-service.ts`
  now imports them; the tool-result cap site uses `capImages` + the tool marker
  (**byte-identical to before**), and `expandAndAppend` applies the cap to
  user-turn images and appends the reference marker to the text (used for both the
  append and the returned `userMessage` event).
- **Step 6** — new `drone-core/test/image-mime.test.ts` and
  `drone-agent/test/image-cap.test.ts`; `reference-expansion.test.ts` gained an
  "image references" describe (14 tests: attach/no-block, all extensions,
  case-insensitivity, oversize, at-limit, glob images, mixed glob, **budget
  exemption**, dir name-only, ENOENT, uniform could-not-read);
  `reference-expansion-integration.test.ts` gained two end-to-end tests (user turn
  carries `images`; 25-image glob caps to 20 with the reference marker). Plus one
  **extra** test in `conversation-service-image-describer.test.ts` proving the
  describer path works for a **user-turn** image reference (Q2 requirement).
- **Step 7** — `docs/agents/reference-expansion.md`: added the image grammar row,
  the no-text-block semantics, image limits (extensions, per-image size,
  per-message count, "does not consume the text budget"), the new notices, and
  moved the now-implemented image bullet out of "Deferred" (replaced with the
  still-deferred directory inlining / read retry / partial-write items).
  `AGENTS.md:175` gained "image files via the vision path".

### Files touched

| File | Change |
|---|---|
| `drone-core/src/image-mime.ts` | new |
| `drone-core/src/index.ts` | re-export + module-map comment |
| `drone-agent/src/plugins/file.ts` | consume core MIME helper |
| `drone-agent/src/runtime/reference-expansion/file-kinds.ts` | image branch + limits + glob + notice split |
| `drone-agent/src/runtime/reference-expansion/index.ts` | export `ReferenceLimits` |
| `drone-agent/src/runtime/reference-expansion/capability.ts` | `maxImageBytes` option |
| `drone-agent/src/index.tsx` | thread `maxImageSizeBytes` |
| `drone-agent/src/runtime/image-cap.ts` | new |
| `drone-agent/src/runtime/conversation-service.ts` | shared cap at both sites |
| `drone-core/test/image-mime.test.ts` | new |
| `drone-agent/test/image-cap.test.ts` | new |
| `drone-agent/test/reference-expansion.test.ts` | image suite |
| `drone-agent/test/reference-expansion-integration.test.ts` | 2 e2e tests |
| `drone-agent/test/conversation-service-image-describer.test.ts` | user-turn describer test |
| `docs/agents/reference-expansion.md` | docs |
| `AGENTS.md` | bullet |

### Deviations from the plan (and why)

1. **One test expectation corrected.** The planned "mixes images and text in one
   glob" test used a bare `@*` pattern. It failed because the **pre-existing**
   notice-gating rule (`capability.ts`: file-like notices are suppressed unless the
   token contains `/` or `.`) intentionally treats a bare token as prose. The
   **implementation was correct**; the test was changed to the dotted pattern
   `@*.{png,md}` (how such a glob is actually written). No source change resulted.
2. **V9 interactive check substituted.** The plan's final acceptance asked for a
   manual TUI run with vision and non-vision models. No LLM was available (the
   `echo` provider requires an echo-llm HTTP service; a first attempt hung on open
   stdin). Instead the criterion was covered by (a) a **new permanent automated
   test** for the describer-on-user-turn path, and (b) a dist-level behavioural
   script. Both passed.
3. **One test added beyond plan scope.** The describer-on-user-turn test was not
   listed in Step 6, but it is the direct regression guard for the Q2 requirement
   ("the image-describing alternative model path must function here"), so it was
   made permanent rather than verified ad hoc.

### Validation results

All criteria passed.

1. **LSP clean** — no errors/warnings in any changed file (workspace shows only
   pre-existing hints elsewhere).
2. **`pnpm -r run typecheck`** — exit 0.
3. **`pnpm -r run build`** — exit 0.
4. **`pnpm lint`** — exit 0. Prettier re-dirtied `pnpm-lock.yaml` on both runs
   (pure reformatting, no dependency change); reverted each time per the plan.
5. **`pnpm test`** — 229 files, **3194 passed**, 14 skipped, 0 failed, exit 0.
   *The plan's "~10 pre-existing TUI failures" note is stale — the suite is fully
   green at this commit.*
6. **Behavioural checks** (proved against the **built dist**):
   image bytes match the file; no text block; correct receipt; a >1 MiB image does
   **not** charge the text budget (a following `@notes.md` still inlines); over-cap
   → kept-first-N + reference marker; `[could not read: @…]` for **both** `.md` and
   `.png`; `ENOENT` → `[unresolved reference: @…]`; and the **tool marker string is
   byte-identical to `HEAD`** (verified with a git blob comparison).
7. **No duplicated MIME knowledge** — `grep image/jpeg|image/png|image/webp` over
   `drone-agent/src` returns nothing; the only table is `drone-core/src/image-mime.ts`.
8. **No stale consumers** — the sole `resolveFileReference` call site
   (`capability.ts:44`) passes `limits`.
9. **Manual TUI** — substituted (see deviation 2); covered by automated tests.
10. **Done-when re-check** — every step's criterion verified.

Note: `TEST.md` was never present at the repo root and was not committed.

### Follow-ups (not in this plan)

- Directory-listing inlining (Q7) — the user had not yet tested the existing
  directory-listing behaviour.
- Fs-level read retry (Q10) — deferred: the causes are rare and mostly stable, and
  a retry cannot fix a half-written file.
- Partial-write detection.
- The `plugin-engine.ts:968` implicit-capability fallback keeps the hard-coded
  20 MB default; a host seeding the capability itself gets the config value.
