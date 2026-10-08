---
tags:
  [
    decision,
    reference-expansion,
    tab-completion,
    tui,
    conversation-loop,
    skills,
    drone-core,
    adr,
  ]
related:
  [
    decisions/215-slash-commands-during-work.md,
    decisions/217-steer-and-btw-commands.md,
    concepts/session-management.md,
    flows/tool-call-loop.md,
    modules/drone-agent.md,
    modules/drone-agent-tui.md,
    modules/drone-core.md,
    modules/drone-agent-plugins.md,
  ]
---

# 218: `@`-reference expansion + TUI tab completion

**Status**: Implemented (2026-09-19) · **Branch**: `feat/inline-object-refs` (PR #109, open) · **Plan**: project-memory `plan-reference-expansion-tab-completion` — _deleted from project memory after ingest_

**Summary**: User messages now expand `@`-references before they become session turns. **`@path`** inserts a file's contents (`bare` → CWD, `~/` → home, `./`/`../`/absolute), a directory lists recursively (names only), and a glob (`*`/`?`) expands to matching files — all bounded by per-file, per-listing, and total-message caps. **`@skill:<id>`** inserts a skill's body. Expansion is a **registry capability** (`reference`) seeded by the engine _before_ plugin registration, so core owns the `file:` kind and the skills plugin contributes `skill:`; future kinds register without touching the runtime. Expansion runs in the **conversation service** at the three direct append sites, so every host (TUI, readline, JSON-listen, swarm, `/steer`, macro chat steps) behaves identically. The TUI also gains **tab completion** for `@`-file refs, `@skill:` ids, and `/`-commands. A one-line persona-loader bug found while verifying the feature is recorded separately as [219-persona-premountedtools-hyphen-fix](219-persona-premountedtools-hyphen-fix.md).

## Context

Every mainstream coding assistant uses an `@` sigil to reference a file so the user need not burn a tool call — the de-facto convention. drone-agent had **no** `@`-reference handling anywhere (TUI or runtime), no tilde/cwd path expansion for user input, and no completion infrastructure (Tab was entirely unbound in Ink). Research across Claude Code / Cursor / Cline / Continue / Windsurf / Gemini / Goose / Codex / opencode found **no surveyed tool uses a namespaced `@skill:` form** — skills are invoked via `/name`, `@skill-name` (bare), `$name`, or a tool — so `@skill:` is a deliberate, consistent extension of "sigil + reserved kind + value", chosen over `/skill` because `/` is already the slash-command namespace.

Two design constraints shaped the architecture:

- **Host-agnostic expansion.** Expansion must happen wherever a user string becomes a session turn, or hosts diverge. The single chokepoint is the conversation service.
- **Plugins should extend the grammar.** `file:` belongs in core; `skill:` belongs to the skills plugin; a future `@persona:`/`@url:` should not require a runtime change. That points at a registry exposed as a capability.

## Decision

1. **A `reference` capability** (`DRONE_REFERENCE_CAPABILITY_ID = 'reference'`) holding a `Map` of kind-name → resolver. `registerKind`/`unregisterKind`/`getKinds`/`expandUserMessage`. Seeded by the engine **before** plugin registration so plugins can register kinds during `register()`.
2. **Core owns the `file:` kind**; the skills plugin registers `skill:`.
3. **`RESERVED_REFERENCE_KINDS = ['skill']`** — a token carrying a reserved kind is always a namespace reference, never a file path, **even when no resolver is registered** (so `@skill:x` yields an "unavailable" notice when the skills plugin is disabled rather than being misread as a file).
4. **Grammar** (amended during planning):
   - `@` starts a reference only at start-of-text or after whitespace (mid-word `@host` is untouched).
   - `@{path with spaces}` braced form for whitespace in paths.
   - `\@` escapes a literal `@` (the backslash is removed from the emitted text).
   - Any other `@<kind>:<value>` whose prefix matches `/^[a-z][a-z0-9-]*$/` but is **not** a known/reserved kind is treated as a **file path** (e.g. `@a:b.ts`).
5. **Stored form = prose verbatim + trailer.** The user's text is kept verbatim (the inline `@token` is a readable anchor); resolved blocks are appended once, in order, under `\n\n--- Referenced content ---\n` with `### @<raw-token>` headers. A `notice` event reports each expansion.
6. **Notice gating**: an unresolved reference emits a notice **only when the token looks like a path** (contains `/` or `.`) — so prose handles like `@dev` stay quiet.
7. **Expansion runs at exactly three direct append sites** in the conversation service, via one shared `expandAndAppend(content)` helper: `sendUserMessage`, `drainPendingEntries('append')`, and the mid-round steering loop. The `'own-round'` drain **re-enters `sendUserMessage`** and is therefore **never** expanded directly (no double-expansion). Slash-command arguments (`/exec`, `/tool`, macro **slash** steps) are **never** expanded; macro **chat** steps are.
8. **Images deferred, contract reserved.** The resolver return type carries `images: DroneImageContent[]` from day one and `appendUserMessage(text, images?)` is threaded through — so the image follow-up is a local change in `file-kinds.ts` with no interface churn.
9. **Tab completion (TUI)**: Tab **opens** the menu (no auto-open); Up/Down/Shift+Tab navigate; Enter/Tab accept; Esc closes; accepting a directory appends `/` and reopens; files/skills append a space. The caret is lifted into `App` (the input component becomes controlled).

### Limits

| Bound             | Value                                                                  |
| ----------------- | ---------------------------------------------------------------------- |
| Per file          | `MAX_LINES = 2000` lines / `MAX_BYTES = 256 KB` (then `[… truncated]`) |
| Directory listing | `MAX_DIR_ENTRIES = 500`                                                |
| Glob matches      | `MAX_GLOB_MATCHES = 30` (then `[… matched N, showing 30]`)             |
| Total message     | a shared expansion budget (`TOTAL_BUDGET_BYTES = 1 MB`)                |
| Binary            | NUL byte in the first 8000 bytes → skip + `[skipped binary: @…]`       |
| Dedup             | by `realpath` (fallback `path.resolve`)                                |

## Implementation

- **`drone-core/src/reference-types.ts`** (new) — `DRONE_REFERENCE_CAPABILITY_ID`, `RESERVED_REFERENCE_KINDS`, `DroneReferenceContext {cwd, homedir}`, `DroneReferenceResolution {block, images, notice?, dedupKey?}`, `DroneReferenceKindResolver`, `DroneReferenceExpansion {text, images, notices}`, `DroneReferenceCapability`.
- **`drone-core/src/capabilities.ts`** — `renderSkillBody: (id) => Promise<string | undefined>` added to `DroneSkillsCapability` (required, enhancer-applied — the same path `skills__recall` uses).
- **`drone-core/src/index.ts`** — re-exports the reference types/constants.
- **`drone-agent/src/runtime/reference-expansion/parse.ts`** (new) — `tokenizeText`: emits `text` and `reference` tokens; a `ReferenceToken` carries `raw`, `body`, `kind`, `value`, `start`, `end` (the `body` field lets an unknown-kind-prefix token fall back to a whole file path).
- **`drone-agent/src/runtime/reference-expansion/file-kinds.ts`** (new) — `resolveFileReference` (path/glob/directory/binary/caps/budget), `resolveReferencePath` (`~/`, absolute, CWD-relative), fence + small ext→lang hint.
- **`drone-agent/src/runtime/reference-expansion/capability.ts`** + **`index.ts`** (new) — `createReferenceCapability`; `file` registered by default; serialized budget through a promise chain; fast-path when the text contains no `@`.
- **`drone-agent/src/runtime/plugin-engine.ts`** — `referenceCapability?` engine option; in `initialize()`, right after `capabilities.set('_runtime', …)` and **before** `registerPlugin` loops: `capabilities.set(DRONE_REFERENCE_CAPABILITY_ID, referenceCapability ?? createReferenceCapability())`.
- **`drone-agent/src/index.tsx`** — builds `createReferenceCapability()`, passes it to the engine, and passes `reference.expandUserMessage` into `createConversationService`.
- **`drone-agent/src/runtime/conversation-service.ts`** — `expandUserMessage?` option (default identity); `expandAndAppend` helper (expands, appends with images, emits notices, returns the expanded text for the `userMessage` event); applied at the three sites.
- **`drone-agent/src/plugins/skills/index.ts`** — `findSkill`/`renderSkillBody` helpers; `renderSkillBody` added to the offered capability; `skills__recall` reuses it; `registerKind('skill', …)`; optional dep `{ id: 'reference', optional: true }`.
- **`drone-agent/src/tui/completion.ts`** (new) — pure `detectCompletionContext`, `applyCompletion`, `listFileCandidates`, `listSlashCandidates`, `listSkillCandidates`.
- **`drone-agent/src/tui/hooks/useCompletion.ts`** + **`components/CompletionMenu.tsx`** (new) — open/move/accept/close, seq-guarded async candidate recompute, sliding 10-row window.
- **`drone-agent/src/tui/components/MultilineTextInput.tsx`** — controlled `cursorOffset`/`onCursorChange`/`completionActive` (uncontrolled fallback retained).
- **`drone-agent/src/tui/components/InputLine.tsx`** — pass-through.
- **`drone-agent/src/tui/app.tsx`** — caret state, completion hook, menu key handling (below elicitation, above global bindings), menu render.
- **`docs/agents/reference-expansion.md`** (new) + **`AGENTS.md`** link under Specialized Subsystems.

### Deviation from the plan

- **S12**: the completion hook's engine parameter (and `listSlashCandidates`) was narrowed to a **structural slice** (`{ getSlashCommands, getCapability }`, exported as `SlashCommandSource`) rather than the full `DronePluginEngine`, because the TUI exposes only a `Pick` of the engine, not the whole type.

## Notable findings en route

1. **The double-expansion trap lives in the `'own-round'` drain.** That branch re-enters `service.sendUserMessage(entry.content)`, which is _itself_ an expansion site — so expanding in the drain too would expand twice. The fix is to expand only at the three _direct_ append sites; a regression test pins "exactly once".
2. **Unknown-kind-prefix tokens need the whole body.** `@a:b.ts` tokenizes with `kind='a'` (a syntactically valid kind name) but no resolver; the resolver must fall back to the _entire original body_ as a file path, not the post-colon remainder.
3. **`reference` must be an _optional_ dependency of the skills plugin.** The engine's dependency validation checks _enabled plugin ids_, and `reference` is a capability, not a plugin — a non-optional dep would fail startup.
4. **`file__apply_diff` fuzzy matching corrupted a file.** A large hunk near a damaged tail duplicated/mangled the end of `plugin-engine.ts` and silently dropped two hunks (an import and a destructure) while reporting `patched: true`; repaired by deterministic exact-string replacement over the shell and verified with `tsc -b`. (Same silent-no-op class flagged in [217-steer-and-btw-commands](217-steer-and-btw-commands.md).)

## Consequences

- A user prompt can now carry file and skill contents without a tool round-trip, identically across every host — the expansion lives at the conversation-service chokepoint.
- The grammar is **extensible by plugins**: `file:` ships in core, `skill:` in the skills plugin, and future kinds register at `register()` with no runtime change.
- Slash-command arguments are deliberately **not** expanded, keeping macro **slash** steps and `/exec`/`/tool` predictable, while macro **chat** steps (which route through `sendUserMessage`) do expand.
- Unresolved non-path tokens stay silent, so ordinary prose containing `@` is not littered with notices.
- The image path is pre-wired (`images[]` + `appendUserMessage` accepts images) but the resolver does not yet produce images.

## Validation

- **Static**: `pnpm -r run build` exit 0; `pnpm lint` exit 0; LSP clean.
- **Tests**: full suite **3150 passed / 14 skipped / 0 failed**. New files: `reference-expansion.test.ts` (27 — tokenizer boundaries/escapes/bracing, cwd/tilde/rel/abs, dir/glob caps, binary skip, line/byte truncation, budget, dedup, notice gating, reserved-kind-unavailable, unknown-kind-prefix-is-a-file), `skills-render-body.test.ts` (4), `tui-multiline-caret.test.tsx` (4), `tui-completion.test.ts` (19), `tui-completion-menu.test.tsx` (5), `reference-expansion-integration.test.ts` (6 — idle send, deferred `'append'` drain across cancel, own-round exactly-once, mid-round `/steer`, macro chat step).

## Related

- [215-slash-commands-during-work](215-slash-commands-during-work.md) — the unified queue whose `'own-round'` drain is the double-expansion trap
- [217-steer-and-btw-commands](217-steer-and-btw-commands.md) — the mid-round steering loop that is one of the three expansion sites
- [219-persona-premountedtools-hyphen-fix](219-persona-premountedtools-hyphen-fix.md) — the persona-loader bug found while verifying this feature
- session-management — where a user string becomes a session turn
- tool-call-loop — the append sites in the loop
- [drone-core](../../drone-core/) — the reference types + `renderSkillBody`
- [drone-agent](../../drone-agent/) — the runtime module + conversation-service wiring
- [drone-agent-tui](../../drone-agent/src/tui/) — the completion menu + controlled caret
- [drone-agent-plugins](../../drone-agent/src/plugins/) — the skills plugin's `skill:` kind
