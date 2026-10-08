---
tags:
  [
    decision,
    skills,
    persona,
    swarm,
    beacon,
    coordinator,
    coordinator-ui,
    isolation,
    adr,
  ]
related:
  [
    concepts/identity-assets.md,
    concepts/scope-hierarchy.md,
    entities/Skill.md,
    entities/Persona.md,
    modules/drone-core.md,
    modules/drone-agent-plugins.md,
    modules/drone-beacon.md,
    modules/drone-coordinator.md,
    modules/drone-coordinator-ui.md,
  ]
---

# 226 — Persona-owned skills at beacon/coordinator scope (+ true isolation at all scopes + coordinator-UI exposure)

**Status**: Implemented · **Branch**: `feat/swarm-persona-owned-skills` · **Plan**: project-memory `plan-persona-owned-skills-swarm-scope` · **Seed**: project-memory `planning-seed-agent-authored-persona-owned-skills`

**Summary**: Persona-owned skills — a persona's private, automatically-attached skills — now work at
**beacon/coordinator scope**, not just user/project scope, and are shown with full CRUD on the persona page of
the coordinator UI. The change also **fixes the ownership semantics**: owned skills are now truly isolated
(visible only to their owning persona) at _every_ scope, where before ownership merely shaped the `# Skills`
prompt fragment while `skills__list`, `skills__recall`, and `@skill:` leaked every persona's skills to everyone.

## Why

Only two providers produced owned skills — `persona-provider-user` and `persona-provider-project`, each reading
`<personas-dir>/<id>/skills/*.md`. Swarm-scoped personas (beacon/coordinator) could not own skills, and the
coordinator had no ownership concept at all (its `skills` table was flat, with no persona link).

Worse, "owned" did not mean "isolated": the only persona filter lived in `persona/index.ts`
`getFilteredSkills()`, consumed solely by the `# Skills` header fragment. `skills__list`, `skills__recall`, and
the `@skill:` reference resolved through the broker's unfiltered `getAllSkills()`/`findSkill()`, so one persona's
private skill was recallable by every other persona. This ADR corrects that while extending ownership to swarm
scope.

## Locked design decisions (13)

1. **True isolation** — an owned skill is visible only to its owning persona, at every scope; plus swarm-scope
   extension and UI exposure. This is a redesign/fix of user/project behavior, not only a new feature.
2. **Enforce at all LLM-facing seams** — the `# Skills` header fragment, `skills__list`, `skills__recall`, and
   the `@skill:` reference all resolve through one persona-aware accessor. **Carve-out:** the broker's raw
   capability API (`DroneSkillsCapability.getSkills`/`getSkill`) stays unfiltered — it is infrastructure, not a
   presentation surface. Operator views (`/skills list|recall|reload`, `skills__list includeRemark`) also stay
   unfiltered; `skills__list`/`skills__recall` gained an opt-in `all: true` for that administrative view.
3. **Storage** — a nullable `personaId` column on both `skills` tables (`NULL` = global), threaded through the
   `drone-core` `Skill`/`CreateSkillRequest` types, DB accessors, wire responses, and UI types, with an
   idempotent legacy-table migration.
4. **Scope inheritance** — an owned skill inherits its owner's scope (beacon-local persona ⇒ `scope='local'`;
   coordinator persona ⇒ `scope='coordinator'`). The beacon→coordinator **push is suppressed for owned skills**,
   so a local persona's private skill cannot leak swarm-wide via push + import-back. Global-skill sync unchanged.
5. **UI** — the persona detail page gains an **Owned Skills** card with full CRUD (Add/Edit/Remove) backed by
   new coordinator routes. Agent-side wizard authoring is deferred to a separate planning-seed memory.
6. **Deletion cascade** — deleting a persona cascade-deletes its owned skills (transactional). A
   `personaId`-scoped reconcile sweep in `runCoordinatorSync` drops beacon rows whose owner vanished, and
   coordinator-scoped global rows that vanished are reconciled behind a successful, non-empty fetch guard.
7. **Flat public ids; composite internal keying** — owned and global skills may share a public id. The broker
   dedupes on the composite `(personaId, id)` identity (fixing a pre-existing cross-persona overwrite bug), and
   resolution is owner-wins for the owner, global-or-nothing for everyone else. No id prefix.
8. **No seeded-asset ownership change** — `memory-wiki` stays global; ownership is opt-in and forward-only.
9. **No active persona ⇒ owned skills hidden** — a persona-less session sees globals only.
10. **`drone-migrate` extended** — nested listing under `personas/<id>/skills/`, `personaId` in the
    promote/demote payloads, a `--persona-id` CLI flag, both directions, tested.
11. **Self-improvement paths gated to local scopes** — the persona-directory routing for a skill's
    insights/principles applies only to `user`/`project` skills; swarm-owned-skill insights ride the normal
    swarm engine keyed by skill id.
12. **No scope selector in the owned-skill editor** — scope is derived from the owner, never chosen.
13. **Synthetic storage key** — a `key` PK column equals `personaId ? '<personaId>/<skillId>' : '<skillId>'`;
    `id` becomes a plain column. Global rows keep `key === id`, so existing single-id addressing is unchanged;
    cascade delete is a plain `WHERE personaId = ?`.

## Implementation

- `drone-core/src/skill-key.ts` — **new** `skillStorageKey(personaId, id)`; `domain-types.ts` `Skill` gains
  `key` + `personaId`, `CreateSkillRequest` gains `personaId?`.
- `drone-beacon/src/db/init.ts`, `drone-coordinator/src/db/init.ts` — `skills` table rebuilt with
  `key TEXT PRIMARY KEY` + `personaId TEXT`; idempotent migration backfills `key = id`, `personaId = NULL`.
- `drone-{beacon,coordinator}/src/db/skills.ts` — key-addressed accessors (`getSkillByKey`, `getGlobalSkill`,
  `listSkillsByPersona`, `updateSkillByKey`, `deleteSkillByKey`, `deleteSkillsByPersona`,
  `deletePersonaWithSkills`); the beacon adds `deleteOwnedSkillsNotIn` / `deleteCoordinatorGlobalSkillsNotIn`.
- `drone-{beacon,coordinator}/src/routes/skills.ts` + `routes/personas.ts` — global routes address
  `key === id`; new `/personas/:id/skills[/:skillId]` CRUD; cascade delete; push suppression for owned skills.
- `drone-beacon/src/{coordinator-client.ts,routes/context.ts}` — `personaId` passthrough + the reconcile sweeps.
- `drone-agent/src/plugins/persona/owned-skills.ts` — **new** shared discovery helper (keyed by composite
  identity) used by both persona providers, which no longer duplicate the logic.
- `drone-agent/src/plugins/skills/keying.ts` — **new** `findSkillByPublicId`. `plugins/swarm/providers.ts` sets
  `personaId` from the wire and keys its maps compositely.
- `drone-agent/src/plugins/persona/index.ts` — `isSkillVisible` on the capability; `getFilteredSkills` filters
  first, then applies `allowedSkills` globs to globals only.
- `drone-agent/src/plugins/skills/index.ts` — `getVisibleSkills`/`resolveVisibleSkill` (owner-wins), composite
  `getAllSkills` dedupe, the `all` operator flag on both tools, and the `/skills` slash command passing it.
- `drone-agent/src/{cli.ts,migrate.ts}`, `runtime/migration/*` — owned-skill migration support.
- `drone-coordinator-ui/src/pages/persona-detail.tsx` — Owned Skills card; **new**
  `persona-skill-editor.tsx`; `App.tsx` routes; `skills.tsx` owner badge; `lib/types.ts` `key`/`personaId`.

## Verification

New suites: beacon (13), coordinator (7), agent isolation (9), agent migration (5), agent self-improvement
paths (5) — all green. `pnpm -r run typecheck`, `pnpm -r run build`, and the UI build pass. Pre-existing,
unrelated failures (`Markdown.test.tsx`, `wiki-indexer`, `wiki-routes` graph, `multiline-text-input`) were
confirmed present at the base commit and touch none of the changed files.
