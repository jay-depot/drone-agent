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
created: 2026-09-21T02:31:55.188Z
updated: 2026-09-21T02:31:55.188Z
---

# Plan: Image-File Inlining in `@`-Reference Expansion

**Status**: READY FOR EXECUTION
**Created**: 2026-09-20
**Origin**: planning session (grilling, 12 questions) after confirming `@`-reference
expansion works end-to-end in the real app (host-wiring fix landed 2026-09-21).
**Related memories**: `plan-fix-reference-expansion-host-wiring` (the host-wiring fix
that made expansion actually fire)
**Related wiki**: `reference-expansion-and-tab-completion` (coordinator),
`drone-agent-image-content-refactor-v2` (coordinator),
`drone-agent-reference-expansion-internals` (coordinator),
`drone-agent-vision-image-pipeline` (coordinator)

## Summary (what and why)

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

## Locked decisions (all 12)

| # | Decision |
|---|----------|
| Q1 | **Extension-based** recognition inside the existing `file` kind. No new `@image:` namespace, no magic-byte sniffing. Reuse `read_image`'s extension set. |
| Q2 | Image references produce **no text block** — `block: ''`; the image rides only in `images[]`. |
| Q3 | Reuse `session.maxImageSizeBytes` (per image) and **generalize `session.maxImagesPerMessage` to all messages** via one shared cap helper. |
| Q4 | Adopt the **established tool-image standard verbatim** (size cap, count cap kept-first-N, omission marker, `max(256,desc)` accounting). The 1 MiB reference text budget is **untouched** (images never charge it). |
| Q5 | Success receipt: `[expanded @pic.png (image/png, 12.3 KB)]` — same `[expanded @…]` vocabulary; MIME type replaces the line count. |
| Q6 | **Direct file refs AND glob refs** attach images. Directory listings stay name-only (never attach). |
| Q7 | Directory-listing expansion ("inlining a directory's images") is **DEFERRED** — the user has not yet tested the existing directory-listing behaviour. |
| Q8 | The extension→MIME helper lives in **`drone-core`** (the user anticipates coordinator use). |
| Q9 | Oversize image → **skip + notice** `[image too large: @pic.png (24.5 MB > 20 MB)]`, checked **before reading the file**. |
| Q10 | Read failure → **`[could not read: @…]`**, **uniform for text and image**. Split by error code: `ENOENT` → `[unresolved reference: @…]` (unchanged), everything else → `[could not read: @…]`. **Fs-level retry is DEFERRED** (rare + stable causes; a half-written file yields a partial read, which no retry fixes). |
| Q11 | Over-cap marker: `[N additional images omitted. Retrieve them individually if needed.]`. Globs do **not** enumerate the omitted names. |
| Q12 | The capability learns the image size limit via a **constructor option** on `createReferenceCapability`, threaded from `index.tsx`. |

### Accepted consequences (state these, don't rediscover them)

1. **A user turn can now drop content the prose still references.** With
   `maxImagesPerMessage` generalized, a message with >N image refs keeps the first N.
   For **direct refs** this is recoverable — every `@token` stays in the prose, so the
   model knows the full list and can fetch the rest with `file__read_image`. For
   **globs** the omitted names appear nowhere in context (Q11/(i)), so the count and
   receipt are all the model gets.
2. **Extension-based recognition trusts the name.** A `.png` file that is actually
   text will be attached as an image; an `.avif`/`.svg`/`.bmp` (not in the set) falls
   through to today's text/binary-skip path. There is no "unsupported image" error —
   an unrecognized extension is simply not an image.
3. **No partial-write detection.** Referencing a file mid-write yields a truncated
   image. Out of scope (Q10).

## Explicitly NOT in scope

- Directory-listing inlining (Q7).
- Fs-level retry for reads (Q10).
- Partial/half-written file detection.
- Magic-byte image sniffing (Q1).
- Non-TUI tab completion for image refs.
- Any new reference image budget (Q4).

## Implementation

Execute in order. Steps are atomic and independently verifiable.

---

### Step 1 — `drone-core`: shared extension→MIME helper (coder)

**New file**: `drone-core/src/image-mime.ts`

Must be **pure and dependency-free** (no `node:path`, no `node:fs`) so it is
browser-safe for consumers that import `drone-core`.

```ts
// ── Image MIME detection ────────────────────────────────────────────
//
// Single source of truth for which file extensions count as images and what
// MIME type they carry. Shared by `file__read_image` and the `file`
// `@`-reference resolver so the two can never disagree.
//
// Deliberately dependency-free (no node:path / node:fs) so drone-core stays
// importable outside Node.

export const IMAGE_MIME_BY_EXT: Readonly<Record<string, string>> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

/** Extensions (with leading dot) recognized as images, in declaration order. */
export const SUPPORTED_IMAGE_EXTENSIONS: readonly string[] =
  Object.keys(IMAGE_MIME_BY_EXT);

/**
 * MIME type for a lower-cased extension (e.g. `.png`), or `undefined` when the
 * extension is not a recognized image format.
 */
export function imageMimeForExtension(ext: string): string | undefined {
  const dot = ext.lastIndexOf('.');
  if (dot < 0) return undefined;
  return IMAGE_MIME_BY_EXT[ext.slice(dot).toLowerCase()];
}

/**
 * MIME type for a file path, or `undefined` when the path's extension is not a
 * recognized image format. Extension-only (no content sniffing).
 */
export function imageMimeForPath(filePath: string): string | undefined {
  const slash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  return imageMimeForExtension(filePath.slice(slash + 1));
}
```

**Also**: add `export * from './image-mime.js';` (or explicit named re-exports,
matching the file's existing style) to `drone-core/src/index.ts`.

**Step 1 done when**: `imageMimeForPath('a/b/pic.PNG')` → `'image/png'`;
`imageMimeForPath('notes.md')` → `undefined`; `imageMimeForPath('noext')` →
`undefined`; `imageMimeForPath('pic.tar.gz')` → `undefined`.

---

### Step 2 — `file__read_image` consumes the helper (coder)

**File**: `drone-agent/src/plugins/file.ts` (registration at lines ~515-578)

Delete the inline private `mimeMap` (lines ~538-551) and use the core helper.

Replace:

```ts
const ext = path.extname(filePath).toLowerCase();
const mimeMap: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};
const mimeType = mimeMap[ext];
if (!mimeType) {
  throw new Error(
    `file__read_image: unsupported image format "${ext}". Supported formats: .jpg, .jpeg, .png, .webp, .gif`
  );
}
```

with:

```ts
const mimeType = imageMimeForPath(filePath);
if (!mimeType) {
  throw new Error(
    `file__read_image: unsupported image format "${path.extname(filePath)}". ` +
      `Supported formats: ${SUPPORTED_IMAGE_EXTENSIONS.join(', ')}`
  );
}
```

Add `imageMimeForPath` and `SUPPORTED_IMAGE_EXTENSIONS` to the existing
`drone-core` import block. Keep the `maxImageSizeBytes` check, `enhanceFsError`
wrapping, and the structured return (`{ content, images: [{ mimeType, data }] }`)
**exactly as they are** — `read_image` keeps throwing on failure (tool contract);
only the reference path skips-and-notices.

**Step 2 done when**: `file.test.ts`'s `read_image` suite still passes; error
message still lists the five extensions.

---

### Step 3 — `file-kinds.ts`: image branch + uniform read-failure notice (coder)

**File**: `drone-agent/src/runtime/reference-expansion/file-kinds.ts`

**3a.** Add imports: `readFile` to the existing `node:fs/promises` import, and
`imageMimeForPath`, `type DroneImageContent` to the `drone-core` import.

**3b.** Add the limits type near the other constants:

```ts
export type ReferenceLimits = {
  /** Reject (skip) any single image larger than this many bytes. */
  maxImageBytes: number;
};
```

**3c.** In `buildFileBlock`, accept `limits` and branch on image **before** the
binary sniff. Full replacement of the function body's opening:

```ts
async function buildFileBlock(
  displayPath: string,
  absPath: string,
  budget: ExpansionBudget,
  limits: ReferenceLimits
): Promise<BuiltFileBlock> {
  if (budget.used >= budget.limit) {
    return {
      block: '',
      images: [],
      notice: `[expansion budget exceeded; @${displayPath} not included]`,
      bytes: 0,
      lines: 0,
    };
  }

  const mimeType = imageMimeForPath(absPath);
  if (mimeType) {
    const { size } = await stat(absPath);
    if (size > limits.maxImageBytes) {
      return {
        block: '',
        images: [],
        notice: `[image too large: @${displayPath} (${formatBytes(size)} > ${formatBytes(limits.maxImageBytes)})]`,
        bytes: 0,
        lines: 0,
      };
    }
    const buf = await readFile(absPath);
    return {
      block: '',
      images: [{ mimeType, data: buf.toString('base64') }],
      dedupKey: await dedupKeyFor(absPath),
      notice: `[expanded @${displayPath} (${mimeType}, ${formatBytes(size)})]`,
      bytes: size,
      lines: 0,
    };
  }

  // …existing text path unchanged (bounded read, NUL sniff, line cap,
  //    budget charge, fenced block, `[expanded … (N lines, B)]` receipt)…
```

Notes:
- Images are read **in full** (not via `readBounded`) and **never charge the text
  budget** (Q4).
- `bytes` is set to the image byte count so glob receipts aggregate image size.
- The size check precedes the read (Q9). A `stat`-then-`readFile` TOCTOU window is
  accepted.

**3d.** Thread `limits` through `resolveGlob` (signature + the `buildFileBlock` call)
and accumulate images. In `resolveGlob`:

```ts
async function resolveGlob(
  value: string,
  ctx: DroneReferenceContext,
  budget: ExpansionBudget,
  limits: ReferenceLimits
): Promise<DroneReferenceResolution> {
  const all = await globMatches(value, ctx);
  if (all.length === 0) {
    return { block: '', images: [], notice: `[unresolved reference: @${value}]` };
  }
  const shown = all.slice(0, MAX_GLOB_MATCHES);
  const parts: string[] = [];
  const images: DroneImageContent[] = [];
  let included = 0;
  let skipped = 0;
  let bytes = 0;
  for (const abs of shown) {
    const display = path.relative(ctx.cwd, abs) || abs;
    const res = await buildFileBlock(display, abs, budget, limits);
    if (res.block) {
      parts.push(`**${display}**\n${res.block}`);
      included += 1;
      bytes += res.bytes;
    } else if (res.images.length > 0) {
      images.push(...res.images);
      included += 1;
      bytes += res.bytes;
    } else {
      skipped += 1;
    }
  }
  let block = parts.join('\n\n');
  if (all.length > MAX_GLOB_MATCHES) {
    block += `\n\n[… matched ${all.length}, showing ${MAX_GLOB_MATCHES}]`;
  }
  let notice: string | undefined;
  if (included > 0) {
    const fileWord = included === 1 ? 'file' : 'files';
    const skipSuffix = skipped > 0 ? `, ${skipped} skipped` : '';
    notice = `[expanded @${value} (${included} ${fileWord}, ${formatBytes(bytes)}${skipSuffix})]`;
  }
  return { block, images, dedupKey: `glob:${value}`, notice };
}
```

**3e.** `resolveDirectory` is **unchanged** (Q6/Q7 — name-only, never attaches).

**3f.** `resolveFileReference` gains `limits` and splits the read-failure notice (Q10):

```ts
export async function resolveFileReference(
  value: string,
  ctx: DroneReferenceContext,
  budget: ExpansionBudget,
  limits: ReferenceLimits
): Promise<DroneReferenceResolution> {
  if (value === '') {
    return { block: '', images: [] };
  }
  if (value.includes('*') || value.includes('?')) {
    return resolveGlob(value, ctx, budget, limits);
  }
  const absPath = resolveReferencePath(value, ctx);
  let stats;
  try {
    stats = await stat(absPath);
  } catch {
    return { block: '', images: [], notice: `[unresolved reference: @${value}]` };
  }
  if (stats.isDirectory()) {
    return resolveDirectory(absPath);
  }
  try {
    return await buildFileBlock(value, absPath, budget, limits);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    return {
      block: '',
      images: [],
      notice:
        code === 'ENOENT'
          ? `[unresolved reference: @${value}]`
          : `[could not read: @${value}]`,
    };
  }
}
```

This one change makes the notice **uniform for text and image** (both go through
`buildFileBlock` → read).

**3g.** Update `index.ts`'s re-exports: add `type ReferenceLimits` to the
`file-kinds.js` export block.

**Step 3 done when**: `@pic.png` yields `block: ''` + one image + the receipt;
`@assets/*.png` yields images and a `[expanded @assets/*.png (N files, X KB)]`
receipt; an unreadable file yields `[could not read: @…]` for both a `.md` and a
`.png`; the directory branch is untouched.

---

### Step 4 — plumb `maxImageBytes` (coder)

**4a. `drone-agent/src/runtime/reference-expansion/capability.ts`**

```ts
const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024; // matches session.maxImageSizeBytes

export function createReferenceCapability(opts?: {
  cwd?: string;
  homedir?: string;
  maxImageBytes?: number;
}): DroneReferenceCapability {
  const baseCtx: DroneReferenceContext = {
    cwd: opts?.cwd ?? process.cwd(),
    homedir: opts?.homedir ?? os.homedir(),
  };
  const limits: ReferenceLimits = {
    maxImageBytes: opts?.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES,
  };
  // …existing kinds Map / activeBudget / chain…
  kinds.set(FILE_KIND, (value, ctx) =>
    resolveFileReference(value, ctx, activeBudget, limits)
  );
```

Import `type ReferenceLimits` from `./file-kinds.js`.

**4b. `drone-agent/src/index.tsx`** (line ~196) — thread the resolved config:

```ts
const reference = createReferenceCapability({
  maxImageBytes: resolvedConfig.config.session.maxImageSizeBytes,
});
```

**Do NOT change** `plugin-engine.ts:968`'s fallback
(`referenceCapability ?? createReferenceCapability()`) — it keeps the built-in
20 MB default, which is correct for any host that seeds a capability implicitly.

**Step 4 done when**: `pnpm -r run build` passes and `grep -rn createReferenceCapability drone-agent/src` shows the `index.tsx` call passing `maxImageBytes`.

---

### Step 5 — generalize the image count cap (coder)

**New file**: `drone-agent/src/runtime/image-cap.ts`

```ts
import type { DroneImageContent } from 'drone-core';

/** Matches the default of `session.maxImagesPerMessage`. */
export const DEFAULT_MAX_IMAGES_PER_MESSAGE = 20;

/** Marker for tool results (the model can re-invoke the tool with a selection). */
export const toolImageOmissionMarker = (omitted: number): string =>
  `[${omitted} additional images omitted. Request a narrower/range selection to retrieve them.]`;

/** Marker for user turns (the model must retrieve images itself). */
export const referenceImageOmissionMarker = (omitted: number): string =>
  `[${omitted} additional images omitted. Retrieve them individually if needed.]`;

/**
 * Enforce a kept-first-N image count cap. Returns the kept images (the input
 * array itself when nothing was dropped) and how many were omitted.
 */
export function capImages(
  images: DroneImageContent[],
  max: number
): { images: DroneImageContent[]; omitted: number } {
  if (images.length <= max) {
    return { images, omitted: 0 };
  }
  return { images: images.slice(0, max), omitted: images.length - max };
}
```

**5a. Tool-result site — `conversation-service.ts` (~line 858-886).** Replace the
inline cap with the shared helper, keeping the tool marker text **identical**:

```ts
const maxImagesPerMessage =
  config.session.maxImagesPerMessage ?? DEFAULT_MAX_IMAGES_PER_MESSAGE;
// …
if (images && images.length > 0) {
  const capped = capImages(images, maxImagesPerMessage);
  if (capped.omitted > 0) {
    images = capped.images;
    content = `${content}\n\n${toolImageOmissionMarker(capped.omitted)}`;
  }
}
```

(The existing tool marker string must come out byte-identical — this is a
refactor, not a behaviour change.)

**5b. User-turn site — `expandAndAppend` (~line 426-446).** Apply the cap and the
reference marker, and use the capped text for both the append and the returned
`userMessage` event:

```ts
async function expandAndAppend(content: string): Promise<string> {
  const result = await resolveExpandUserMessage(content);
  const maxImages =
    config.session.maxImagesPerMessage ?? DEFAULT_MAX_IMAGES_PER_MESSAGE;
  const capped = capImages(result.images, maxImages);
  let text = result.text;
  if (capped.omitted > 0) {
    text = `${text}\n\n${referenceImageOmissionMarker(capped.omitted)}`;
  }
  sessionManager.appendUserMessage(
    text,
    capped.images.length > 0 ? capped.images : undefined
  );
  for (const notice of result.notices) {
    engine
      .runConversationEventHooks({ kind: 'notice', content: notice })
      .catch(err => {
        logger.warn(`Conversation event hook threw: ${err}`);
      });
  }
  return text;
}
```

**Step 5 done when**: a tool returning 25 images still yields 20 + the original
tool marker; a user message with 25 image refs yields 20 + the reference marker;
`grep -n "Request a narrower/range selection" drone-agent/src` finds it only in
`image-cap.ts`.

---

### Step 6 — Tests (tester/coder)

**6a. New: `drone-core/test/image-mime.test.ts`** (or the existing core test
location — match the repo convention):
- each of `.jpg .jpeg .png .webp .gif` → correct MIME
- case-insensitivity (`.PNG`)
- non-image (`.md`, `.ts`) → `undefined`
- no extension → `undefined`
- `pic.tar.gz` → `undefined`
- `SUPPORTED_IMAGE_EXTENSIONS` contains the five dotted extensions

**6b. Extend `drone-agent/test/reference-expansion.test.ts`** (unit-level, real temp files):
- `@pic.png` → `images.length === 1` with the right `mimeType`, `block === ''`,
  notice `[expanded @pic.png (image/png, N B)]`
- `@notes.md` → text block, `images.length === 0` (unchanged)
- oversize: write a temp file above a small injected `maxImageBytes` →
  `[image too large: @pic.png (… > …)]`, no images, no block
- unreadable: a path in a chmod-000 directory (or a directory-as-file trick) →
  `[could not read: @…]`; a missing path → `[unresolved reference: @…]`
  (assert the **text** sibling produces the same class of notice for uniformity)
- glob of images: `@*.png` with 2 images + 1 text file → 2 images attached, text
  file still fenced, receipt aggregates bytes
- directory ref → name-only, `images.length === 0`

**6c. New: `drone-agent/test/image-cap.test.ts`** — `capImages` under/at/over the
cap; both marker builders' exact strings.

**6d. Extend `drone-agent/test/reference-expansion-integration.test.ts`** — drive
`sendUserMessage('see @pic.png')` with a real `createReferenceCapability` over a
temp dir; assert the **session user turn** carries `images` (not just the
expansion result) — this is the end-to-end proof the seam is live.

**6e. Existing suites must stay green**: `reference-expansion`,
`reference-expansion-integration`, `workflow-agent-expansion`, `file`,
`vision`, `image-content-*`, `compaction`.

**Pre-existing failures (do NOT chase these — documented in
`plan-fix-reference-expansion-host-wiring`)**: `drone-agent` has ~10 pre-existing
ANSI/width TUI failures (Markdown 6, pretty-tool-output 2, tui-persona-color 2),
`tui-completion-menu` is flaky under concurrency (passes standalone), and
`drone-coordinator-ui`'s `sessions.test.tsx` is a `NODE_ENV` artifact (passes with
`NODE_ENV=test`).

---

### Step 7 — Documentation (coder)

**`docs/agents/reference-expansion.md`**:
- Grammar table: add an image row (`@pic.png` / `@assets/*.png` — attaches the image
  to the turn; the message keeps the token as its anchor).
- "What gets inserted": note that image refs contribute **no text block**; they ride
  the vision channel. Receipt form `[expanded @pic.png (image/png, 12.3 KB)]`.
- Limits: add the image rules — recognized extensions
  (`.jpg .jpeg .png .webp .gif`), per-image `session.maxImageSizeBytes`,
  per-message `session.maxImagesPerMessage` (kept-first-N + omission marker), and the
  explicit statement that **images do not consume the 1 MiB text budget**.
- Notices: add `[image too large: @…]` and `[could not read: @…]`; note the
  `could not read` notice applies to text and images alike.
- **Move the "Deferred" image bullet out** (it is now implemented) and replace it
  with the still-deferred items: directory-listing inlining, fs-level read retry,
  partial-write detection.

**`AGENTS.md`**: the reference-expansion bullet under Specialized Subsystems says
"`@`-references in user messages (`@file`, `@skill:`, …)". Update to mention images
(`@file`, `@skill:`, image files via the vision path). Code is the source of truth —
re-read the sentence and correct only if it now contradicts the code. No fluff.

---

### Step 8 — Final verification against the validation criteria (tester/reviewer)

Run every criterion below; do not declare done until all pass. Then re-read this
plan and confirm each step's "done when" was met.

---

## Dependencies / ordering

- **Step 1 blocks Steps 2, 3, 4** (they import the core helper).
- **Step 3 blocks Step 4** (`ReferenceLimits` is defined in `file-kinds.ts` and
  imported by `capability.ts`).
- **Step 5 is independent** of Steps 2-4 (different files) but must land before
  Step 6's cap tests.
- **Step 6 depends on Steps 1-5.** **Step 7 depends on Steps 1-5.** Step 8 is last.
- **After editing `drone-core`, run `pnpm -r run build` before trusting LSP
  diagnostics in `drone-agent`** — dependent packages resolve `drone-core` from its
  built `dist/`, so stale diagnostics otherwise appear.

## Files touched (expected)

- `drone-core/src/image-mime.ts` (**new**, Step 1)
- `drone-core/src/index.ts` (Step 1, re-export)
- `drone-agent/src/plugins/file.ts` (Step 2)
- `drone-agent/src/runtime/reference-expansion/file-kinds.ts` (Step 3)
- `drone-agent/src/runtime/reference-expansion/index.ts` (Step 3g)
- `drone-agent/src/runtime/reference-expansion/capability.ts` (Step 4a)
- `drone-agent/src/index.tsx` (Step 4b)
- `drone-agent/src/runtime/image-cap.ts` (**new**, Step 5)
- `drone-agent/src/runtime/conversation-service.ts` (Step 5)
- `drone-core/test/image-mime.test.ts` (**new**, Step 6a)
- `drone-agent/test/reference-expansion.test.ts` (Step 6b)
- `drone-agent/test/image-cap.test.ts` (**new**, Step 6c)
- `drone-agent/test/reference-expansion-integration.test.ts` (Step 6d)
- `docs/agents/reference-expansion.md` (Step 7)
- `AGENTS.md` (Step 7, only if contradicted)

**Explicitly NOT touched**: `reference-expansion/parse.ts`,
`session-manager.ts`, `plugins/compaction/index.ts`, `token-estimate.ts`,
`prepareRequestMessages`/`describeUndescribedImages`, any LLM provider driver.
They are already correct and role-agnostic.

**Do NOT commit** the untracked `TEST.md` scratch file at the repo root.

## Validation criteria

All must pass before the work is considered done.

1. **LSP clean** — `lsp__get_diagnostics` reports **no errors or warnings** for every
   changed/added file (and the workspace). No exceptions for tests.
2. **Typecheck** — `pnpm -r run typecheck` exits 0.
3. **Build** — `pnpm -r run build` exits 0.
4. **Lint** — `pnpm lint` exits 0. (**Note:** the script is `pnpm lint` at the repo
   root; `pnpm -r run lint` does not exist — `drone-core` has no lint script. Running
   it applies prettier `--write`, so **re-read any file before editing it again**
   afterward, and revert any unrelated `pnpm-lock.yaml` churn.)
5. **Fast tests** — `pnpm test` (root) passes, including:
   - the new `image-mime`, `image-cap`, and reference-expansion image tests,
   - the new end-to-end user-turn assertion in
     `reference-expansion-integration.test.ts`,
   - the existing `reference-expansion`, `reference-expansion-integration`,
     `workflow-agent-expansion`, `file`, `vision`, and `compaction` suites.
   The pre-existing failures listed in Step 6 must be **unchanged** (prove this with
   a `git stash` baseline if any look suspicious).
6. **Behavioural checks** (unit-level, captured in the test run):
   - `@pic.png` attaches exactly one image and contributes **no text block**;
   - the 1 MiB text budget is **not** charged by images (a message with a large image
     plus a large text file still inlines the text file);
   - over-cap image batches drop to the front-N with the reference marker;
   - `[could not read: @…]` is produced for **both** a text file and an image;
   - the tool-result omission marker string is byte-identical to before Step 5.
7. **No duplicated MIME knowledge** — `grep -rn "image/png" drone-agent/src` returns
   only `image-cap`-unrelated hits; the only MIME table is in
   `drone-core/src/image-mime.ts`.
8. **No stale consumers** — `grep -rn "resolveFileReference" drone-agent/src` shows
   every call site passing `limits`.
9. **Manual TUI check (final acceptance)**:
   - With a **vision-capable** model: send `describe @pic.png` and confirm the turn
     carries the image (not `[skipped binary: …]`), the receipt
     `[expanded @pic.png (image/png, N KB)]` appears, and the model answers **from the
     image content**.
   - With a **non-vision** model: send the same and confirm the `image_describer`
     role produces a description that the model answers from (the describer path must
     work for user turns exactly as it does for tool results).
   - Repeat once with `@assets/*.png` (glob) to confirm multi-image attachment and the
     aggregate receipt.
10. **Final step** — re-read this plan and verify every step's "done when" was met.
