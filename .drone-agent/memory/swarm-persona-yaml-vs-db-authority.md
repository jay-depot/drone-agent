---
key: swarm-persona-yaml-vs-db-authority
tags:
  - persona
  - swarm
  - beacon
  - coordinator
  - data-flow
  - reference
created: 2026-10-05T15:26:34.787Z
updated: 2026-10-05T15:26:34.787Z
---

Swarm-scope persona: which source is authoritative at runtime (verified 2026-10-05 against code).

Write path: the persona wizard (drone-agent/src/plugins/persona/wizard.ts:377) calls writer.writePersona(id, candidateText) with the RAW .md text (YAML frontmatter + body). Both swarm writers (drone-agent/src/plugins/swarm/providers.ts:127-146 beacon, :148-183 coordinator) POST { id, name: id, description: '', systemPrompt: content } to `${baseUrl}/personas`. So the DB `systemPrompt` column holds the entire .md file; the DB `name`/`description` columns are written empty/id.

Read path: reloadFromBeacon (providers.ts:44) fetches GET /personas and for each row calls parsePersonaMd(p.id, p.systemPrompt) (providers.ts:57). That is the KEY fact:

- Rich fields (systemPromptOverride, promptFragments, uiColor, allowedTools, allowedSkills, toolCallLimit, premountedTools) => authoritative source is the YAML frontmatter/body embedded in the DB `systemPrompt` column. They are re-parsed on every reload.
- `scope` => authoritative source is the DB column, NOT the YAML. providers.ts:59 explicitly overrides definition.scope = p.scope==='coordinator' ? 'coordinator' : 'beacon' with the comment "Preserve the scope from the DB, not from the .md frontmatter". Beacon route hardcodes scope ('coordinator' if body.scope==='coordinator' else 'local') (drone-beacon/src/routes/personas.ts:12-14); coordinator createPersona hardcodes 'coordinator' (drone-coordinator/src/db/personas.ts:12). Beacon fetchPersonas marks all as scope:'coordinator' (coordinator-client.ts:521-522); triggerCoordinatorSync upserts them via upsertPersonaFromCoordinator (drone-beacon/src/routes/context.ts:202).
- `id` => DB column (map key).
- DB `name`/`description` columns => NOT authoritative at runtime; never read back. parsePersonaMd derives name/description from the YAML (defaulting to id / `Persona: ${id}` when absent).

The DB `Persona` type (drone-core/src/domain-types.ts:7-15) is flat { id, name, description, systemPrompt, scope, createdAt, updatedAt }; the runtime DronePersonaDefinition is the rich parsed form.

STALE WIKI WARNING: the coordinator wiki page `drone-agent-swarm-persona-provider-data-flow-analysis` (snapshot 2026-07-01) claims discrepancies #1 ("systemPrompt never mapped to systemPromptOverride") and #4 ("No .md parsing on read-back") and #5 ("both writers hit the same beacon URL asynchronously"). All three are now FIXED: read-back DOES run parsePersonaMd (so systemPrompt body flows into systemPromptOverride), and providers.ts:57 has an explicit "Parse the .md content to extract all rich fields" comment. Discard those claims; trust the code.
