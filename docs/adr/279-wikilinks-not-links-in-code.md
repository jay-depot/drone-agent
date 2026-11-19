---
tags:
  [
    decision,
    drone-common,
    drone-swarm-common,
    drone-coordinator-ui,
    swarm-wiki,
    wikilinks,
    code-regions,
  ]
related:
  [
    245-search-path-rag-sources.md,
    260-keyword-wiki-index-and-beacon-fusion.md,
    279-wikilinks-not-links-in-code.md,
    modules/drone-swarm-common.md,
    modules/drone-coordinator-ui.md,
  ]
---

# ADR 279: Wikilinks inside code regions are not links

**Status**: Implemented (2026-11-13, branch `fix/no-wiki-links-in-codeblocks`)

## Context

The swarm memory wiki found `[[links]]` everywhere in a page body. A link that
sat inside a code block or an inline code span was treated as a real link. That
was wrong.

The reader's eye treats `[[x]]` in code as literal text — an example, not a
reference. So the wiki produced **false data** in four places:

- The `linkCount` (the `has links` filter and the Word Count column).
- The graph-view edges.
- The write-time "no downward links" check.
- The lint reports (broken links, downward links, orphans).

The coordinator web view showed the same text as a clickable link. So the reader
saw a link that did not exist.

Two surfaces parse wikilinks: the **coordinator web view** and the **wiki lint
and storage tools**. One rule must serve both. Two copies of one rule drift
apart in silence, because each copy has its own tests.

## Decisions

### D1 — Scope is everywhere

The rule applies to `lintPages` (broken links, downward links, orphans),
`buildGraph` edges, `readPage`/`listPages` `linkCount`, **and** `writePage`'s
downward-link rejection. All four agree. A coordinator page whose _only_
downward link sits inside a code block is no longer rejected on write. It was
never a link.

### D2 — "Code" means fenced blocks AND inline spans

A reader treats `` `x` `` and a fenced `x` the same way: literal text. If one
were a link and the other not, the lint would disagree with the reader's eye.

### D3 — Fences: backtick and tilde

` ``` ` and `~~~` are identical in CommonMark. Both appear in wiki pages.

### D4 — CommonMark fence rules

A closing fence must be at least as long as its opening fence. An unterminated
fence runs to the end of the document.

### D5 — 4-space indented code blocks are out of scope

They are rare in these pages. They are ambiguous with list indentation. A wrong
guess risks swallowing real prose.

### D6 — An unmatched backtick run stays literal text

CommonMark behaviour. It also avoids swallowing real links after a stray
backtick.

### D7 — Agent-side page lookup by name is unchanged

The beacon's keyword and vector index, and `swarm__wiki_read`, resolve by page
id. They do not parse links. A `[[foo]]` in a code block stays findable by name.

### D8 — One new package: `drone-common`

Zero dependencies. Isomorphic (browser-safe). Not `drone-ui-common`: the **node**
lint would then import a package named "ui". That is the same dishonest naming
this decision exists to avoid.

### D9 — One public function

`transformOutsideCodeRegions(markdown, fn)`. It splits the document into code
and non-code runs, applies `fn` to the non-code runs only, and rejoins. Code
runs come back byte-for-byte, so the web view keeps rendering its code blocks.

Both consumers pass a different `fn`:

| Consumer       | `fn`                                                             |
| -------------- | ---------------------------------------------------------------- |
| Lint / storage | collects `[[targets]]` into an array, returns the text unchanged |
| Web view       | the existing wikilink → markdown-link rewriter                   |

`segmentCodeRegions` (the splitter) stays module-private. There is no consumer
for raw ranges today.

### D10 — No raw-range export now

`findCodeRegions()` is not exported. Each consumer would then write its own
offset-filter loop — the drift risk again. Expanding to a raw-range export is
acceptable **if a real use appears**.

### D11 — `drone-core` keeps its name

516 import sites. The name is accurate. `drone-common` and `drone-core` are
near-synonyms, and that is an **accepted wart**. The naming rule below is
documented so it is not re-litigated: `drone-common` has **no dependencies** and
runs **anywhere**; `drone-core` is **node-only** and holds shared contracts. They
are not versions of each other.

### D12 — `drone-extension-ui-types` keeps its name

"Extension" is load-bearing. It is the _extension bundle_ contract, not general
UI types.

### D13 — `drone-common` does NOT absorb the existing UI-boundary duplications now

`splitFrontmatter` (`wiki-frontmatter.ts` duplicates `wiki-storage.ts`) and the
three fragment constants (`fragments.ts` duplicates `drone-swarm-common`) are
unrelated to this fix. A separate follow-up plan.

## Package inventory after this decision

| Package                    | Runtime deps                                               | Browser-safe |
| -------------------------- | ---------------------------------------------------------- | ------------ |
| `drone-core`               | `@sinclair/typebox`                                        | No           |
| `drone-common`             | none                                                       | Yes          |
| `drone-swarm-common`       | drone-core, drone-common, better-sqlite3, ws, transformers | No           |
| `drone-extension-ui-types` | none (types only)                                          | Yes          |

The UI cannot import the other two: `drone-core/src/utils.ts` imports
`node:fs/promises` and reads `process.platform`; `drone-swarm-common` pulls
better-sqlite3, ws, and onnx. Neither bundles in Vite.

## Graph view consequence

The graph gets the fix for free. The chain has one source of edges, and it is
the function this decision changes:

| Layer | File                                                                             | Role                                            |
| ----- | -------------------------------------------------------------------------------- | ----------------------------------------------- |
| Data  | `drone-swarm-common/src/wiki-storage.ts` → `buildGraph()`                        | calls `extractWikiLinks(page.content)` per page |
| Route | `drone-coordinator/src/routes/wiki.ts` → `GET /wiki/graph`                       | returns `buildGraph()`                          |
| Hook  | `drone-coordinator-ui/src/hooks/use-wiki-graph.ts`                               | fetches `/api/wiki/graph`                       |
| View  | `drone-coordinator-ui/src/components/wiki-graph.tsx` + `lib/wiki-graph-utils.ts` | consumes the edges                              |

`wiki-graph.tsx` does not parse markdown at all — it only draws edges it is
handed. "Free" means the behaviour is fixed. It does not mean it is tested, so
an explicit `buildGraph` regression test was added.

## Alternatives considered and rejected

- **Duplicate the function in both packages.** Cheaper now, and it matches local
  precedent (`wiki-frontmatter.ts`, `fragments.ts`). Rejected: it re-creates the
  exact failure mode the single-shared-function decision exists to prevent.
- **Put the rule in `drone-core`.** Rejected: `drone-core` is not browser-safe.
  Making it safe means splitting `utils.ts` — a bigger blast radius than a new
  package.
- **Name the new package `drone-ui-common`.** Rejected: the node lint would
  import a package named "ui".
- **Export `findCodeRegions()` (raw ranges) instead of the transform.**
  Rejected: each consumer would write its own offset-filter loop.
- **Handle 4-space indented code blocks.** Rejected: see D5.
- **Rename `drone-core` → `drone-agent-common`.** Rejected: 516 import sites,
  and the name is accurate.

## Out of scope

- 4-space indented code blocks.
- Folding `splitFrontmatter` and the fragment constants into `drone-common`.
- Renaming any package.
- Changing how the agent looks up a page by name.

## Validation

The rule is proven in three places:

- `drone-common/test/code-regions.test.ts` (13 cases) — the rule itself.
- `drone-swarm-common/test/wiki-storage.test.ts` — lint, `linkCount`,
  `buildGraph`, and `writePage`.
- `drone-coordinator-ui/src/lib/wiki-links.test.ts` and
  `wiki-markdown.test.tsx` — the web view.

Two revert-and-restore proofs confirm each gate bites: reverting the
`extractWikiLinks` change fails the storage tests, and reverting the
`preprocessWikiLinks` change fails the UI tests. Both were restored and pass.
