---
key: plan-coordinator-ui-wiki-frontmatter-collapse
tags:
  []
created: 2026-09-03T22:52:11.718Z
updated: 2026-09-03T22:52:11.718Z
---

# Plan: Collapse Redundant YAML Frontmatter in the Wiki Browser

## Summary
The `coordinator-wiki-librarian` persona regularly writes wiki pages whose markdown **body** begins with a redundant YAML frontmatter block (`id`, `title`, `scope`, `tags`, `sources`) that duplicates the structured fields the coordinator already stores. We don't want to delete it, but the wiki browser's read view currently renders it as raw text at the top of every such page. This plan collapses that block into a native `<details>` disclosure that is **closed by default**, showing the raw YAML verbatim when expanded.

**Where the redundancy lives:** `swarm__wiki_write` stores the librarian's `content` as the page body. `readPage()` in `drone-swarm-common/src/wiki-storage.ts` strips only the *outer* frontmatter that `writePage()` builds, so `page.content` still begins with the librarian's own `---\n...\n---\n` block. `WikiMarkdown` (`src/components/wiki-markdown.tsx`) is the single renderer (used only on the read view) and currently renders the whole string, so the redundant block shows as raw text.

**Detection convention:** reuse the same leading-frontmatter regex the storage layer already uses (`/^---\n([\s\S]*?)\n---\n/`).

## Steps

### 1. Add a frontmatter-splitting helper — `drone-coordinator-ui/src/lib/wiki-frontmatter.ts`
- `splitFrontmatter(content: string): { frontmatter: string | null; body: string }`
- Matches a leading `---\n...\n---\n` block (same regex shape as `wiki-storage.ts`). If matched, `frontmatter` is the raw YAML text (without the `---` fences) and `body` is the remainder; otherwise `frontmatter` is `null` and `body` is the full content.

### 2. Add helper tests — `drone-coordinator-ui/src/lib/wiki-frontmatter.test.ts`
- Splits a leading frontmatter block from the body.
- Returns `{ frontmatter: null, body }` unchanged when there is no leading block.
- Handles a body that itself contains `---` later (only the leading block is split).
- Handles empty body after the block.

### 3. Render the collapsed block in `WikiMarkdown` — `drone-coordinator-ui/src/components/wiki-markdown.tsx`
- Call `splitFrontmatter(children)` at the top of the component.
- If `frontmatter` is present, render a native `<details>` (closed by default) above the markdown body:
  ```tsx
  <details className="mb-4 rounded-md border border-border bg-muted/40">
    <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium text-muted-foreground">
      Metadata (YAML frontmatter)
    </summary>
    <pre className="px-3 pb-3 text-xs font-mono whitespace-pre-wrap overflow-x-auto">
      {frontmatter}
    </pre>
  </details>
  ```
- Render the `body` through the existing `<ReactMarkdown>` pipeline (unchanged). When there is no frontmatter, behavior is identical to today.

### 4. Extend `WikiMarkdown` tests — `drone-coordinator-ui/src/components/wiki-markdown.test.tsx`
- A page with a leading frontmatter block renders the summary label and does **not** render the YAML body text by default (collapsed).
- Clicking the summary expands and reveals the raw YAML.
- A page without frontmatter renders normally (no summary, body visible).

### 5. Validation — run the full checks:
- `pnpm -r run typecheck` (LSP clean in `drone-coordinator-ui`).
- `pnpm -r run lint` (eslint + prettier).
- `pnpm -r run build`.
- `pnpm -r run test` — new `wiki-frontmatter.test.ts` + updated `wiki-markdown.test.tsx` pass; no regressions elsewhere.

## Validation Criteria
- LSP passes with zero errors in `drone-coordinator-ui`.
- `pnpm -r run lint` and `pnpm -r run build` pass with zero errors.
- `pnpm -r run test` passes, including the new/updated tests.
- A wiki page whose content begins with a `---\n...\n---\n` block shows a collapsed "Metadata (YAML frontmatter)" disclosure; expanding it shows the raw YAML; the markdown body renders below.
- A wiki page without a leading frontmatter block renders exactly as before (no disclosure).
- No dead code; no duplicated frontmatter-splitting logic (the UI helper is the single place the browser splits it).
