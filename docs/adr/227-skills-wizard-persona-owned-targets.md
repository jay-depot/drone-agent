---
tags: [decision, skills, persona, wizard, authoring, adr]
related: [concepts/broker-provider.md, concepts/identity-assets.md, entities/Skill.md, modules/drone-core.md, modules/drone-agent-plugins.md, modules/drone-beacon.md, decisions/226-persona-owned-skills-swarm-scope.md]
---

# 227 — Persona-owned skill targets in the skills-creation wizard

**Status**: Implemented · **Branch**: `feat/swarm-persona-owned-skills` · **Plan**: project-memory `plan-skills-wizard-persona-owned-targets` · **Companion**: [[decisions/226-persona-owned-skills-swarm-scope]]

**Summary**: The skills-creation wizard (`skills__create`, shared by the `skills__create` tool, `/skills create`, and
`--workflow skills.create`) can now author **persona-owned** skills, not just global ones. A parallel
`DroneOwnedSkillWriter` registry (a writer per scope that takes the *owner* as an argument) lets the wizard bind
an owner to a writer at runtime; the picker is **owner-first** with `No owner (global skill)` as the default
row; when an owner is chosen the storage scope is **derived from the owner** ([[decisions/226-persona-owned-skills-swarm-scope]]
D4) and never asked.

## Why

[[decisions/226-persona-owned-skills-swarm-scope]] delivered persona-owned skills at every scope plus full
coordinator-UI CRUD, but explicitly **deferred the agent-side authoring path** (its decision D5). The wizard
could only target global skills: it picked a `DroneSkillWriter` from `skillsCap.getWriters()` and asked for a
storage scope, and no persona-owned writer existed, so there was no way to author a skill owned by a persona
from the agent. This ADR closes that gap for the *create* flow.

A follow-up seed (`planning-seed-skills-management-tools`, in project memory) captures the deferred *management*
surface (`update`/`delete`/`move`/`rename`) and the eventual **unified authoring-target registry** refactor,
which both features are expected to converge on.

## Locked design decisions (9)

1. **All four scopes** — `project`, `user`, `beacon`, `coordinator`. One owned writer per scope.
2. **Parallel owned-writer registry, not a widened `DroneSkillWriter`.** A new `DroneOwnedSkillWriter` type takes
   the owner as a method argument (`labelFor(personaId)`, `exists(personaId, id)`, `writeSkill(personaId, id, content)`),
   registered once per scope via new `registerOwnedWriter`/`unregisterOwnedWriter`/`getOwnedWriters` on
   `DroneSkillsCapability`. `getWriters()` is **untouched**, so the existing wizard path and its tests are
   unaffected. This survives persona reloads without re-registration churn and lets the wizard bind a
   `(personaId, writer)` pair back to a plain `DroneSkillWriter` at runtime. The *unified authoring-target
   registry* (where the broker composes writers + personas into resolved targets) is the acknowledged eventual
   direction, deliberately deferred.
3. **Owner-first picker.** Question 1 = each eligible persona plus `No owner (global skill)`, with **no-owner as
   the default and first row**. No owner → the existing storage-scope question over the global writers
   (byte-identical to today). Owner → scope derived, never asked. Eligibility = personas whose `scope` has a
   registered owned writer. When no owned writers are registered the owner question is **omitted entirely**, so
   today's flow is unchanged.
4. **Symmetric beacon proxy pair.** The coordinator-owned case rides two new beacon routes,
   `GET` and `POST /coordinator/personas/:id/skills`, plus `CoordinatorClient.getOwnedSkills`/`createOwnedSkill`.
   The `POST` **upserts the created row into the beacon's local skills table** (`upsertSkillFromCoordinator`,
   the same path the periodic sync uses) to close the coordinator-sync lag, so a coordinator-owned write is
   visible on the beacon immediately. Coordinator-owned `exists` = the `GET` proxy + id filter; beacon-owned
   `exists` = the beacon's own `GET /personas/:id/skills`.
5. **Local owned writers live in `persona-provider-{project,user}`.** Each already knows its `personaDir`,
   already registers the aggregated owned-skill provider, and already owns the `reloadPersonas()`↔owned-skills
   coupling. `exists` is a file `access` on `personas/<id>/skills/<id>.md`.
6. **`personaId?` input.** Added to the wizard `inputSchema`. Precedence **owner > scope > ask**: a supplied
   `personaId` skips the owner question (`scope` ignored); a scope-only input goes straight to the global path
   for that scope; otherwise the owner question is asked. An unresolvable `personaId` **throws**. `personaId`
   is added to the `toolResult`.
7. **Owned-write refresh.** After an owned write the wizard calls `personaCap.reloadPersonas()` **and**
   `skillsCap.reloadSkills()` (errors swallowed as today; persona reload first so the owned-skill provider
   re-registers). The kickMessage is **conditional**: if the owner is not the active persona it says the skill
   is owned by X and to switch with `/persona select X` (an owned skill is invisible to the current session
   unless its owner is active); if the owner is active it says the skill is available now.
8. **Full test sweep** — wizard tests, the one broken full-literal `DroneSkillsCapability` mock,
   per-provider owned-writer tests, both new beacon proxy routes, the two client methods, the proxy-upsert, and
   broker `getOwnedWriters` ordering.
9. **New seed** `planning-seed-skills-management-tools` for the management surface + the unified-registry pointer.

## Implementation

- `drone-core/src/provider-types.ts` — **new** `DroneOwnedSkillWriter` type (re-exported from `index.ts`).
- `drone-core/src/capabilities.ts` — `DroneSkillsCapability` gains `registerOwnedWriter` /
  `unregisterOwnedWriter` / `getOwnedWriters` (the existing `registerWriter`/`getWriters` set is unchanged).
- `drone-agent/src/plugins/skills/index.ts` — parallel `ownedWriters` registry, sorted by scope via
  `insertWriterSorted`; the three new capability methods.
- `drone-agent/src/plugins/persona-provider-{project,user}/index.ts` — an owned writer per plugin writing
  `personas/<id>/skills/<id>.md` (file-`access` existence check), registered with the skills broker.
- `drone-agent/src/plugins/swarm/providers.ts` — `beacon`- and `coordinator`-owned writers (the latter calls the
  beacon's `/coordinator/personas/:id/skills` proxy).
- `drone-beacon/src/routes/coordinator.ts` — the `GET`/`POST /coordinator/personas/:id/skills` proxy routes.
- `drone-beacon/src/coordinator-client.ts` — `getOwnedSkills`/`createOwnedSkill` on the typed client (the
  `POST` upserts locally via `upsertSkillFromCoordinator`).
- `drone-agent/src/plugins/skills/wizard.ts` — `bindOwnedWriter` + `askOwnerThenScope`; the `personaId` input;
  owner>scope>ask resolution; the persona-then-skills reload; `personaId` in `toolResult`; the conditional
  kickMessage.

## Verification

LSP clean; `pnpm -r run build` / root `pnpm typecheck` / `pnpm lint` all green; root `pnpm test`
**3317 passed / 14 skipped / 0 failed**. New tests: wizard (24, incl. owner picker, `personaId` fast path,
unresolvable-`personaId` throw, composite-key overwrite, conditional kickMessage, reload ordering),
`owned-skill-writers` (broker ordering/unregister + provider read-back), beacon proxy routes (24) and beacon
client (41); one full-literal `DroneSkillsCapability` mock repaired.

**En-route notes** (recorded as insights): the repo-root `pnpm typecheck` also runs
`tsc -p tsconfig.test.json`, which type-checks test files the per-package `tsc -b` skips — it caught a real
type error in the new wizard tests (inline `ask` closures inferred a union with `undefined` optionals not
assignable to `DroneElicitationAnswers`) that the package build missed. And parallel `file__apply_diff` calls
that target the **same** file race and can corrupt it (one truncated `skills/index.ts`, restored from git).

## Related

- [[decisions/226-persona-owned-skills-swarm-scope]] — the ownership/isolation/composite-keying groundwork this builds on
- [[concepts/broker-provider]] — the writer registry this extends
- [[entities/Skill]] — skill creation surfaces
- [[concepts/identity-assets]] — persona/skill ownership model
