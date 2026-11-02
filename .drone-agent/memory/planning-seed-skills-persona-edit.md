---
key: planning-seed-skills-persona-edit
tags:
  - planning-seed
  - skills
  - persona
  - diff
  - tooling
created: 2026-10-27T00:19:29.871Z
updated: 2026-10-27T00:19:29.871Z
---

# Planning seed: surgical edit for skills & personas

## Context

2026-10-26, branch feat/more-diff-improvements. We added diff-based `edit` actions to `memory__manage` (commit 1aca53ce) and `notepad__manage` (commit 0a3ed389), and extracted the shared cascade to `shared/patch-applier/edit-body.ts::applyEditToBody`. `swarm__wiki_edit` was the original. The user noted persona/skill management tools are **due for a larger wholesale overhaul soon**, so this is a seed, not a drive-by task.

## The gap

There is no way to surgically edit a skill or persona `.md` body. Agents must rewrite the whole file. Unlike memory/notepad, these are NOT a keyed store:

- Resolved through the **broker + provider** precedence system (project / user / swarm scope, provider precedence, duplicate-ID resolution by highest-precedence provider).
- Skills/personas can be **persona-owned** (stored under the persona dir) — see `persona-owned-skills` tests and `drone-agent/src/plugins/persona/` + `skills/`.
- An edit must therefore route through the provider API to resolve WHICH file to write, then apply the diff — not just `applyPatch` + a raw `fs.writeFile`.

## Design questions to resolve in the overhaul

1. Which tool(s)? A new `skills__edit` / `persona__edit`, or extend an existing action-based tool?
2. How does an edit resolve the target file across providers/ownership? Reuse the loader's resolution.
3. Locking: apply the ADR-237 `withKeyLock` pattern keyed on the resolved path (mirroring `file.ts`/memory)?
4. Metadata vs body: skills/personas have frontmatter (name, description, when-to-recall). Diff the body only, or frontmatter too?
5. Does this belong in the same wholesale overhaul as the tool-consolidation pattern decision (the user wants "one pattern for everything" eventually)?

## Reusable assets

- `applyEditToBody(body, diff, {label, toolName, targetNoun, recoveryTip})` in `drone-agent/src/shared/patch-applier/edit-body.ts` — handles parse/apply/render/summary/failure messages. A skill/persona edit just supplies a different `recoveryTip` and label.
- `withKeyLock` / `withPathLock` in `drone-agent/src/shared/keyed-lock.ts`.

## Also noted

`self-improvement__principle` is a **different** shape (indexed list, "replace #3"), not a diff-apply — deliberately excluded from the diff-edit family.
