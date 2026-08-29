---
name: project-wiki
description: 'Build and maintain a Karpathy-style LLM wiki from the project codebase as the source of truth'
recall:
  - you need to build or update a project wiki from the codebase
  - you need to ingest source code into structured knowledge
  - you need to query or lint a project wiki
  - you need to understand how the project is structured at a high level
model-invocation: true
---

# Project-wiki

## Overview

This skill implements **Karpathy's LLM Wiki pattern** (as described in [Andrej Karpathy's gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)) applied to a **codebase as the source of truth**. Instead of using RAG to re-discover knowledge from scratch on every query, the LLM incrementally builds and maintains a persistent, structured, interlinked collection of markdown files that sits between you and the raw source code.

The core insight: **the wiki is a persistent, compounding artifact.** Cross-references are already there. Architectural decisions have already been extracted. The synthesis already reflects everything in the codebase. The wiki gets richer with every source file you ingest and every question you ask.

For a codebase, this pattern is especially powerful because **git gives us incremental updates for free** — we can diff from the last ingested commit and only update affected wiki pages, rather than rescanning everything.

## Architecture

There are three layers:

### 1. Raw Sources — The Codebase

The project's source code at `HEAD`. This is the **source of truth** — the LLM reads from it but never modifies it. The code is immutable from the wiki's perspective.

For drone-agent, this means the files under `drone-agent/src/`, `drone-core/src/`, `drone-beacon/src/`, `drone-coordinator/src/`, plus config files, tests, and documentation.

### 2. The Wiki — Structured Knowledge

A directory of LLM-generated markdown files (e.g., `.drone-agent/wiki/`). The LLM owns this layer entirely — it creates pages, updates them when new code arrives, maintains cross-references, and keeps everything consistent. You read it; the LLM writes it.

Typical wiki pages for a codebase:

| Page Type                        | Description                                            | Example                                 |
| -------------------------------- | ------------------------------------------------------ | --------------------------------------- |
| **Module/package overview**      | What a package does, its key exports, its dependencies | `drone-agent-runtime.md`                |
| **Concept/abstraction**          | Key architectural concepts                             | `plugin-system.md`, `config-cascade.md` |
| **Entity/schema**                | Important types, models, data structures               | `DronePlugin.md`, `Session.md`          |
| **Flow**                         | Request/execution flows through the system             | `tool-call-flow.md`, `startup-flow.md`  |
| **Architecture Decision Record** | Notable design decisions and tradeoffs                 | `why-plugins.md`, `why-ink.md`          |
| **Index**                        | Catalog of all wiki pages with summaries               | `index.md`                              |
| **Log**                          | Chronological record of ingests and updates            | `log.md`                                |

### 3. The Schema — The Maintenance Contract

A document (or set of documents) that tells the LLM how the wiki is structured, what conventions to follow, and what workflows to use when ingesting code, answering questions, or maintaining the wiki. This is the key configuration — it's what makes the LLM a disciplined wiki maintainer rather than a generic chatbot.

For drone-agent, the schema is this skill file plus conventions defined in `AGENTS.md` and the project's config.

## Operations

### Ingest

When you ingest a source file (or set of files) into the wiki:

1. **Read** the source file(s) — understand the code, types, exports, and logic
2. **Identify affected pages** — which existing wiki pages need updating? (A single source might touch 3-8 pages)
3. **Update or create pages** — write summaries, update entity pages, revise flow diagrams, note new concepts
4. **Update the index** — refresh `index.md` with new/updated page entries
5. **Append to the log** — record what was ingested and when
6. **Advance the checkpoint** — record the last ingested commit SHA

For codebases, git makes this incremental:

- The initial ingest processes the entire repo at `HEAD`
- Subsequent ingests only need to look at what changed between the saved `last_commit` and the new `HEAD`
- Changed files, renames, and deletions are detected from the git diff
- Only affected wiki pages are updated

### Query

When you ask a question against the wiki:

1. **Read the index** — find which pages are relevant to the question
2. **Read relevant pages** — drill into the specific pages
3. **Synthesize an answer** — combine information from multiple pages, with citations
4. **Optionally file the answer** — good answers can be saved as new wiki pages (e.g., a comparison, an analysis, a discovered connection)

The key difference from raw code queries: the wiki already has the synthesis done. You're not re-discovering architecture from scratch — you're reading the compiled knowledge.

### Lint

Periodically health-check the wiki:

- **Contradictions** — do any pages disagree? (e.g., one page says "plugins are loaded eagerly" and another says "lazily")
- **Stale claims** — does a page reference code that has since been refactored or removed?
- **Orphan pages** — pages with no incoming links from other wiki pages
- **Missing pages** — important concepts mentioned in code but lacking their own wiki page
- **Missing cross-references** — related pages that should link to each other
- **Coverage gaps** — areas of the codebase that have no wiki coverage

## Wiki Structure (Recommended)

For a project wiki, use this directory layout:

```
[obsidian_vault_dir]/
├── index.md              ← Catalog of all pages with summaries
├── log.md                ← Chronological ingest/update log
├── meta.json             ← Last ingested commit SHA, schema version
├── architecture/         ← High-level architecture docs
│   ├── overview.md
│   ├── plugin-system.md
│   ├── config-cascade.md
│   └── ...
├── modules/              ← Per-module/package docs
│   ├── drone-agent-runtime.md
│   ├── drone-agent-tui.md
│   ├── drone-core-types.md
│   └── ...
├── concepts/             ← Key abstractions and patterns
│   ├── broker-provider.md
│   ├── workflow-system.md
│   └── ...
├── entities/             ← Important types and data structures
│   ├── DronePlugin.md
│   ├── Session.md
│   └── ...
├── flows/                ← Execution flows
│   ├── tool-call-loop.md
│   ├── startup.md
│   └── ...
├── decisions/            ← Architecture Decision Records
│   ├── 001-use-ink.md
│   ├── 002-plugin-system.md
│   └── ...
└── meta/                 ← Open questions, decisions, and declarations about how to use the project wiki itself
    ├── decision-bug-fixes-go-in-decisions.md
    ├── question-does-this-need-a-new-section.md
    └── ...
```

## Page Format

Each wiki page should follow a consistent format. Wiki pages use Obsidian-style `[[wikilinks]]` for cross-references — Recall your `obsidian-vault` skill for details on wikilink syntax, how to follow links, aliases, and embedding.

```markdown
---
tags: [module, architecture]
related: [plugin-system.md, config-cascade.md]
---

# Page Title

**Summary**: One sentence describing what this page covers.

## Overview

Brief description of the concept, module, or entity.

## Details

The main content. Use headings, lists, code blocks, and [[wikilinks]] to other wiki pages.

## Key Points

- Bullet list of important takeaways
- Design decisions, tradeoffs, gotchas

## Related

- [[Related Page]] — why it's related
- [[Another Page]] — what connects them
```

## Examples

### Example 1: Initial ingest of a new module

When a new package is added to the project (e.g., `drone-coordinator`):

1. Read the source files in `drone-coordinator/src/`
2. Create `wiki/modules/drone-coordinator.md` with an overview of its purpose, key types, and entry points
3. Update `wiki/architecture/overview.md` to mention the new package
4. Add cross-references from related pages (e.g., `wiki/concepts/swarm.md`)
5. Update `wiki/index.md` with the new page entry
6. Append to `wiki/log.md`: `## [2026-06-28] ingest | drone-coordinator package`

### Example 2: Incremental update after a refactor

When a plugin's tool registration API changes:

1. Run `git diff HEAD` to see what files changed
2. Identify affected wiki pages (e.g., `wiki/concepts/plugin-system.md`, `wiki/entities/DronePlugin.md`)
3. Read the changed source to understand the new API
4. Update the affected wiki pages with the new signatures and semantics
5. Check for contradictions with other pages
6. Update `wiki/index.md` summaries if needed
7. Append to `wiki/log.md`

### Example 3: Querying the wiki

Instead of reading raw source files to understand how plugins work:

1. Read `wiki/index.md` to find relevant pages (e.g., `plugin-system.md`, `DronePlugin.md`)
2. Read those pages — they already contain the synthesized understanding
3. If the answer requires more detail, follow [[wikilinks]] to related pages
4. If the answer reveals a gap, file a new wiki page

### Example 4: Linting the wiki

To health-check the wiki:

1. Check `wiki/index.md` against the actual codebase structure — are there modules without wiki pages?
2. Search for [[wikilinks]] in wiki pages that point to non-existent pages (broken links)
3. Read pages that haven't been updated recently and compare against the current code
4. Check for contradictions by reading related pages and comparing claims
5. Report findings and suggest fixes

## Tips

- **Ingest one source at a time** — process files individually and stay involved. Read the summaries, check the updates, guide what to emphasize.
- **Good answers can be filed** — when you ask a question and get a useful synthesis, save it as a new wiki page. Don't let valuable analysis disappear into chat history.
- **Use git as the change detector** — save the last ingested commit SHA in `meta.json`. On the next run, diff from there to `HEAD` and only update affected pages.
- **The index is your navigation layer** — at moderate scale (~hundreds of pages), reading the index first to find relevant pages, then drilling in, works surprisingly well without needing embedding-based RAG.
- **The log is your timeline** — append-only, chronological. Each entry with a consistent prefix (e.g., `## [2026-06-28] ingest | Module Name`) makes it parseable with simple tools.
- **Don't over-engineer** — start with a flat wiki and let it grow. Add structure (subdirectories, cross-references) as the wiki expands.
- **The wiki is just markdown in git** — you get version history, branching, and collaboration for free.
