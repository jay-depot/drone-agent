---
tags: [decision, coordinator-ui, wiki, markdown, react]
related:
  [
    modules/drone-coordinator-ui.md,
    decisions/186-coordinator-ui-pagination-and-search-fixes.md,
  ]
---

# 187: Coordinator UI wiki browser improvements

**Status**: Implemented (2026-09-03, branch `feat/memory-wiki-browser-improvements`, commit `97db550`)

## Context

The coordinator web console's wiki browser (`drone-coordinator-ui/`) had three
gaps that made wiki pages hard to read and navigate:

1. **Markdown was not rendered.** The wiki read view (`wiki-detail.tsx`)
   displayed `page.content` as raw markdown inside a `<pre>` block with
   `font-mono` — headings, lists, code, and tables all appeared as literal
   `#`/`-`/backtick text.

2. **Links did not work.** Wiki pages use Obsidian-style `[[wikilinks]]`
   (the storage layer already lints for broken links), but the UI rendered them
   as literal text. Standard markdown links were also inert. There was no way
   to navigate between pages, and a broken link landed on a dead-end
   "Wiki page not found" state with no way to create the missing page.

3. **Tags were not navigable.** Tags were stored in frontmatter and rendered as
   non-clickable `Badge` components in both the list and detail views. There was
   no way to see all pages sharing a tag.

## Decision

1. **Render markdown on the read view.** Added `react-markdown` + `remark-gfm`
   (the idiomatic React markdown stack; the TUI package uses `marked` but that
   is a separate Ink-based implementation). A new `WikiMarkdown` component
   (`src/components/wiki-markdown.tsx`) wraps them with custom components styled
   with the existing Tailwind design tokens (no `@tailwindcss/typography`
   dependency): headings, paragraphs, lists, code blocks, GFM tables,
   blockquotes, inline code, hr, strong/em.

2. **Make links work.**
   - **Wikilinks.** A pure `preprocessWikiLinks()` helper
     (`src/lib/wiki-links.ts`) converts `[[target]]` →
     `[target](/wiki/<encodeURIComponent(target)>)` and
     `[[target|alias]]` → `[alias](/wiki/<encodeURIComponent(target)>)`,
     escaping markdown special chars in the label. `WikiMarkdown` runs it before
     rendering, so wikilinks become standard markdown links.
   - **Link routing.** `WikiMarkdown`'s custom `a` component routes by href:
     `/wiki/`-prefixed → `react-router-dom` `<Link>` (client-side navigation);
     external `http(s)` → `<a target="_blank" rel="noopener noreferrer">` with
     the **hostname shown after the link text** (e.g. `OpenAI (openai.com)`);
     anything else → plain `<a>`.
   - **"Create it" button.** The not-found state in `wiki-detail.tsx` gained a
     "Create it" button navigating to `/wiki/:pageId/edit?create=1`. The editor
     (`wiki-editor.tsx`) reads the `create` query param: `?create=1` forces
     create mode even when a `pageId` is present (skips the fetch, pre-fills the
     page-ID field from the URL param, disables auto-gen-from-title so the
     wikilink target is preserved).

3. **Virtual tag pages.** A new `WikiTagPage` (`src/pages/wiki-tag.tsx`) at
   route `/wiki/tag/:tag` filters the already-fetched page list client-side by
   `tags.includes(tag)`, with a header (tag name + page count), the shared
   `WikiPageGrid`, pagination, and an empty state. Tag badges are now clickable
   `<Link>`s in both the list (`WikiPageGrid`) and detail (`wiki-detail.tsx`)
   views. The route is registered before `/wiki/:pageId`; React Router ranks the
   static `tag` segment higher, so `/wiki/tag/foo` matches the tag route while a
   page literally named `tag` still matches `/wiki/:pageId`.

4. **Extract shared pieces.** The list-fetch logic moved into a `useWikiPages`
   hook (`src/hooks/use-wiki-pages.ts`) returning
   `{ pages, setPages, loading, error, refetch }` (used by both the list and tag
   pages; `setPages` is a `Dispatch<SetStateAction<...>>` so callers can apply
   search results and deletes). The card grid moved into a reusable
   `WikiPageGrid` component (`src/components/wiki-page-grid.tsx`) taking
   `pages` and an optional `onDelete` (the tag page omits it → no delete
   button). The delete-confirmation dialog stays in each parent page.

## Tests

- `src/lib/wiki-links.test.ts` — 7 `preprocessWikiLinks` unit tests (plain
  text, `[[target]]`, `[[target|alias]]`, multiple links, URL-encoding, label
  escaping, non-wikilink passthrough).
- `src/components/wiki-markdown.test.tsx` — 5 tests (wikilink → internal Link,
  external link → new tab + hostname, `/wiki/` markdown link → internal Link,
  GFM table rendering).
- `src/pages/wiki-editor.test.tsx` — 2 tests (`?create=1` pre-fills page ID and
  does not fetch; normal edit mode still fetches).
- `src/pages/wiki-tag.test.tsx` — 3 tests (filters by tag + count, empty state,
  pagination).
- `src/pages/wiki.test.tsx` — updated to assert the tag badge is a link to
  `/wiki/tag/ops`.

Full coordinator-ui suite green (42 tests), typecheck, build, and lint clean.

## Alternatives considered

- **`marked` for the UI** — rejected: `react-markdown` is the idiomatic React
  approach and gives component-level control for styling and link routing
  (the TUI's `marked` is a separate Ink implementation; the user accepted the
  dual-implementation quirk).
- **`@tailwindcss/typography`** — rejected: the project's design tokens are
  already Tailwind classes; custom components avoid a new dependency and match
  the existing look.
- **Server-side tag pages** — rejected for now: the UI already fetches the full
  page list, so client-side filtering is simplest. Known limitation: won't
  scale to thousands of pages; a follow-up plan
  (`plan-coordinator-wiki-tag-scaleup`) moves tag filtering coordinator-side
  (`?tag=` query param, `GET /api/wiki/tags` index, reserved-name guard for page
  id `tags`).

## Consequences

- Wiki pages render as readable markdown with working internal navigation and
  safe external links (new tab + hostname disclosure).
- Broken wikilinks land on a not-found state with a one-click path to create
  the missing page.
- Tags are navigable from both the list and detail views.
- `WikiMarkdown`, `useWikiPages`, and `WikiPageGrid` are the shared idioms for
  future wiki UI work.
- The follow-up `plan-coordinator-wiki-tag-scaleup` (coordinator-side tag
  filtering) depends on this work's `wiki-tag.tsx` / `WikiPageGrid` /
  `useWikiPages`.
