---
key: planning-seed-skills-management-tools
tags:
  - seed
  - skills
  - persona
  - persona-owned-skills
  - tools
  - swarm
created: 2026-10-04T00:00:00.000Z
updated: 2026-10-04T00:00:00.000Z
---

# Planning seed: agent-facing skill-management tools

**Status:** not planned. Split out 2026-10-04 from the ambiguity in the old
`planning-seed-agent-authored-persona-owned-skills` (since deleted). That earlier seed was read two ways —
"agent tools for writing skills" and "the skills wizard gaining persona-owned targets". The _wizard_ half is now
planned (`plan-skills-wizard-persona-owned-targets`); this seed captures the _tool_ half.

## The idea

Today the agent's skill surface is **read + create only**: `skills__list`, `skills__recall`, `skills__reload`,
`skills__create` (a wizard that writes a _skeleton_). There is no tool to **update**, **delete**, **move**, or
**rename** a skill. Give the agent a first-class skill-management tool surface, addressed the same way the
create wizard now is.

## Intended surface

- **`skills__update`** — replace an existing skill's body and/or frontmatter fields (description, recall).
- **`skills__delete`** — remove a skill.
- **`skills__move`** — promote/demote a skill between scopes (project ⇄ user ⇄ beacon ⇄ coordinator), and
  **to/from a persona owner**. This overlaps heavily with the `drone-migrate` tooling — reconcile, do not
  duplicate.
- **`skills__rename`** — change a skill's public id in place (composite-key aware).

## Targeting (must be shared with the create wizard)

The owner-aware targeting model the create plan establishes is the model these tools must reuse:

- Precedence **owner > scope > ask**.
- Owner identity picks the location; the scope is **derived from the owner** (ADR 226 D4) and never asked.
- Unresolvable owner ⇒ throw.
- The registry is `DroneSkillsCapability.getOwnedWriters()` (added by `plan-skills-wizard-persona-owned-targets`),
  plus the plain `getWriters()` for global targets.

## Convergence note (the deferred refactor)

The create plan deliberately stopped at **option (b): a parallel owned-writer registry**. The acknowledged
eventual direction is **option (c): a unified "authoring-target registry"** where the broker composes
writers + personas into resolved targets and consumers stop reasoning about scope at all. These management
tools are the second consumer of that composition logic, so **they are the natural trigger for (c)**. When this
seed is planned, decide explicitly whether to land (c) first (recommended) or copy the (b) binding helper again.

## What exists today (verified 2026-10-04)

- Agent tools: `skills__list`, `skills__recall`, `skills__reload`, `skills__create` — `drone-agent/src/plugins/skills/index.ts`.
- Brokers/capabilities: `DroneSkillsCapability` (`registerWriter`/`getWriters`, plus `registerOwnedWriter`/`getOwnedWriters` after the create plan lands).
- Writable locations: global writers (`skill-provider-{project,user}`, swarm beacon/coordinator HTTP `POST /skills`);
  owned writers (added by the create plan).
- Server routes (already exist, ADR 226): beacon + coordinator `GET`/`POST /personas/:id/skills` and
  `PUT`/`DELETE /personas/:id/skills/:skillId`; global `PUT`/`DELETE /skills/:id`. The beacon proxies _reads_
  and _spawn_ under `/coordinator/*`; the create plan adds the owned-skill `GET`/`POST` proxy pair.
- Migration: `drone-migrate` handles asset promote/demote and (ADR 226 D10) nested persona-owned listing with
  `--persona-id`.

## Open questions (for its own session)

- One tool with a `verb`, or four tools? (Recommend four — clearer schemas, matches `skills__list` naming.)
- Does `delete`/`move` need a confirmation gate for swarm scopes (destructive, swarm-wide)?
- `move` vs `drone-migrate`: which is authoritative? (Recommend the tools delegate to the migration service.)
- Does `update` edit the raw `.md` or a structured field set (body/description/recall)?
- Guardrails: should these be `defaultHidden` (destructive) and opt-in per persona, or open?
- Do the tools honour the `all` operator flag (ADR 226 Step 7e) for cross-persona targets?

## Related

- `plan-skills-wizard-persona-owned-targets` — the create-side plan this seed shares targeting with.
- `plan-persona-owned-skills-swarm-scope` (ADR 226) — ownership, isolation, composite keying.
- Wiki: `drone-agent-skills-broker-architecture`, `drone-agent-persona-owned-skills-swarm-scope-design`.
