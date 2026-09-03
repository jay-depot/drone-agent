---
key: plan-coordinator-wiki-browser-improvements
tags:
  []
created: 2026-09-03T21:49:30.693Z
updated: 2026-09-03T21:49:30.693Z
---

# Plan: Coordinator Wiki Browser Improvements

## Summary
Improve the coordinator web UI's wiki browser (all changes in `drone-coordinator-ui/`). Three features:
1. Render markdown on the wiki read view (currently raw `<pre>`).
2. Make links work: Obsidian `[[wikilinks]]` and standard markdown links navigate correctly; external links open in new tabs with the domain shown after the link text; the "wiki page not found" state gets a working "Create it" button.
3. Add virtual tag pages (`/wiki/tag/:tag`) that filter the already-fetched page list client-side, and make tag badges clickable.

No backend changes needed — the UI already fetches the full page list (`GET /api/wiki`), so tag filtering is done in the browser. Known limitation (accepted for now): client-side tag filtering won't scale to thousands of pages; revisit with a server-side tag endpoint when the knowledge base grows.

## Dependencies to add (drone-coordinator-ui/package.json)
- `react-markdown` (latest v9/v10)
- `remark-gfm` (latest v4)

## Steps

### 1. Add markdown dependencies
Add `react-markdown` and `remark-gfm` to `drone-coordinator-ui/package.json` dependencies. Run `pnpm install`.

### 2. Wikilink preprocessing helper — `src/lib/wiki-links.ts` (+ test)
Create a pure function that converts Obsidian wikilinks into standard markdown links so `react-markdown` can render them and the custom `a` component can route them:
- `[[target]]` → `[target](/wiki/<encodeURIComponent(target)>)`
- `[[target|alias]]` → `[alias](/wiki/<encodeURIComponent(target)>)`
- Escape markdown special chars in the alias/label text.
- Leave everything else untouched.
Export `preprocessWikiLinks(content: string): string`. Add `src/lib/wiki-links.test.ts` covering plain text, `[[target]]`, `[[target|alias]]`, multiple links, and non-wikilink markdown passthrough.

### 3. `WikiMarkdown` component — `src/components/wiki-markdown.tsx` (+ test)
Create a reusable component wrapping `react-markdown` + `remark-gfm` with custom components styled with the existing Tailwind design tokens (no `@tailwindcss/typography` dependency). Key custom component: `a`.
- If `href` starts with `/wiki/` → render a `react-router-dom` `<Link>` (client-side navigation).
- Else if `href` is external (`http:`/`https:`) → render `<a href target="_blank" rel="noopener noreferrer">` with the **hostname shown after the link text** (e.g. `[OpenAI](https://openai.com)` → `OpenAI (openai.com)`).
- Else → plain `<a>`.
Style headings, paragraphs, lists, code blocks, blockquotes, tables (GFM), inline code, hr, etc. with Tailwind classes matching the design system. Add `src/components/wiki-markdown.test.tsx` covering: wikilink → internal Link, external link → new tab + domain display, `/wiki/` markdown link → internal Link, GFM table rendering.

### 4. Render markdown on the read view — `src/pages/wiki-detail.tsx`
Replace the raw `<pre>{page.content}</pre>` in the Content card with `<WikiMarkdown>{page.content}</WikiMarkdown>`. Keep the Info card as-is.

### 5. "Create it" button on the not-found state — `src/pages/wiki-detail.tsx`
In the `error || !page` branch, add a "Create it" button that navigates to `/wiki/${pageId}/edit?create=1`. Keep the existing "← Back" button.

### 6. Editor create-mode via `?create=1` — `src/pages/wiki-editor.tsx` (+ test)
Modify the editor so a `?create=1` query param forces create mode even when a `pageId` is present:
- Read `create` from `useSearchParams`.
- `isEdit = !!pageId && create !== '1'`.
- The fetch effect returns early when `create === '1'` (skip fetch).
- When `create === '1'`, pre-fill `wikiPageId` from the `pageId` param and show the page-ID field (already shown when `!isEdit`).
Add `src/pages/wiki-editor.test.tsx` covering: `?create=1` shows the page-ID field pre-filled and does not fetch; normal edit mode still fetches.

### 7. Extract `useWikiPages` hook — `src/hooks/use-wiki-pages.ts`
Extract the list-fetch logic from `wiki.tsx` into a shared hook returning `{ pages, setPages, loading, error, refetch }`. Both the wiki list page and the new tag page use it. `setPages` is exposed so the list page can apply search results and deletes.

### 8. Extract `WikiPageGrid` component — `src/components/wiki-page-grid.tsx`
Extract the card grid (title, id, scope, tags, updated, delete button) from `wiki.tsx` into a reusable `WikiPageGrid` component taking `pages` and an `onDelete(page)` callback. Both the wiki list page and the tag page use it. The delete-confirmation dialog stays in each parent page.

### 9. Tag page — `src/pages/wiki-tag.tsx` + route
Create `WikiTagPage`:
- Reads `:tag` from `useParams`.
- Uses `useWikiPages()` and filters `pages` by `tags.includes(tag)`.
- Header showing the tag name + page count.
- Renders `WikiPageGrid` with the filtered pages + pagination (reuse `usePaginationOffset` + `paginationRange`).
- Empty state when no pages have the tag.
Register the route in `src/App.tsx`: `<Route path="/wiki/tag/:tag" element={<WikiTagPage />} />` (place it before `/wiki/:pageId`; React Router ranks the static `tag` segment higher, so `/wiki/tag/foo` matches the tag route while a page literally named `tag` still matches `/wiki/:pageId`).
Add `src/pages/wiki-tag.test.tsx` covering: filters by tag, shows count, empty state, pagination.

### 10. Make tag badges clickable — `src/pages/wiki.tsx` and `src/pages/wiki-detail.tsx`
Wrap each tag `Badge` in a `react-router-dom` `<Link to={/wiki/tag/${tag}}>` in both the list page and the detail page. Update `src/pages/wiki.test.tsx` to assert the tag badge is a link.

## Validation Criteria
- `pnpm -r run typecheck` passes (LSP clean in `drone-coordinator-ui`).
- `pnpm -r run lint` passes (eslint + prettier).
- `pnpm -r run build` passes.
- `pnpm -r run test` passes — all new tests (`wiki-links`, `wiki-markdown`, `wiki-editor`, `wiki-tag`, updated `wiki`) pass.
- Manual check: open a wiki page with markdown → rendered, not raw; `[[wikilink]]` navigates internally; external link opens new tab with domain shown; a broken link lands on not-found with a working "Create it" button; clicking a tag badge opens the tag page filtered to that tag.
- No dead code; no duplicated fetch/grid logic (extracted to `useWikiPages` / `WikiPageGrid`).
