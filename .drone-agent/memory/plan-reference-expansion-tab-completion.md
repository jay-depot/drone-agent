---
key: plan-reference-expansion-tab-completion
tags:
  - plan
  - tui
  - reference-expansion
  - tab-completion
  - skills
  - conversation-service
created: 2026-09-19T23:11:41.128Z
updated: 2026-09-19T23:44:10.679Z
status: completed
---

# Plan: `@`-reference expansion + tab completion (drone-agent)

**Status:** ready for execution (2026-09-19 planning session). Self-contained — a `code` agent can execute from this entry alone.

## 1. Summary — what and why

drone-agent's TUI (and every other host) should accept the near-universal `@` file-reference convention, plus a skill-reference shorthand, and offer tab completion for references and slash commands.

- **`@path`** — insert the file's contents into the prompt (bare → CWD; `~/` → home; `./`, `../`, absolute all allowed). The user does not spend a tool call.
- **`@skill:<id>`** — insert a skill's body. The `/` sigil is already the slash-command namespace, and no surveyed tool uses `@skill:` (research: skills are invoked via `/name` in Claude Code/Cursor/Cline/Continue, `/skills <name>` in Gemini/Goose, `@skill-name` bare in Windsurf, `$name` in Codex CLI, or a bare tool in opencode) — so `@skill:` is a deliberate, consistent extension of the `@`-reference idea ("sigil + reserved kind + value", cf. Cursor `@Terminals`, Copilot `#file`), NOT a de-facto standard. Chosen over `/skill` because the user finds `/` overloaded.
- **Tab completion** for `@`-files, `@skill:` ids, and `/`-commands.

Design rationale:

- Expansion is **host-agnostic** — it runs inside the conversation service at the points where a user string becomes a session turn, so TUI, plain readline, JSON-listen, swarm/remote, `/steer`, and macro _chat_ steps all behave identically. Slash-command arguments (macro _slash_ steps, `/exec`, `/tool`) are **not** expanded.
- The `@` grammar lives in a **registry of kind resolvers** exposed as a built-in capability early in `initialize()`, so `file:` ships in core and `skill:` is contributed by the skills plugin — future `@persona:`, `@url:` etc. register without touching the runtime again.
- **Globs are in v1** (fast-glob is already a dependency). **Images are later**, but the expansion return contract carries `images[]` from day one so the follow-up is a local change with no interface churn.

## 2. Architecture

```
user text ──► conversation-service  (expandAndAppend at 3 append sites)
                   │
                   ▼
        reference capability (registry)        ← seeded in engine.initialize() as 'reference'
          ├─ kind 'file'   (core: drone-agent/src/runtime/reference-expansion/file-kinds.ts)
          └─ kind 'skill'  (registered by the skills plugin)
                   │
                   ▼
        { text: prose + trailer, images: [], notices: [] }
                   │
                   ├─ sessionManager.appendUserMessage(text, images?)
                   ├─ notice events  ─► TUI / plain handler
                   └─ userMessage event carries the EXPANDED text

TUI input line ──► App (owns value + caret) ──► completion (pure fns + useCompletion + CompletionMenu)
```

## 3. Shared types (drone-core)

New file **`drone-core/src/reference-types.ts`**:

```ts
import type { DroneImageContent } from './session-types.js';

export const DRONE_REFERENCE_CAPABILITY_ID = 'reference';

/**
 * Kind names reserved by the core grammar. A token carrying a reserved kind is
 * always a namespace reference (never a file path), even when no resolver is
 * registered — so `@skill:x` yields an "unavailable" notice when the skills
 * plugin is disabled rather than being misread as a file.
 */
export const RESERVED_REFERENCE_KINDS = ['skill'] as const;

export type DroneReferenceContext = { cwd: string; homedir: string };

export type DroneReferenceResolution = {
  /** Block body (files: fenced content; skills: raw body). The expander prepends `### @<token>`. */
  block: string;
  /** Images to attach to the user turn (v1: always empty; reserved for image refs). */
  images: DroneImageContent[];
  /** Optional user-facing notice (e.g. "unknown skill", "skipped binary"). */
  notice?: string;
  /** Dedup key (resolved absolute path / skill id). Defaults to the raw value. */
  dedupKey?: string;
};

export type DroneReferenceKindResolver = (
  value: string,
  ctx: DroneReferenceContext
) => Promise<DroneReferenceResolution>;

export type DroneReferenceExpansion = {
  text: string;
  images: DroneImageContent[];
  notices: string[];
};

export type DroneReferenceCapability = {
  registerKind(name: string, resolver: DroneReferenceKindResolver): void;
  unregisterKind(name: string): void;
  getKinds(): string[];
  expandUserMessage(text: string): Promise<DroneReferenceExpansion>;
};
```

Add to **`DroneSkillsCapability`** (`drone-core/src/capabilities.ts`):

```ts
/** Render a skill body with recall enhancers applied (same path as skills__recall). */
renderSkillBody: (id: string) => Promise<string | undefined>;
```

Export the reference types/constants from **`drone-core/src/index.ts`**.

## 4. Concrete module contracts

### `drone-agent/src/runtime/reference-expansion/parse.ts`

```ts
export type TextToken =
  | { type: 'text'; text: string }
  | {
      type: 'reference';
      raw: string;
      kind: string | null;
      value: string;
      start: number;
      end: number;
    };

const KIND_RE = /^[a-z][a-z0-9-]*$/;

/** `@` starts a reference only at start-of-text or after whitespace (mid-word `@` untouched). */
function isBoundary(text: string, i: number): boolean {
  return i === 0 || /\s/.test(text[i - 1]);
}
function readReference(text: string, i: number): TextToken | null {
  /* `@` or `@{...}` */
}
export function tokenizeText(text: string): TextToken[];
```

Rules: `\@` → literal `@` (escape removed from emitted text); empty body (`@` or `@{}`) is not a reference; a non-empty body gets a `kind` only when it has a `:` whose prefix matches `KIND_RE` (else `kind: null`).

### `drone-agent/src/runtime/reference-expansion/file-kinds.ts`

```ts
export const MAX_LINES = 2000;
export const MAX_BYTES = 256 * 1024;
export const MAX_DIR_ENTRIES = 500;
export const MAX_GLOB_MATCHES = 30;

export async function resolveFileReference(
  value: string,
  ctx: DroneReferenceContext,
  budget: { used: number; limit: number }
): Promise<DroneReferenceResolution>;
```

Behaviour: path forms (`~/`|`~`→homedir, `/abs`→root, `./`,`../`→CWD-rel, bare→CWD); globs (`*`/`?`) via `fg(pattern,{cwd,absolute:true,onlyFiles:true,dot:false})` sorted + capped at `MAX_GLOB_MATCHES` (note `[… matched N, showing 30]`); directory → recursive name-only `readdir({withFileTypes:true})` walk capped at `MAX_DIR_ENTRIES`; binary (NUL in first 8000 bytes) → skip + `[skipped binary: @<value>]`; size → truncate to `MAX_LINES` lines / `MAX_BYTES` bytes + `[… truncated]`; total budget exhausted → `[expansion budget exceeded; @<value> not included]`; fence = backtick run longer than any inside the content (+ small ext→lang hint); `dedupKey = await fs.realpath(abs)` (fallback `path.resolve`).

### `drone-agent/src/runtime/reference-expansion/capability.ts` (+ `index.ts`)

```ts
export function createReferenceCapability(opts?: {
  cwd?: string;
  homedir?: string;
}): DroneReferenceCapability;
```

- `kinds = new Map()`; registers `file` by default.
- `registerKind` validates `/^[a-z][a-z0-9-]*$/` (throw on invalid).
- `expandUserMessage(text)`:
  1. Fast path: no `@`/`\@` → `{ text, images: [], notices: [] }`.
  2. `tokenizeText(text)`; rebuild `body` (inline `@token`s kept, escapes stripped).
  3. Per reference token: `kind` set & registered → that resolver; `kind` set & in `RESERVED_REFERENCE_KINDS` but no resolver → skip + `[<kind> references unavailable: <kind> plugin not enabled]`; `kind` null → `file`.
  4. Dedup by `dedupKey`; accumulate blocks/images/notices.
  5. If blocks: `text = body + '\n\n--- Referenced content ---\n' + blocks.join('\n\n')`, each block `### @<raw-token>\n<resolver.block>`; else `text = body`.
  6. `file`-resolver failures notice **only when `value` contains `/` or `.`**; `skill:`-type namespaces always notice.

### Conversation-service helper (`drone-agent/src/runtime/conversation-service.ts`)

```ts
async function expandAndAppend(content: string): Promise<string> {
  const result = await expandUserMessage(content);
  sessionManager.appendUserMessage(
    result.text,
    result.images.length ? result.images : undefined
  );
  for (const n of result.notices) {
    engine
      .runConversationEventHooks({ kind: 'notice', content: n })
      .catch(err => logger.warn(`Conversation event hook threw: ${err}`));
  }
  return result.text;
}
```

`CreateConversationServiceOptions` gains `expandUserMessage?: (text: string) => Promise<DroneReferenceExpansion>` (default identity).

### `drone-agent/src/tui/completion.ts`

```ts
export type CompletionItem = {
  id: string;
  display: string;
  apply: string;
  hint?: string;
  reopen?: boolean;
};
export type CompletionContext =
  | { kind: 'none' }
  | { kind: 'slash'; tokenStart: number; prefix: string }
  | { kind: 'skill'; tokenStart: number; prefix: string }
  | { kind: 'file'; tokenStart: number; prefix: string };
export function detectCompletionContext(
  value: string,
  caret: number
): CompletionContext;
export function applyCompletion(
  value: string,
  caret: number,
  ctx: CompletionContext,
  item: CompletionItem
): { value: string; caret: number };
export async function listFileCandidates(
  prefix: string,
  ctx: DroneReferenceContext
): Promise<CompletionItem[]>;
export function listSlashCandidates(
  prefix: string,
  engine: DronePluginEngine
): CompletionItem[];
export function listSkillCandidates(
  prefix: string,
  skills: DroneSkillsCapability | undefined
): CompletionItem[];
```

## 5. Execution steps

### S1 — drone-core: reference types + `renderSkillBody`

**Agent:** code · **Depends on:** none · **Files:** `drone-core/src/reference-types.ts` (new), `drone-core/src/capabilities.ts`, `drone-core/src/index.ts`
Add `reference-types.ts` (§3), add `renderSkillBody` to `DroneSkillsCapability`, re-export. Run `pnpm -r run build` (dependents resolve drone-core from `dist/`).

> Adding `renderSkillBody` is breaking to a _required_ interface field — the implementer (S7) and all mocks (S13) must be updated; do NOT make the field optional.

### S2 — Parser/tokenizer

**Agent:** code · **Depends on:** S1 · **Files:** `drone-agent/src/runtime/reference-expansion/parse.ts` (new) — per §4.

### S3 — `file` kind resolver

**Agent:** code · **Depends on:** S1, S2 · **Files:** `drone-agent/src/runtime/reference-expansion/file-kinds.ts` (new) — per §4.

### S4 — Capability registry + expander

**Agent:** code · **Depends on:** S2, S3 · **Files:** `drone-agent/src/runtime/reference-expansion/capability.ts`, `.../index.ts` (new) — per §4. Unit tests `drone-agent/test/reference-expansion.test.ts` (tokenizer boundaries/escapes/bracing; cwd/tilde/rel/abs; dir cap; glob cap+order; binary skip; line/byte truncation; budget; dedup; unresolved-notice gating (`@handles` silent, `@src/nope.ts` noisy); reserved-kind-unavailable; unknown-kind-prefix-is-a-file `@a:b.ts`).

### S5 — Engine: seed the `reference` capability early

**Agent:** code · **Depends on:** S4 · **Files:** `drone-agent/src/runtime/plugin-engine.ts`, `drone-agent/src/index.tsx`
Add optional `referenceCapability?` to `createDronePluginEngine` options; in `initialize()` right after `capabilities.set('_runtime', …)` (plugin-engine.ts:940): `capabilities.set(DRONE_REFERENCE_CAPABILITY_ID, referenceCapability ?? createReferenceCapability());`. In `index.tsx` build `const reference = createReferenceCapability();`, pass into engine options, and pass `reference.expandUserMessage` into the conversation service (S6).

### S6 — Conversation service: expand at the three append sites

**Agent:** code · **Depends on:** S4 · **Files:** `drone-agent/src/runtime/conversation-service.ts`
Add the option (§4) + `expandAndAppend` helper. Replace the **three** direct appends and thread the returned text into the existing `userMessage` event:

- `sendUserMessage` direct append (**L596**) → `const expandedPrompt = await expandAndAppend(prompt);`; event ~L606 uses `content: expandedPrompt`.
- `drainPendingEntries('append')` branch (**~L425**) → `const expanded = await expandAndAppend(entry.content);`; event uses it.
- steering loop append (**~L983**) → `const expanded = await expandAndAppend(steer);`; event uses it.
  **Do NOT** expand the `'own-round'` branch (**~L437**) — it re-enters `service.sendUserMessage` (would double-expand). `submitUserMessage` needs no change (routes to `sendUserMessage` or queues into `pendingEntries`).

### S7 — Skills plugin: `renderSkillBody` + register the `skill` kind

**Agent:** code · **Depends on:** S1, S4 · **Files:** `drone-agent/src/plugins/skills/index.ts`
Add `{ id: DRONE_REFERENCE_CAPABILITY_ID, optional: true }` to metadata dependencies (**must be `optional`** — dep validation checks enabled plugin ids, and `'reference'` is a capability, not a plugin). Extract the recall-enhancer application into `renderSkillBody(id)` (case-insensitive lookup; returns `undefined` when unknown; applies `recallEnhancers` in order); add it to the offered capability (~L139) and have `skills__recall`'s execute (L153-202) call the same helper. Register the kind:

```ts
const ref = registration.request<DroneReferenceCapability>('reference');
ref?.registerKind('skill', async value => {
  const id = value.trim().toLowerCase();
  const body = await renderSkillBody(id);
  return body === undefined
    ? {
        block: '',
        images: [],
        notice: `[unknown skill: ${id}]`,
        dedupKey: `skill:${id}`,
      }
    : { block: body, images: [], dedupKey: `skill:${id}` };
});
```

Tests `drone-agent/test/skills-render-body.test.ts` (enhancer application, case-insensitivity, unknown → undefined).

### S8 — `MultilineTextInput`: controlled caret + yield completion keys

**Agent:** code · **Depends on:** none · **Files:** `drone-agent/src/tui/components/MultilineTextInput.tsx`
New props `cursorOffset?`, `onCursorChange?`, `completionActive?`. Replace internal caret state (L62) with controlled `cursorOffset` (fallback `value.length`); route all former `setCursorOffset` through `onCursorChange`. Clamp on external shrink (effect: if `cursorOffset > value.length` → `onCursorChange(value.length)`). At the top of the `useInput` handler (L89): `if (completionActive && (key.tab || key.return || key.upArrow || key.downArrow)) return;`. Tests `drone-agent/test/tui-multiline-caret.test.tsx`.

### S9 — `InputLine`: pass-through

**Agent:** code · **Depends on:** S8 · **Files:** `drone-agent/src/tui/components/InputLine.tsx`
Forward `cursorOffset`/`onCursorChange`/`completionActive` to `MultilineTextInput` (L79-85).

### S10 — Pure completion functions

**Agent:** code · **Depends on:** S1 · **Files:** `drone-agent/src/tui/completion.ts` (new) — per §4. Details: `detectCompletionContext` — `/^\/(\S*)$/` at message start → `slash` (`tokenStart=0`), else the last `(^|\s)\S*$` token: `@skill:` → `skill`, other `@…` → `file`. `applyCompletion` — replace from `tokenStart` with `item.apply`, caret = `tokenStart + apply.length`, `reopen` items (dirs) leave caret right after. `listFileCandidates` — split prefix at last `/`; resolve dir (`~/`→home, `/`→root, else CWD-rel); `readdir`; case-insensitive prefix filter; dirs first; dotfiles hidden unless name-prefix starts with `.`; cap 50; `apply = '@' + parent + name + (isDir ? '/' : ' ')`. `listSlashCandidates` — `engine.getSlashCommands()` filtered by `/`+prefix; `hint = description`; `apply = command + ' '`. `listSkillCandidates` — `skills?.getSkills()` filtered by `id.toLowerCase().startsWith(prefix)`; `apply = '@skill:' + id + ' '`. Tests `drone-agent/test/tui-completion.test.ts`.

### S11 — `useCompletion` hook + `CompletionMenu` component

**Agent:** code · **Depends on:** S10 · **Files:** `drone-agent/src/tui/hooks/useCompletion.ts`, `drone-agent/src/tui/components/CompletionMenu.tsx` (new)
`useCompletion({ value, caret, engine, cwd, homedir })` → `{ open, items, index, openAt(), move(delta), accept(), close() }`; recompute items on `(value,caret)` change while open (async; guard stale results with a seq). `CompletionMenu({ items, selectedIndex, scheme })`: `<Box flexDirection="column" paddingX={1}>` with up to 10 rows, `▶ ` marker on the selected row, `display` + optional `hint`, `… +N more` when longer. Placed as a **sibling between `<InputLine>` and `<ElicitationPrompt>`**. Tests `drone-agent/test/tui-completion-menu.test.tsx`.

### S12 — App wiring

**Agent:** code · **Depends on:** S9, S11 · **Files:** `drone-agent/src/tui/app.tsx`
State `cursorOffset`, `completionOpen`, `completionIndex`; `const completion = useCompletion({ value: input, caret: cursorOffset, engine: opts.engine, cwd, homedir: os.homedir() });`. Render: pass `cursorOffset`/`onCursorChange`/`completionActive={completion.open}` to `InputLine`; render `<CompletionMenu …/>` after `<InputLine>` when open. Global `useInput` (~L680-733): when open — Tab/↓ → `move(1)`, Shift+Tab/↑ → `move(-1)`, Enter → accept (set value+caret; reopen on dir else close), Esc → close; when **not** open and Tab pressed → `completion.openAt()`. Elicitation keeps priority; no open while `activeQuestion !== null`. Keep raw `> ${trimmed}` logging in `onSubmit` (L808-862) — the receipt arrives separately as a `notice` (TUI already renders `notice`, L546).

### S13 — Shared-interface sweep

**Agent:** code · **Depends on:** S1, S7 · **Files:** all `DroneSkillsCapability` mocks
`grep` for `DroneSkillsCapability` / `getSkills:` implementations; add `renderSkillBody: async () => undefined` stubs; cross-check with LSP `find_references` on `renderSkillBody`.

### S14 — Integration tests + docs

**Agent:** code · **Depends on:** S6, S7 · **Files:** `drone-agent/test/reference-expansion-integration.test.ts` (new), `docs/agents/reference-expansion.md` (new), `AGENTS.md`
Integration tests (real `createConversationService`, injected `expandUserMessage`): idle `sendUserMessage('look at @fixture.ts')` → turn has trailer + `userMessage` event carries expanded text + a `notice`; deferred/busy text drained via `'append'` → expanded once; `'own-round'` drain → expanded exactly once (regression guard for the double-expansion trap); `/steer <msg with @ref>` mid-round → expanded at the steering append; a macro chat step whose argument contains `@ref` → expanded. Docs: `@` grammar, `@skill:` namespace, caps, expansion points; link from `AGENTS.md`.

### S15 — Final validation (last step)

**Agent:** code · **Depends on:** all
Walk the validation criteria; fix failures. Emit an ADR in the swarm wiki covering the grammar, the registry-as-capability decision, and the deferred image path.

## 6. Expansion points (exactly one per text-turn)

`conversation-service.ts`: `sendUserMessage` append (~L596), `drainPendingEntries('append')` (~L425), steering loop (~L983). Shared `expandAndAppend(content)` helper returns the transformed text for the `userMessage` event. Never expand the `'own-round'` branch (~L437) — it re-enters `sendUserMessage`.

## 7. Validation criteria

1. **LSP** — zero errors/warnings on every touched file.
2. **Build** — `pnpm -r run build` zero errors (run after S1 and at the end).
3. **Lint** — `pnpm -r run lint` zero errors. Re-read files after linting before further edits.
4. **Fast tests** — `pnpm -r run test` passes, including: tokenizer/grammar; file resolver (cwd/tilde/rel/abs/dir/glob/binary/caps/budget/dedup); notices gating; reserved-kind-unavailable; unknown-kind-prefix-is-a-file; skills `renderSkillBody` + `skill` kind; conversation-service integration (idle / deferred-append / own-round-once / steer / macro chat step); completion pure fns, `CompletionMenu` render, caret-controlled `MultilineTextInput`.
5. **Behavioural contract** — `@file` inserts contents (cwd default, `~/` expansion), dirs list names only, globs expand (capped), binary skipped with notice; unresolved tokens stay literal + notice only when containing `/` or `.`; `\@` → literal `@`; `@skill:<id>` inserts the enhancer-applied body with notices for unknown id / disabled plugin; slash args (macro slash steps, `/exec`, `/tool`) never expanded while macro chat steps are; no double-expansion on `'own-round'`; Tab completion opens only on Tab, Enter accepts while open, Esc closes, dirs reopen after accept.
6. **No dead code / unused exports**; new files well under the 750-line guideline.

## 8. Explicitly deferred (out of scope)

- **Image attachment via `@pic.png`** — the `images[]` field exists in the contract and is threaded through `appendUserMessage`; v2 adds magic/MIME detection in `file-kinds.ts` only. Follow the existing image conventions: structured `DroneImageContent` (`{mimeType,data,description?}`), the `maxImagesPerMessage` count cap, `maxImageSizeBytes`, and the `describeUndescribedImages`/`prepareRequestMessages` non-vision description path (see swarm/wiki `drone-agent-image-content-refactor-v2`).
- **`onBeforeUserMessage` transform hook** — not added; the registry leaves room.
- **Non-TUI completion** — `--output-plain`/readline get _expansion_ but not tab completion.

## 9. Verified anchor facts

- `_runtime` seeded at plugin-engine.ts:940 before plugin registration; `request(id)` throws for undeclared ids except `'runtime'`; `getCapability(id)` is a plain map read.
- `offer` → `capabilities.set(plugin.metadata.id, cap)` (plugin-engine.ts:693-694); dep validation checks `enabledPluginIds` (plugin-engine.ts:483) → `reference` dep must be `optional`.
- engine created (index.tsx:195) before `createConversationService` (index.tsx:230).
- TUI App renders `notice` (app.tsx:546-547), ignores `userMessage` → receipt is safe.
- `sessionManager.appendUserMessage(content, images?)` already accepts images.
- `drainPendingEntries('own-round')` re-enters `service.sendUserMessage` (~L437) → the double-expansion trap.
- Glob precedent: `file.ts` `fg(pattern,{cwd,absolute:true})`; fast-glob in drone-agent/package.json:38.
- Path-expansion precedent: `plugins/prompt-file/index.ts:19-64` `resolvePromptFilePath`.
- No `@`-reference handling exists anywhere today (TUI or runtime); Tab is unbound in Ink.


---

## Execution Summary — COMPLETED (2026-09-19T23:44:10.679Z, branch feat/inline-object-refs)

**All 15 steps executed; validation green** (`pnpm -r run build` exit 0, `pnpm lint` exit 0, full suite **3150 passed / 14 skipped / 0 failed**; LSP clean).

As-built (all per plan; deviations noted):
- **S1** `drone-core/src/reference-types.ts` (types, `DRONE_REFERENCE_CAPABILITY_ID`, `RESERVED_REFERENCE_KINDS`); `renderSkillBody` on `DroneSkillsCapability`; index re-exports.
- **S2** `runtime/reference-expansion/parse.ts` — split `TextToken`/`ReferenceToken` and added a `body` field to the reference token (unknown-kind-prefix tokens need the whole body to fall back to a file path: `@a:b.ts`).
- **S3** `file-kinds.ts` — path forms, `fast-glob` globs (cap 30), recursive dir listing (cap 500), binary skip, 2000-line/256 KB cap, budget, `realpath` dedup, fence/lang hint.
- **S4** `capability.ts` + `index.ts`; `file` kind registered by default; serialized budget via a promise chain; fast-path when no `@`. 27 unit tests.
- **S5** engine seeds `reference` in `initialize()` right after `_runtime`; `index.tsx` builds + passes it into the engine.
- **S6** conversation-service `expandUserMessage` option + `expandAndAppend` at the 3 direct append sites; `userMessage` event carries expanded text; own-round NOT expanded.
- **S7** skills plugin `renderSkillBody`/`findSkill`, `registerKind('skill')`, optional dep `{id:'reference'}`; `skills__recall` shares the helper. 4 tests.
- **S8** `MultilineTextInput` controlled `cursorOffset`/`onCursorChange`/`completionActive` (uncontrolled fallback retained). 4 tests.
- **S9** `InputLine` pass-through.
- **S10** `tui/completion.ts` (pure). 19 tests.
- **S11** `useCompletion` hook + `CompletionMenu`. 5 tests.
- **S12** `app.tsx` wiring (caret state, menu key handling, render). *Deviation:* the completion engine param was narrowed to a structural `{getSlashCommands, getCapability}` slice (and `listSlashCandidates` to `SlashCommandSource`) because the TUI exposes only a `Pick` of `DronePluginEngine`, not the full engine.
- **S13** verified no extra `renderSkillBody` mocks needed (test capability mocks are loose `unknown` objects; only the skills plugin implements the full type).
- **S14** `test/reference-expansion-integration.test.ts` (6 tests incl. the own-round exactly-once regression) + `docs/agents/reference-expansion.md` + AGENTS.md link.
- **S15** validation + swarm-wiki ADR `reference-expansion-and-tab-completion`.

Commits: 8e90edba (S1–6), 8e67109a (S7), c4d7ee8d (S8), 50e33a97 (S9), a9181997 (S10), 2701028f (S11), 08babe33 (S12), e9e85baf (S14), plus S15 lint/test fixes.

**Execution hazard discovered:** `file__apply_diff`'s fuzzy matching duplicated/mangled the tail of `plugin-engine.ts` and silently dropped two hunks (an import + a destructure) while reporting success; repaired with deterministic python exact-replace over `exec__run`. Recommend python exact-replace for risky drone-agent edits and always verifying with `npx tsc -b` (LSP diagnostics go stale after exec-based writes).
