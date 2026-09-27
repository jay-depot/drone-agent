---
key: plan-persona-owned-skills-swarm-scope
tags: []
created: 2026-09-27T00:34:10.003Z
updated: 2026-09-27T00:34:10.003Z
---

# Plan: Persona-Owned Skills at Beacon/Coordinator Scope (+ true isolation at all scopes + coordinator-UI exposure)

STATUS: ready for execution. Created 2026-09-26.

## 1. What & Why

**Feature.** Extend _persona-owned skills_ — a persona's private, automatically-attached skills — from
user/project scope to **beacon/coordinator (swarm) scope**, and expose them on the persona's page in the
coordinator UI with full CRUD.

**Why.** Today only `~/.drone-agent/personas/<id>/skills/*.md` and `<project>/.drone-agent/personas/<id>/skills/*.md`
produce owned skills. Swarm-scoped personas cannot own skills, and the coordinator has no notion of ownership
at all (its `skills` table is flat).

**This is also a redesign/fix.** Ownership today is NOT isolation. The only persona filter lives in the
`# Skills` header fragment (`persona/index.ts: getFilteredSkills`). `skills__list`, `skills__recall`, and the
`@skill:` reference go through the broker's unfiltered `getAllSkills()`/`findSkill()`. So this plan also makes
ownership mean **true isolation at every scope** (owned skill visible only to its owner), fixing user/project
behavior at the same time.

## 2. Locked Decisions (do not re-litigate)

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                               |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Goal = **true isolation**: an owned skill is visible ONLY to its owning persona, at every scope. Plus swarm-scope extension + UI.                                                                                                                                                                                                                                                      |
| D2  | Enforce at **all LLM-facing seams**: `# Skills` header fragment, `skills__list`, `skills__recall`, `@skill:`. One persona-aware accessor. **Carve-out:** the broker's raw API (`DroneSkillsCapability.getSkills`/`getSkill`) stays unfiltered (infrastructure). **Not** extended to operator views: `/skills list\|recall\|reload` and `skills__list includeRemark` remain unfiltered. |
| D3  | Persist a **nullable `personaId`** column on both `skills` tables (`NULL` = global); thread through drone-core types, DB accessors, wire responses, UI types. Idempotent migration.                                                                                                                                                                                                    |
| D4  | An owned skill **inherits its owner's scope** (beacon-local persona ⇒ `scope='local'`; coordinator persona ⇒ `scope='coordinator'`). The beacon→coordinator **push is suppressed for owned skills** (prevents a local persona's private skill leaking swarm-wide via push+import-back). Global-skill sync is untouched.                                                                |
| D5  | Persona detail page gains an **Owned Skills card with full CRUD** (Add/Edit/Remove), backed by new coordinator routes. Agent-side wizard authoring **deferred** to a separate planning-seed memory.                                                                                                                                                                                    |
| D6  | Deleting a persona **cascade-deletes its owned skills** (transactional). Add a **`personaId`-scoped reconcile sweep** to `runCoordinatorSync`. Fix other deletion-cascade defects found while in here.                                                                                                                                                                                 |
| D7  | **Flat public ids**; internal **composite `(personaId, id)` keying** (fixes today's cross-persona overwrite bug). Rule: an owned skill **wins for its owner**; everyone else gets the global skill or nothing. No id prefix.                                                                                                                                                           |
| D8  | **No seeded-asset ownership change.** `memory-wiki` stays global. Ownership is opt-in and forward-only.                                                                                                                                                                                                                                                                                |
| D9  | With **no active persona**, owned skills are **hidden**; only globals are visible.                                                                                                                                                                                                                                                                                                     |
| D10 | **Extend `drone-migrate`** for owned skills: nested listing, owner in payload, both directions, tests.                                                                                                                                                                                                                                                                                 |
| D11 | Gate the self-improvement `personaId` routing to **local scopes only**; swarm-owned-skill insights ride the normal swarm engine keyed by skill id.                                                                                                                                                                                                                                     |
| D12 | The owned-skill UI editor has **no scope selector**; scope is derived from the owner.                                                                                                                                                                                                                                                                                                  |
| D13 | Storage uses a **synthetic `key` PK** = `personaId ? '<personaId>/<skillId>' : '<skillId>'`; `id` becomes a plain column. Global rows keep `key === id`, so existing single-id addressing is unchanged. Cascade delete = `WHERE personaId = ?`.                                                                                                                                        |

## 3. Ordered Steps

Each step: **Agent**, **Depends on**, **Files**, instructions, snippet.

### Step 1 — drone-core types + shared key helper [coder]

Depends: none.
Files: `drone-core/src/skill-types.ts`, `drone-core/src/domain-types.ts`, new `drone-core/src/skill-key.ts`, `drone-core/src/index.ts`.

1a. Add to `domain-types.ts` `Skill`:

```ts
export type Skill = {
  key: string; // storage PK: personaId ? `${personaId}/${id}` : id
  id: string; // public id (flat, may repeat across owners)
  name: string;
  description: string;
  trigger: string;
  body: string;
  scope: 'local' | 'coordinator';
  personaId: string | null; // null = global skill
  createdAt: number;
  updatedAt: number;
};
```

1b. `CreateSkillRequest` gains `personaId?: string | null` (carried by promote + beacon push).
1c. New `skill-key.ts`:

```ts
export function skillStorageKey(
  personaId: string | null | undefined,
  id: string
): string {
  return personaId ? `${personaId}/${id}` : id;
}
```

export from `index.ts`.
1d. Re-implement in the plan's chosen shape (see note) — keep `DroneSkillDefinition.personaId` as-is.

NOTE for D12/UI: the _runtime_ `DroneSkillDefinition` keeps only `personaId`; `key` is a storage concern.

### Step 2 — Beacon + Coordinator schema migration [coder]

Depends: Step 1.
Files: `drone-beacon/src/db/init.ts`, `drone-coordinator/src/db/init.ts`.

2a. Change the `CREATE TABLE skills` block in both to `key TEXT PRIMARY KEY, id TEXT NOT NULL, ..., scope ..., personaId TEXT, ...`.
2b. Add an idempotent migration to BOTH (mirror the beacon_config rebuild precedent):

```ts
const skillCols = db.prepare('PRAGMA table_info(skills)').all() as Array<{
  name: string;
}>;
if (skillCols.length > 0 && !skillCols.some(c => c.name === 'key')) {
  db.exec(`
    CREATE TABLE skills_new (
      key TEXT PRIMARY KEY, id TEXT NOT NULL, name TEXT NOT NULL,
      description TEXT NOT NULL, trigger TEXT NOT NULL, body TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'local', personaId TEXT,
      createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
    );
    INSERT INTO skills_new (key, id, name, description, trigger, body, scope, personaId, createdAt, updatedAt)
      SELECT id, id, name, description, trigger, body, scope, NULL, createdAt, updatedAt FROM skills;
    DROP TABLE skills;
    ALTER TABLE skills_new RENAME TO skills;
  `);
} else if (
  skillCols.length > 0 &&
  !skillCols.some(c => c.name === 'personaId')
) {
  db.exec('ALTER TABLE skills ADD COLUMN personaId TEXT');
}
```

### Step 3 — Beacon + Coordinator skills DB accessors [coder]

Depends: Step 2.
Files: `drone-beacon/src/db/skills.ts`, `drone-coordinator/src/db/skills.ts`.

3a. Address by **`key`** (not `id`). Replace `getRow/deleteRow` usage with explicit SQL (do NOT widen the shared `db-helpers` signature — keeps persona paths untouched):

```ts
export function getSkillByKey(key: string): Skill | undefined {
  /* SELECT * FROM skills WHERE key = ? */
}
export function getGlobalSkill(id: string) {
  return getSkillByKey(id);
} // key === id for globals
export function listSkillsByPersona(personaId: string): Skill[] {
  /* WHERE personaId = ? ORDER BY name */
}
export function deleteSkillsByPersona(personaId: string): number {
  /* DELETE ... WHERE personaId = ? */
}
```

3b. `createSkill(req, opts?: { scope?: 'local'|'coordinator'; personaId?: string|null })` computes `key = skillStorageKey(personaId, req.id)`, stores `personaId`. Coordinator default scope `'coordinator'`, beacon default `'local'`.
3c. `updateSkill` must not change `key`/`id`/`scope`/`personaId` (only name/description/trigger/body/updatedAt).
3d. `upsertSkillFromCoordinator(s: Skill)` writes `key, id, ..., personaId` (`INSERT OR REPLACE`).
3e. `getSkill(id)` retained as a **plain-id, global-first** lookup for backward compat, but internal callers move to `getSkillByKey`/`getGlobalSkill`.

### Step 4 — Beacon + Coordinator skill routes [coder]

Depends: Step 3.
Files: `drone-beacon/src/routes/skills.ts`, `drone-beacon/src/routes/personas.ts`, `drone-coordinator/src/routes/skills.ts`, `drone-coordinator/src/routes/personas.ts`.

4a. Keep global routes addressing `key === id`: `GET/POST /skills`, `GET/PUT/DELETE /skills/:id` (global only).
4b. Add persona-scoped owned-skill routes (avoid slashes in path segments):

```
GET    /personas/:id/skills            -> listSkillsByPersona(:id)
POST   /personas/:id/skills            -> createSkill({...body}, { personaId: :id, scope: <derived> })
PUT    /personas/:id/skills/:skillId   -> updateSkillByKey(`${:id}/${:skillId}`)
DELETE /personas/:id/skills/:skillId   -> deleteByKey(`${:id}/${:skillId}`)
```

`scope` is server-derived: coordinator route ⇒ `'coordinator'`; beacon route ⇒ owner persona's scope from `getPersona(:id)`.
4c. Beacon `POST /skills` and `PUT /skills/:id`: **suppress the coordinator push when `personaId != null`** (D4).
4d. Beacon `DELETE /personas/:id`: **transactional cascade** — `deleteSkillsByPersona(:id)` then `deletePersona(:id)`; keep the existing local-scope push-delete. Coordinator `deletePersona` gets the same cascade.
4e. Return `personaId` in all skill payloads.

### Step 5 — Beacon↔Coordinator sync: personaId passthrough + reconcile sweep [coder]

Depends: Steps 3, 4.
Files: `drone-beacon/src/coordinator-client.ts`, `drone-beacon/src/routes/context.ts`.

5a. `fetchSkills()` maps `personaId` through (keep the `scope:'coordinator'` re-tag). `pushSkill()` includes `personaId` in the body.
5b. In `triggerCoordinatorSync` (`routes/context.ts`, after the `upsertSkillFromCoordinator` loop) add:

```ts
// Owned-skill reconcile: drop beacon rows whose owner vanished from the coordinator.
const coordinatorPersonaIds = new Set(personas.map(p => p.id));
db.deleteOwnedSkillsNotIn(coordinatorPersonaIds); // DELETE ... WHERE personaId IS NOT NULL AND personaId NOT IN (...)
```

5c. (D6 "fix cascade defects found") Also reconcile **coordinator-scoped global** rows: `DELETE FROM skills WHERE scope='coordinator' AND personaId IS NULL AND id NOT IN (fetched ids)` — **guarded by a successful, non-empty fetch** (mirror the `knowledge.length > 0` guard) so a failed/empty pull never wipes local data.
5d. `deleteOwnedSkillsNotIn` handles the empty-set case explicitly (`personaId IS NOT NULL` only), so it is always safe to run.

### Step 6 — Agent: swarm provider carries owner; composite keying [coder]

Depends: Steps 1, 4.
Files: `drone-agent/src/plugins/swarm/providers.ts`, `drone-agent/src/plugins/swarm/context.ts`, `drone-agent/src/plugins/persona-provider-user/index.ts`, `drone-agent/src/plugins/persona-provider-project/index.ts`.

6a. `interface BeaconSkill` gains `personaId?: string | null`; `reloadFromBeacon` sets `definition.personaId = s.personaId ?? undefined`.
6b. Key `beaconSkills`/`coordinatorSkills` maps by `skillStorageKey(personaId, id)`; `getSkill(id)` scans for the first entry whose `.id === id` (keeps the provider interface unchanged — do NOT change `DroneSkillProvider`).
6c. Same composite-key fix in `persona-provider-{user,project}`'s `newSkills` map (today `newSkills.set(skill.id, …)` silently overwrites a same-named skill owned by two personas).
6d. Extract the duplicated persona-owned-skills discovery from the two persona providers into ONE shared helper (they are ~95% identical) — `drone-agent/src/plugins/persona/owned-skills.ts`, used by both.

### Step 7 — Agent: isolation enforcement in the broker seam [coder]

Depends: Step 6.
Files: `drone-core/src/persona-types.ts`, `drone-agent/src/plugins/persona/index.ts`, `drone-agent/src/plugins/skills/index.ts`.

7a. Add to `DronePersonaCapability`:

```ts
isSkillVisible: (skill: DroneSkillDefinition) => boolean;
```

7b. In `persona/index.ts`:

```ts
function isSkillVisible(skill: DroneSkillDefinition): boolean {
  if (!skill.personaId) return true; // global
  return activePersona?.id === skill.personaId; // owned: owner only (D9: no persona ⇒ hidden)
}
function getFilteredSkills(allSkills) {
  if (!activePersona) return allSkills.filter(isSkillVisible);
  const visible = allSkills.filter(isSkillVisible);
  if (!activePersona.allowedSkills) return visible;
  const owned = visible.filter(s => s.personaId === activePersona.id);
  const globals = visible.filter(s => !s.personaId);
  const set = new Set(
    filterByGlobPatterns(
      globals.map(s => s.id),
      activePersona.allowedSkills
    )
  );
  return [...globals.filter(s => set.has(s.id)), ...owned];
}
```

Expose `isSkillVisible` on the capability.
7c. In `skills/index.ts`:

```ts
function getVisibleSkills() {
  const cap = registration.request<{ isSkillVisible(s): boolean }>('persona');
  return getAllSkills().filter(s =>
    cap ? cap.isSkillVisible(s) : !s.personaId
  );
}
function resolveVisibleSkill(id: string) {
  // owner-wins (D7)
  const candidates = getAllSkills().filter(s => s.id === id);
  const cap = registration.request<{
    isSkillVisible(s): boolean;
    getActivePersona(): { id: string } | null;
  }>('persona');
  const visible = candidates.filter(s =>
    cap ? cap.isSkillVisible(s) : !s.personaId
  );
  if (visible.length === 0) return undefined;
  const activeId = cap?.getActivePersona()?.id;
  return (
    visible.find(s => s.personaId && s.personaId === activeId) ??
    visible.find(s => !s.personaId) ??
    visible[0]
  );
}
```

7d. `skillsFragment` uses `getVisibleSkills()` (still routed through `personaCap.getFilteredSkills` for the glob behavior). `skills__recall`, `renderSkillBody` (used by `@skill:`), and `findSkill` switch to `resolveVisibleSkill`. `skills__list` uses `getVisibleSkills()`.
7e. **Operator carve-out (D2):** `skills__list` and `skills__recall` gain an optional `all?: boolean` input ("administrative view — include skills owned by other personas"); the `/skills` slash command passes `all: true` for `list`/`recall`. `getSkillById`/`getSkills` (capability) stay raw.
7f. Update the shared-interface sweep: every mock/implementer of `DronePersonaCapability` (tests included) must add `isSkillVisible`. Use LSP find-references.

### Step 8 — Agent: self-improvement path gating [coder]

Depends: Step 1.
Files: `drone-agent/src/plugins/self-improvement/paths.ts`.

8a. Only take the persona-directory branch when the skill is **local**:

```ts
const skill = skillsCap?.getSkill(targetId);
if (
  skill?.personaId &&
  (skill.source === 'user' || skill.source === 'project')
) {
  /* persona dirs */
}
```

8b. Swarm-owned skills fall through to the normal scope/swarm-engine path (D11).

### Step 9 — drone-migrate: owned-skill support [coder]

Depends: Steps 1, 3.
Files: `drone-agent/src/runtime/migration/{paths,types,listing,promote,demote,public-api}.ts`.

9a. `paths.ts`: add `getPersonaSkillFilePath(scope, personaId, skillId)` → `<base>/.drone-agent/personas/<personaId>/skills/<skillId>.md`.
9b. `types.ts`: `AssetInfo` gains `personaId?: string`.
9c. `listing.ts`: `listLocalSkills` also walks each `<personas-dir>/<id>/skills/` subdir, tagging `personaId`.
9d. `promote.ts`: include `personaId` in the skill payload; read the nested path when owner is set.
9e. `demote.ts`: write to the nested path when `data.personaId` is present.
9f. `public-api.ts`: `listAllAssets`/`batchMigrate` pass owners through.

### Step 10 — Coordinator UI [coder]

Depends: Step 4.
Files: `drone-coordinator-ui/src/lib/types.ts`, `src/pages/persona-detail.tsx`, new `src/pages/persona-skill-editor.tsx`, `src/pages/skills.tsx`, `src/App.tsx`.

10a. `types.ts`: `Skill` gains `personaId: string | null`; `CreateSkillRequest` gains `personaId?: string | null`.
10b. `persona-detail.tsx`: new **Owned Skills** card. Fetch `GET /api/personas/:id/skills`; list name/description/trigger; per-row Edit + Delete; an **Add Skill** button. Use `ErrorBanner` + `useToast` for failures (match the existing error-display conventions).
10c. New `persona-skill-editor.tsx`: create/edit form (name, id, description, trigger, body) — **no scope field** (D12). Create → `POST /api/personas/:id/skills`; edit → `PUT /api/personas/:id/skills/:skillId`.
10d. `App.tsx`: add `/personas/:id/skills/new` and `/personas/:id/skills/:skillId/edit`.
10e. `skills.tsx`: show an owner badge and link to the persona page when `personaId` is set.

### Step 11 — Tests [tester]

Depends: all above. Files: `drone-beacon/test/*`, `drone-coordinator/test/*`, `drone-agent/test/*`, `drone-coordinator-ui` tests.

Cover at minimum:

- schema migration from the legacy flat table (rows preserved, `key===id`, `personaId` null);
- cascade delete of owned skills on persona delete (both servers);
- reconcile sweep (owned rows dropped when the owner disappears; safe on empty fetch);
- composite keying (two personas owning same-named skills both survive; no overwrite);
- isolation: fragment/`skills__list`/`skills__recall`/`@skill:` hide a foreign owned skill; owner sees it (owner-wins over a same-id global); no persona ⇒ owned hidden;
- operator carve-out: `/skills list` still shows everything;
- beacon→coordinator push suppressed for owned skills; personaId survives push/fetch/upsert;
- migrate tool: nested listing + promote/demote round-trip with owner preserved;
- self-improvement: local owned skill keeps persona-dir paths; swarm owned skill does not.

### Step 12 — Docs & memory hygiene [coder]

Depends: Step 11.

- Update `AGENTS.md`/`docs/agents/` where they describe skills ownership if behavior changed.
- Add an ADR in the project wiki (`decisions/226-persona-owned-skills-swarm-scope.md`) recording D1–D13.
- Commit `.drone-agent` memory/skills/insights with the change (per AGENTS.md) — but not to `main`.

### Step 13 — Final verification [review]

**MUST** re-check the whole work against §4 below. Do not mark done until every item passes.

## 4. Validation Criteria

1. `pnpm -r run build` passes with zero errors (run after Step 1's drone-core change — dependent packages resolve `dist/`).
2. LSP diagnostics are clean workspace-wide (no errors, no warnings).
3. `pnpm -r run lint` passes with zero errors.
4. `pnpm -r run test` (fast suite) passes; new tests from Step 11 included.
5. **Isolation, empirically:** with persona A active, `skills__list` does not contain a skill owned by persona B; `skills__recall <B's owned id>` fails; `@skill:<B's owned id>` reports `[unknown skill: …]`; the `# Skills` fragment omits it. Activating B makes it visible to B.
6. **Owner-wins:** with a global `deploy` and an owned `deploy` (same id), A's recall returns A's body; a persona-less session returns the global body.
7. **No-persona:** a persona-less session lists only globals.
8. **Cascade:** deleting a persona removes its owned skills on that server; after a sync cycle, beacons no longer serve a coordinator persona's orphaned owned skills.
9. **No leakage:** creating an owned skill on a beacon-local persona does not result in a coordinator-scoped skill on the coordinator.
10. **Seeded state intact:** `memory-wiki` remains global and visible to all personas (D8).
11. **UI:** the persona page lists owned skills; Add/Edit/Remove work end-to-end; the editor has no scope control.
12. **Migration:** an existing DB upgrades in place with all global skills intact and addressable by their original ids.
13. **Migrate tool:** `drone-migrate --list` shows persona-owned skills; promote/demote preserves the owner.
14. `pnpm -r run lint` was run last (prettier reformats) and the working tree still builds/tests green afterwards.
