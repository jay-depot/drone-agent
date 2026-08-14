---
key: plan-structure-aware-chunking
tags:
  []
created: 2026-08-14T04:56:31.461Z
updated: 2026-08-14T04:59:05.948Z
---

---
key: plan-structure-aware-chunking
tags: [search, semantic-search, chunking, beacon, tree-sitter]
created: 2026-08-14T00:00:00.000Z
updated: 2026-08-14T00:00:00.000Z
---

# Plan: Structure-Aware Chunking for Semantic Search (web-tree-sitter)

## Summary

Replace the beacon's current whole-file/paragraph chunking with a **file-type-routing, structure-aware chunker** built on **web-tree-sitter**. Code files chunk at AST boundaries (functions/classes/imports), Markdown at headings/paragraphs, JSON/YAML by lines with overlap, templates whole-file. Follows the research consensus (cAST, Elastic's four-strategy routing) that structure-aware chunking beats both fixed-size and semantic chunking for code and structured prose. Chunk size is decoupled from the embedding provider's `maxTokens` (a ceiling, not a target) and hardcoded to an opinionated ~480-token target.

## Design decisions

1. **web-tree-sitter** (WASM, language-agnostic, error-tolerant) as the AST foundation, built directly — NOT `code-chunk` — for full multi-language breadth and no `effect` dependency. `code-chunk` caps at 5 languages (TS/JS, Python, Rust, Go, Java); building directly gives C/C++ and easy additions.
2. **Four-strategy routing** by file extension (Elastic pattern): code → AST, Markdown → heading/paragraph, JSON/YAML → line-based w/ overlap, templates → whole-file, fallback → paragraph.
3. **Placement**: prose chunkers (`chunkMarkdown`, `chunkLines`, `chunkText`) in `drone-swarm-common` (dependency-free, reusable by the coordinator's future wiki search); AST chunker + router in `drone-beacon` (owns the web-tree-sitter dep).
4. **Hardcoded, opinionated config** (no config surface): `CHUNK_TARGET_TOKENS = 480`, line chunk 15/3, etc. Semantic search stays opinionated. Grammar set is extensible later (one registry line + one dep per language).
5. **Chunk size decoupled from `provider.maxTokens`**: target ~480 tokens, capped at `provider.maxTokens` for safety.
6. **No contextual-enrichment header** in this plan (future enhancement) — chunks stay pure code text so search-result snippets are unchanged in shape.

## Chunk-size semantics (the "target" is a bias, not a hard/soft limit)

Chunk boundaries are determined by AST structure (function/class/import boundaries). The token target only decides edge cases — it is a **bias**, not a hard or soft limit:

- **Merge floor (`minChars`) = 0.5 × target = 240 tokens.** Merge adjacent small units (tiny functions/helpers) until reaching ~240 tokens. Sits above the ~200-token "loses context" floor and inside the 256–768 sweet spot.
- **Split ceiling (`maxChars`) = 2 × target = 960 tokens.** Split oversized units at inner statement boundaries (never mid-statement) once they exceed ~960 tokens. Stays below the ~1000-token embedding-dilution threshold.
- **Everything between 240 and 960 tokens is kept whole** — the common case. A 30-line function and a 300-line class are both valid chunks regardless of size.

Derived char bounds use the ~4 chars/token estimate: `minChars = 240 * 4 = 960 chars`, `maxChars = 960 * 4 = 3840 chars`.

## Steps

### Step 1 — Add prose chunkers to `drone-swarm-common` *(coder)*
**File:** `drone-swarm-common/src/search-chunker.ts` (+ `index.ts`)

Keep `chunkText` (paragraph fallback). Add two pure, dependency-free functions, exported from `index.ts`:

- `chunkMarkdown(text, maxTokens): string[]` — split on `^#{1,6} ` headings, group each heading + following paragraphs into a section, respect `maxChars = maxTokens * 4`, split oversized sections at paragraph boundaries.
- `chunkLines(text, maxTokens, linesPerChunk = 15, overlap = 3): string[]` — sliding window over lines for JSON/YAML.

### Step 2 — Add web-tree-sitter + grammar deps to the beacon *(coder)*
**File:** `drone-beacon/package.json`

Add `web-tree-sitter` plus grammars: `tree-sitter-typescript`, `tree-sitter-javascript`, `tree-sitter-python`, `tree-sitter-c`, `tree-sitter-cpp`, `tree-sitter-rust`, `tree-sitter-go`, `tree-sitter-java`. **Pin `web-tree-sitter` and grammar versions together** (they track the tree-sitter runtime).

### Step 3 — Implement the AST chunker *(coder)*
**File:** `drone-beacon/src/code-chunker.ts` (new)

- A `GRAMMAR_REGISTRY: Record<string, string>` mapping extension → grammar wasm path (`.ts`/`.tsx` → `tree-sitter-tsx.wasm`, `.js`/`.jsx` → javascript, `.py`, `.c`/`.h`, `.cpp`, `.rs`, `.go`, `.java`). Adding a language = one registry line + one dep.
- Lazy, cached `getParser()` / `getLanguage()` — load wasm via `createRequire(import.meta.url)` + `node:fs/promises` (per project ESM/async-fs preference). **Import `.wasm` file paths directly, never grammar package roots** (avoids native-addon compilation).
- `chunkCode(filePath, content, maxTokens): Promise<string[] | null>` — returns `null` for unknown extensions (caller falls back). Algorithm:
  1. Parse with the extension's grammar.
  2. Collect top-level declaration nodes (`tree.rootNode.namedChildren`) as candidate units.
  3. Merge adjacent small units up to `minChars` (0.5× target); split oversized units at inner statement boundaries (`node.namedChildren`) above `maxChars` (2× target); never mid-statement.
  4. Return chunk texts (the indexer adds the `search_document:` prefix).

### Step 4 — Implement the file-type router *(coder)*
**File:** `drone-beacon/src/file-chunker.ts` (new)

`chunkFile(filePath, content, maxTokens): Promise<string[]>` dispatching by extension:
- Markdown (`.md`, `.markdown`, `.mdx`) → `chunkMarkdown`
- JSON/YAML (`.json`, `.yaml`, `.yml`) → `chunkLines`
- Templates (`.hbs`, `.handlebars`, `.gradle`, `.tmpl`) → whole-file
- Else → `chunkCode`; if it returns `null`, fall back to `chunkText`

### Step 5 — Wire the router into the indexer *(coder)*
**File:** `drone-beacon/src/search-indexer.ts`

- Add `const CHUNK_TARGET_TOKENS = 480;` (hardcoded, opinionated).
- Replace line 105 `const chunks = chunkText(content, provider.maxTokens);` with `const chunks = await chunkFile(filePath, content, Math.min(CHUNK_TARGET_TOKENS, provider.maxTokens));`
- Remove the now-unused `chunkText` import.

### Step 6 — Tests *(tester)*
- `drone-swarm-common/test/search-chunker.test.ts` (new): `chunkMarkdown` heading-aware grouping; `chunkLines` overlap; `chunkText` unchanged behavior.
- `drone-beacon/test/code-chunker.test.ts` (new): parses TS, splits at function boundaries, merges small functions, splits oversized functions, handles parse errors gracefully, supports multiple languages (TS, Python, Rust, Go, C).
- `drone-beacon/test/file-chunker.test.ts` (new): router dispatches `.ts` → code, `.md` → markdown, `.json` → lines, `.hbs` → whole-file, `.txt` → paragraph.
- `drone-beacon/test/search-indexer.test.ts`: add a test that the indexer routes through `chunkFile`.

### Step 7 — Review *(reviewer)*
Check correctness, dead code, duplication, and that the shared-interface change (chunker call site) swept all consumers (only `search-indexer.ts:105`).

### Step 8 — Validation *(coder)*
Run the full validation criteria below.

## Validation criteria

1. **LSP diagnostics clean** for all touched files (no new errors; note pre-existing branch diagnostics in `drone-agent/test/search.test.ts` and `prompt-file.test.ts` are out of scope).
2. `pnpm -r run build` passes (run **before** relying on LSP in `drone-beacon`, since it resolves `drone-swarm-common` from `dist/`).
3. `pnpm -r run typecheck` passes.
4. `pnpm -r run lint` passes.
5. `pnpm -r run test` passes (fast suite).
6. New chunker code covered by unit tests (Step 6).
7. No dead code / unused imports (e.g., `chunkText` import removed from indexer).

## Future work (not in this plan)
- Make the grammar set configurable (web-tree-sitter is extensible — one registry line + one dep per language).
- Contextual-enrichment header (file path, scope, signature) prepended to chunks before embedding.
- Small-to-big / parent-document retrieval (embed small units, expand to enclosing class/file for the model).
- Hybrid retrieval (semantic + BM25 via RRF) + code-aware reranking.
- A chunking evaluation harness (MRR@k + recall@k + concept-split diagnostics) if empirical validation is ever wanted.
