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
updated: 2026-10-05T16:20:57.270Z
---

Swarm-scope persona: which source is authoritative at runtime (verified 2026-10-05 against code; wiki discrepancy RESOLVED 2026-10-05).

Write path: the persona wizard (drone-agent/src/plugins/persona/wizard.ts:377) calls writer.writePersona(id, candidateText) with the RAW .md text (YAML frontmatter + body). Both swarm writers (drone-agent/src/plugins/swarm/providers.ts, beacon ~:139-148, coordinator ~:170-186) POST { id, systemPrompt: content[, scope:'coordinator'] } to `${baseUrl}/personas`. NOTE (changed 2026-10-05): the writers NO LONGER send name/description; the DB layer derives them. So the DB `systemPrompt` column holds the entire .md file; the DB `name`/`description` columns are now a DERIVED projection from the frontmatter.

Read path: reloadFromBeacon (providers.ts:44) fetches GET /personas and for each row calls parsePersonaMd(p.id, p.systemPrompt) (providers.ts:57). That is the KEY fact:
- Rich fields (systemPromptOverride, promptFragments, uiColor, allowedTools, allowedSkills, toolCallLimit, premountedTools) => authoritative source is the YAML frontmatter/body embedded in the DB `systemPrompt` column. They are re-parsed on every reload.
- `scope` => authoritative source is the DB column, NOT the YAML. providers.ts:59 explicitly overrides definition.scope = p.scope==='coordinator' ? 'coordinator' : 'beacon' with the comment "Preserve the scope from the DB, not from the .md frontmatter". Beacon route reads scope from body ('coordinator' if body.scope==='coordinator' else 'local') (drone-beacon/src/routes/personas.ts:12-14); coordinator createPersona hardcodes 'coordinator' (drone-coordinator/src/db/personas.ts:12). Beacon fetchPersonas marks all as scope:'coordinator' (coordinator-client.ts:~521); triggerCoordinatorSync upserts them via upsertPersonaFromCoordinator (drone-beacon/src/routes/context.ts:202).
- `id` => DB column (map key).
- DB `name`/`description` columns => NOT authoritative at runtime; never read back by the swarm path. As of 2026-10-05 they are DERIVED at the DB layer from the systemPrompt frontmatter (derivePersonaMetadata in drone-swarm-common; name = fm.name ?? id; description = fm.description ?? `Persona: ${id}`). parsePersonaMd derives the runtime name/description from the YAML the same way.
- `name` == id convention: for wizard output, frontmatter name == the id slug. Human-readable names are a possible future change (out of scope).

The DB `Persona` type (drone-core/src/domain-types.ts:7-15) is flat { id, name, description, systemPrompt, scope, createdAt, updatedAt }; the runtime DronePersonaDefinition is the rich parsed form.

WIKI DISCREPANCY — RESOLVED (2026-10-05): the coordinator wiki page `drone-agent-swarm-persona-provider-data-flow-analysis` (originally snapshot 2026-07-01) used to assert 5 "discrepancies" as current. #1 (systemPrompt never mapped), #2 (rich fields lost), #3 (coordinator scope ignored -> stored 'local'), and #4 (no .md parsing on read-back) were ALL fixed by commit 6c6d350 (read-back runs parsePersonaMd; beacon route honors scope). I corrected the wiki page on 2026-10-05: added a correction banner, marked #1-#4 RESOLVED with resolution notes, and noted the 2026-10-05 write-path change. CORRECTION to the prior version of this memory: discrepancy #5 ("both writers POST to the same beacon URL, coordinator relies on async pushPersona") is NOT fixed — it STILL STANDS (by design); the earlier note had wrongly grouped #5 with the fixed items. The fix origin is documented on `drone-agent-swarm-persona-contents-system-prompt-injection-fix-origin`.