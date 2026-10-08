---
tags: [decision, coordinator-ui, wiki, markdown, frontmatter]
related:
  [
    modules/drone-coordinator-ui.md,
    decisions/187-coordinator-ui-wiki-browser-improvements.md,
  ]
---

# 188: Coordinator UI wiki frontmatter collapse

**Status**: Implemented (2026-09-03, branch `feat/memory-wiki-browser-improvements`, commit `5ab5c0e`)

## Context

The `coordinator-wiki-librarian` persona regularly writes wiki pages whose
markdown **body** begins with a redundant YAML frontmatter block (`id`, `title`,
`scope`, `tags`, `sources`) that duplicates the structured fields the
coordinator already stores. The librarian's habit is harmless — the storage
layer (`drone-swarm-common/src/wiki-storage.ts`) strips only the _outer_
frontmatter that `writePage()` builds, so `page.content` still begins with the
librarian's own `---\n...\n---\n` block. The wiki browser's read view
(`WikiMarkdown`, added in [187-coordinator-ui-wiki-browser-improvements](187-coordinator-ui-wiki-browser-improvements.md))
rendered the whole `content` string, so this redundant block showed as raw text
at the top of every such page.

We did not want to delete the block (it is harmless and the librarian's habit),
but it cluttered the read view.

## Decision

Collapse a leading YAML frontmatter block into a native `<details>` disclosure
that is **closed by default**, showing the raw YAML verbatim when expanded.

1. **Detection.** A new pure helper `splitFrontmatter(content)` in
   `src/lib/wiki-frontmatter.ts` matches a leading `---\n...\n---\n` block using
   the same regex shape as `wiki-storage.ts`. It returns
   `{ frontmatter: string | null, body: string }` — the raw YAML text (without
   the `---` fences) and the remaining body (`body` is `trimStart()`-ed to match
   the storage layer's convention). When there is no leading block, `frontmatter`
   is `null` and `body` is the full content.

2. **Rendering.** `WikiMarkdown` calls `splitFrontmatter(children)` at the top of
   the component. When a frontmatter block is present, it renders a native
   `<details>` (closed by default) above the markdown body with a
   "Metadata (YAML frontmatter)" `<summary>` and the raw YAML in a `<pre>`. The
   body renders through the existing `<ReactMarkdown>` pipeline unchanged. When
   there is no frontmatter, behavior is identical to before.

3. **Native `<details>` over the base-ui `Collapsible`.** The app already has a
   base-ui `Collapsible` (used in session-detail), but a native `<details>` is
   the simplest state-free disclosure for a static metadata block — no React
   state, no controlled/uncontrolled wiring, and it is collapsed by default via
   the HTML spec. The raw YAML is shown verbatim (the user explicitly chose
   plain YAML over a parsed key/value table).

## Tests

- `src/lib/wiki-frontmatter.test.ts` — 4 `splitFrontmatter` unit tests (splits a
  leading block, returns content unchanged without one, only splits a leading
  block not a later `---`, handles an empty body).
- `src/components/wiki-markdown.test.tsx` — 3 new tests (collapsed by default:
  YAML hidden + body visible; reveals raw YAML on summary click; renders
  normally without a frontmatter block).

Full coordinator-ui suite green (49 tests), typecheck, build, and lint clean.
Root `pnpm test` green (2701 passed / 14 skipped).

## Alternatives considered

- **Delete the redundant frontmatter** — rejected: the user explicitly wants to
  keep it (it is harmless and the librarian's habit).
- **Parse into a key/value table** — rejected: the user chose plain YAML
  verbatim.
- **base-ui `Collapsible`** — rejected for this case: native `<details>` is
  state-free and collapsed-by-default by spec, simpler than the controlled
  component for a static metadata block.

## Consequences

- Wiki pages whose body begins with a redundant frontmatter block now show a
  collapsed "Metadata (YAML frontmatter)" disclosure instead of raw text at the
  top; expanding it reveals the raw YAML verbatim.
- Pages without a leading frontmatter block render exactly as before.
- `splitFrontmatter` is the single place the browser splits frontmatter (no
  duplicated logic; it reuses the storage layer's regex convention).
