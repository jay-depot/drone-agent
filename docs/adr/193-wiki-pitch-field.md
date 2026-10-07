---
tags: [decision, drone-core, drone-swarm-common, drone-beacon, drone-coordinator, drone-agent, drone-swarm, drone-coordinator-ui, wiki, rag]
related: [modules/drone-core.md, modules/drone-swarm-common.md, modules/drone-beacon.md, modules/drone-coordinator.md, modules/drone-agent-plugins.md, modules/drone-swarm.md, modules/drone-coordinator-ui.md, concepts/memory-pipeline.md, concepts/semantic-search.md, decisions/179-swarm-memory-rag-retrieval.md, decisions/180-swarm-memory-bootstrap-workflow.md]
---

# 193: Wiki page `pitch` as an official schema field

**Status**: Implemented (2026-09-04, branch `feat/memory-wiki-browser-improvements`, from completed plan `plan-swarm-memory-wiki-pitch-field`)

## Context

The swarm-memory RAG fragment ([[decisions/179-swarm-memory-rag-retrieval]])
displayed a per-page "pitch" assembled **procedurally**:
`truncatePitch(result.matchedChunk ?? '')` — the first chunk of the page that
happened to win the vector search. An arbitrary retrieval artifact was standing
in for a curated summary. The wiki schema had no field for the one-sentence
pitch the librarian persona was effectively writing into its page intros
anyway.

## Decision

Make `pitch` an official, optional, stored schema field and source the RAG
fragment from it (field-first, `matchedChunk` fallback for uncurated pages).

- **Type** (`drone-core/src/wiki-types.ts`): `DroneWikiPageMeta.pitch?: string`.
- **Storage** (`drone-swarm-common/src/wiki-storage.ts`): `buildFrontmatter`
  emits `pitch:` only when non-empty (frontmatter stays clean for optional
  fields); `writePage` gains a trailing optional `pitch` parameter; `readPage`
  and **`listPages`** parse it through — `listPages` builds each meta
  field-by-field (not a spread), so the new field must be added there explicitly
  or it silently vanishes from list payloads.
- **Routes**: beacon + coordinator `PUT /wiki/:pageId` accept `pitch` in the
  body; beacon `GET /wiki/semantic-search` enriches every result with the
  page's stored `pitch` (`PageMetaLite.pitch`), for both the local branch and
  the coordinator-proxied branch.
- **Agent RAG** (`drone-agent/src/plugins/swarm/`): `wiki_write` accepts and
  forwards `pitch`; `memory-retrieval.ts` prefers
  `result.pitch ?? result.matchedChunk` (fallback retained so pages without a
  pitch still render something).
- **CLI + migration**: `drone-swarm wiki write --pitch`; migration
  `migrateWikiPage` passes `pitch` through.
- **UI** (`drone-coordinator-ui`): Pitch field in the wiki editor; Pitch row in
  the detail page info card (only when present). Grid cards untouched.
- **Seeds** (`drone-coordinator/src/default-assets.ts`): the librarian persona
  prompt gains an explicit "write a one-sentence pitch" step, and the
  memory-wiki skill seed shows a `pitch:` frontmatter example. `PRIOR_*`
  repair markers are made number-agnostic (the pitch step renumbered the
  summarize step, and a numbered marker would break auto-repair). Existing
  installed skill copies are not force-updated — the persona has its own
  `repairSeededLibrarianAssets` mechanism.

No migration: `pitch` is optional on every write path; existing pages (and
pages written without one) stay valid.

## Consequences

- RAG results show the *curated* pitch; `matchedChunk` only appears for pages
  the librarian has not yet curated.
- Adding a schema field to `wiki-storage.listPages` requires touching its
  explicit field list — a spread would have avoided this, but the explicit
  shape is deliberate; grep for field lists when extending the schema.

## Tests

- `wiki-storage`: pitch round-trip, frontmatter emission only when non-empty,
  `listPages` carries it (3 new).
- Beacon + coordinator route tests: PUT round-trip (with/without pitch);
  semantic-search results carry `pitch` when present, absent otherwise
  (coordinator route tests isolate the KB dir with `setKnowledgeBaseDir(mkdtemp())`).
- Agent: retrieval field-first/fallback, fragment renders stored pitch,
  `swarm-tool-input-validation` wiki_write body assertion.
- drone-swarm CLI `--pitch`; migration pitch pass-through.
- UI: editor load/submit pitch; detail renders/omits the Pitch row.
- Seeds: librarian prompt + memory-wiki skill contain pitch guidance.

## Related

- [[decisions/179-swarm-memory-rag-retrieval]] — the RAG pipeline consuming it
- [[decisions/180-swarm-memory-bootstrap-workflow]] — the librarian persona it curates for
- [[concepts/memory-pipeline]] — write/read sides
