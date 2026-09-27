---
key: planning-seed-agent-authored-persona-owned-skills
tags:
  []
created: 2026-09-27T00:34:10.003Z
updated: 2026-09-27T00:34:10.003Z
---

# Planning seed (DEFERRED): agent-side authoring of persona-owned skills

**Status:** deferred by decision D5 of `plan-persona-owned-skills-swarm-scope` (2026-09-26). Not in scope there.

## What was deferred
Option C of the authoring question: give the **agent** a way to author *persona-owned* skills, alongside the
coordinator-UI path that the main plan delivers. Today the agent has no such path:
- `drone-agent/src/plugins/skills/wizard.ts` (`skills__create`) picks a `DroneSkillWriter` from
  `skillsCap.getWriters()` — writers are registered only by `skill-provider-{project,user}` and by the swarm
  plugin (`swarm/providers.ts`: beacon + coordinator). There is **no persona-owned writer**, so the wizard
  cannot target a persona.
- `drone-agent/src/plugins/persona/wizard.ts` (`persona__create`) selects a `DronePersonaWriter` and never
  touches skills.

## Why it was deferred
It needs: (a) a persona picker in the TUI elicitation flow, (b) a new `DroneSkillWriter` whose `scope` is not a
simple enum value (it must encode *owner + scope*), (c) plumbing so `askScope`/`insertWriterSorted`
(scope order project=0, user=1, beacon=2, coordinator=3) can express "owned by persona X at scope Y", and
(d) write paths for the nested layout at local scopes plus the persona-scoped HTTP routes at swarm scope
(the latter land in the main plan as `POST /personas/:id/skills`).

## Seeds for the eventual design
1. Reuse the main plan's composite-key helper `skillStorageKey(personaId, id)` from `drone-core`.
2. Model writers as `{ id, scope, ownerPersonaId?, label, exists, writeSkill }` — or add a parallel
   `getOwnedWriters(personaId)` registry so `getWriters()` keeps its current contract (it is consumed by
   `askScope` in the wizard and by `/skills create`).
3. At swarm scope the writer POSTs to `POST {beacon}/personas/:id/skills` (the main plan's route); at local
   scope it writes `personas/<id>/skills/<skillId>.md`.
4. The wizard's existence check + overwrite prompts must key on the composite identity (two personas may each
   own `deploy`).
5. Consider also letting the persona wizard optionally prompt "does this persona own any skills?" and
   pre-creating the `skills/` directory.
6. `skills__list`/`skills__recall` must honour the `all` operator flag added in the main plan (Step 7e).

## Related
- `plan-persona-owned-skills-swarm-scope` (the parent plan).
- Wiki: `drone-agent-persona-owned-skills-as-is-2026-09-27`, `drone-agent-skills-broker-architecture`.
