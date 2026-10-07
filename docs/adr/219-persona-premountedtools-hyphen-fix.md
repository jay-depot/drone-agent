---
tags: [decision, persona, frontmatter, parser, bug-fix, plugins, adr]
related: [decisions/218-reference-expansion-and-tab-completion.md, decisions/107-persona-tool-premounting.md, concepts/default-hidden-tools.md, modules/drone-agent-plugins.md]
---

# 219: Persona loader — allow hyphenated plugin ids in `premountedTools`

**Status**: Implemented (2026-09-19) · **Branch**: `feat/inline-object-refs` (PR #109, open) · **Found by**: a bug report from a sibling session, sanity-checked against the live code before fixing

**Summary**: The persona frontmatter parser matched keys with `^(\s*)(\w+):`. `\w` does not match `-`, so a **hyphenated frontmatter key never matched** — and because the parser's array-collection logic depends on that match, the key's indented list items were **silently dropped** (no error, no warning). The built-in `reflect` persona has a `self-improvement:` block under `premountedTools`, so `reflect` lost premount of `insight`, and — because premounting is how a persona reveals a `defaultHidden` tool — it silently lost access to the default-hidden `self-improvement__principle` and `self-improvement__mark_examined`. Fix: `\w+` → `[\w-]+`, matching the hyphen-aware key pattern the skills loader already uses.

## Context

Persona definitions are `.md` files with YAML-ish frontmatter parsed line-by-line in `drone-agent/src/plugins/persona/loader.ts`. `premountedTools` is a nested **map of arrays** (plugin id → tool names) that a persona uses to auto-mount tools on activation — and it is the mechanism by which a persona makes a `defaultHidden` tool visible.

The parser is a hand-rolled state machine with two "array modes": a flat one (`fragments`/`skills`/`tools`) and a nested one (`premountedTools`, keyed by an indented plugin-id line). Both are driven by the same key regex at `loader.ts:113`:

```ts
const kvMatch = line.match(/^(\s*)(\w+):\s*(.*)$/);
```

`\w` is `[A-Za-z0-9_]` — **it does not include `-`**, so `self-improvement:` never matched. A sibling session's bug report flagged this and traced it to the `reflect` persona. A prior tool-premounting change is [[decisions/107-persona-tool-premounting]]; the hidden-by-default concept is [[concepts/default-hidden-tools]].

## The failure mode (verified, and corrected from the report)

The bug report hedged that the orphaned tool lines are "pushed to the previous plugin's tool list, **or** dropped." They are **always dropped** — never mis-assigned. The parser flushes the current plugin's collected values **before** the `if (!kvMatch) continue;` skip:

```ts
// Flush premount values for the current plugin
if (currentPremountPlugin) {
  premountMap[currentPremountPlugin] = [...premountValues];
  premountValues.length = 0;
  currentPremountPlugin = null;
}

const kvMatch = line.match(/^(\s*)(\w+):\s*(.*)$/);
if (!kvMatch) continue;
```

So by the time the orphaned `- item` lines arrive, `currentPremountPlugin` is already `null` and they land in **no** bucket. Probe (a hyphenated key between two normal keys) confirms dropped, not leaked:

```
in :  file: [read] / aaa-bbb: [X, Y] / git: [commit]
out:  { file: ["read"], git: ["commit"] }   // X, Y dropped; no leak into file or git
```

This makes it quieter, not better: the `premountedTools: unknown tool "…"` warning in `persona/index.ts` never fires, because the key is discarded before premount expansion runs.

## Impact (verified)

- The installed `reflect` persona (`~/.drone-agent/personas/reflect/persona.md`) and its checked-in copy (`config-library/personas/reflect/persona.md`) both contain a `self-improvement:` premount block.
- Parsed premount keys before the fix: `notepad, file, todo, search, git, skills, memory, utils, lsp` — **`self-improvement` missing**.
- The plugin id is `self-improvement` (hyphenated), so **no correct frontmatter form could reference it** while the regex held.
- Two of the lost tools are `defaultHidden: true` — `principle` and `mark_examined` — so the persona silently lost access to them. (`insight` is **not** hidden; the report correctly said "two of those tools".)
- Also affected: `~/.drone-agent/personas/sketch/persona.md` (a WIP persona in progress at the time).

## Decision

- **Change the key regex to `^(\s*)([\w-]+):\s*(.*)$`.**
- **Precedent**: the skills loader already uses a hyphen-aware key pattern — `skills/loader.ts:74`: `/^(\w+(?:-\w+)*):\s*(.*)$/`. The persona loader was the outlier; the fix aligns the two.
- **`self-improvement` is not the only hyphenated plugin family** (`persona-provider-project`, `skill-provider-user`, `swarm-persona-beacon`, the `*-language-server` LSP specs, …), so the fix guards every future hyphenated key, not just this one. The same regex serves **all** keys, so a future hyphenated top-level key (e.g. `allowed-skills`) would have failed identically.

### Verified fix

Patching only the key regex in the built loader makes `reflect` parse fully, with no regression to the non-hyphen keys:

```
patched keys: [notepad, file, todo, search, git, skills, memory, utils, lsp, self-improvement]
self-improvement -> ["insight", "principle", "mark_examined"]
lsp -> [ get_diagnostics, inspect, go_to, find_references, symbols, code_action, rename, call_hierarchy, formatting ]  // intact
```

## Implementation

- **`drone-agent/src/plugins/persona/loader.ts`** — one-line change at `113`: `(\w+)` → `([\w-]+)`.
- **`drone-agent/test/persona-loader.test.ts`** — regression test: a `premountedTools` block whose middle key is `self-improvement` (between `file` and `lsp`) must parse to exactly its own tool list **and** must not leak into the neighbouring keys (pins "dropped, not merged" so a future refactor cannot silently start cross-contaminating lists).

## Consequences

- Hyphenated plugin ids now work in every persona frontmatter key; `reflect` regains `principle` and `mark_examined`, and `sketch` will parse correctly once completed.
- The fix is minimal and precedented — it does not change any other parser behaviour, and the two existing non-hyphen premount tests still pass.
- The loader shares one key regex for all keys, so this also hardens top-level keys going forward.

## Validation

- `pnpm -r run build` exit 0; `pnpm lint` exit 0.
- `drone-agent/test/persona-loader.test.ts` **16 passed** (was 15; +1 regression). Wider persona suite (`persona-premount`, `persona-select`, `persona-wizard`, `persona-cli-flag`) **53 passed**.
- End-to-end: the real `reflect` persona parses **10** premount plugins incl. `self-improvement → [insight, principle, mark_examined]` via `parsePersonaMd` on the built loader.

## Related

- [[decisions/218-reference-expansion-and-tab-completion]] — the feature whose verification surfaced this bug
- [[decisions/107-persona-tool-premounting]] — the `premountedTools` mechanism this fixes the parser for
- [[concepts/default-hidden-tools]] — why losing a premount silently removes a tool
- [[modules/drone-agent-plugins]] — the persona loader
