---
tags: [decision, search, semantic-search, chunking, beacon, tree-sitter]
related: [concepts/semantic-search.md, modules/drone-beacon.md, modules/drone-swarm-common.md, modules/drone-agent-plugins.md, decisions/127-semantic-search-beacon.md, decisions/130-dedupe-search-results-by-file.md]
---

# 129. Structure-Aware Chunking (web-tree-sitter)

**Summary**: Replaced the beacon's whole-file/paragraph chunking with a file-type-routing, structure-aware chunker built on **web-tree-sitter**. Code files chunk at AST boundaries (functions/classes/imports), Markdown at headings/paragraphs, JSON/YAML by lines with overlap, templates whole-file. Follows the research consensus (cAST, Elastic's four-strategy routing) that structure-aware chunking beats both fixed-size and semantic chunking for code and structured prose.

## Context

The beacon's semantic search previously chunked files by paragraphs then sentences, which effectively produced whole-file chunks for most source files (~32KB at the embedding provider's 8192-token ceiling). This diluted embeddings and produced poor retrieval. Research (cAST paper, Elastic's semantic-code-search-indexer, Ertas benchmark) showed structure-aware chunking is the highest-leverage improvement for code, and that semantic (embedding-based) chunking is not worth it for code (4–5× slower, no better).

## Decision

### 1. web-tree-sitter, built directly (not `code-chunk`)

`web-tree-sitter` is the language-agnostic, error-tolerant WASM AST parser. Built directly rather than adopting the `code-chunk` library because `code-chunk` caps at 5 languages (TS/JS, Python, Rust, Go, Java) and pulls an `effect` dependency. Building directly gives full multi-language breadth (C/C++, easy additions) with no extra runtime dep.

### 2. Four-strategy routing by file type (Elastic pattern)

- Code (`.ts`, `.js`, `.py`, `.c`, `.cpp`, `.rs`, `.go`, `.java`, …) → AST chunker
- Markdown (`.md`, `.markdown`, `.mdx`) → heading/paragraph chunker
- JSON/YAML (`.json`, `.yaml`, `.yml`) → line-based with overlap
- Templates (`.hbs`, `.handlebars`, `.gradle`, `.tmpl`) → whole-file
- Fallback → paragraph chunker (`chunkText`)

### 3. Placement

- Prose chunkers (`chunkMarkdown`, `chunkLines`, `chunkText`) live in `drone-swarm-common` (dependency-free, reusable by the coordinator's future wiki search).
- AST chunker + router live in `drone-beacon` (owns the web-tree-sitter dependency).

### 4. Hardcoded, opinionated config

`CHUNK_TARGET_TOKENS = 480`. Semantic search stays opinionated — no config surface. The grammar set is extensible later (one registry line + one dep per language).

### 5. Chunk-size semantics (target is a bias, not a hard limit)

Chunk boundaries are determined by AST structure. The token target only decides edge cases:

- **Merge floor** = 0.5× target = 240 tokens (960 chars) — merge adjacent small units up to this.
- **Split ceiling** = 2× target = 960 tokens (3840 chars) — split oversized units above this at statement boundaries (never mid-statement).
- **Everything between 240–960 tokens is kept whole** — the common case.

### 6. No contextual-enrichment header (future enhancement)

Chunks stay pure code text so search-result snippets are unchanged in shape.

## Implementation

- **`drone-swarm-common/src/search-chunker.ts`** — kept `chunkText`; added `chunkMarkdown` (heading/paragraph grouping) and `chunkLines` (line-window with overlap); extracted a shared `splitBySentences` helper.
- **`drone-beacon/src/code-chunker.ts`** — `GRAMMAR_REGISTRY` (ext → wasm path), lazy cached `getParser()`/`getLanguage()` (wasm via `createRequire` + `node:fs/promises`), `chunkCode()` that collects top-level units (attaching leading comments/docstrings), merges small units, splits oversized units at statement boundaries, keeps function signatures attached to bodies (avoids header orphaning), and treats ERROR nodes as units so syntax-error files still get indexed.
- **`drone-beacon/src/file-chunker.ts`** — `chunkFile()` routes by extension with the four strategies + fallback.
- **`drone-beacon/src/search-indexer.ts`** — wired `chunkFile` into indexing with `CHUNK_TARGET_TOKENS = 480`.
- Added `web-tree-sitter` + 8 grammar deps to `drone-beacon`; set `allowBuilds: false` for the grammars in `pnpm-workspace.yaml` (used via WASM only; native bindings not needed).

## Result

Files are now chunked at semantic (AST) boundaries instead of whole-file. A query matching several chunks from the same file now returns that file multiple times — which led to the file-level dedup work in [[decisions/130-dedupe-search-results-by-file]].

## Related

- [[decisions/127-semantic-search-beacon]] — semantic search moved to the beacon
- [[decisions/130-dedupe-search-results-by-file]] — dedupe results after structure-aware chunking
- [[decisions/131-sqlite-vec-semantic-search]] — vector search moved to sqlite-vec
- [[concepts/semantic-search]] — the semantic search concept
- [[modules/drone-beacon]] — beacon module
- [[modules/drone-swarm-common]] — prose chunkers
