---
key: plan-skill-remark-field
tags:
  - skills
  - remark
  - feature-plan
created: 2026-08-29T18:00:51.284Z
updated: 2026-08-29T18:00:51.284Z
---

IMPLEMENTATION PLAN — skill `remark` frontmatter field (v1, local-scope) — branch config-library-overhaul

FEATURE: Make `remark` an officially supported, optional skill frontmatter field: an author-facing comment (attribution/license note, e.g. 'All credit to Matt Pocock. I just ported it.'), possibly shown to the user, NEVER exposed to the LLM. Today the field exists on config-library skills grilling.md/grill-with-docs.md/domain-modelling.md but is silently dropped by parseSkillMd because the frontmatter parser only reads name/description/recall/model-invocation.

DECISIONS (grilled, resolved 2026-08-29): Q1 v1 is local-scope only; beacon/coordinator/wire propagation is "B phase" future work (non-goal). Q2 = option X: skills__list gains optional includeRemark input (default false, NOT advertised in tool description); /skills list passes includeRemark:true; SkillsListBlock renders remark line only when present in the JSON; skills__recall payload stays remark-free (its JSON is appended to the session for the LLM); /skills recall human confirmation line appends remark when present. Q3: skills__create wizard untouched; B-phase note — wizard should stamp default remark "Created at [datetime] by create-skill workflow" when full-pipeline support lands. Q4 skills-only; persona remark is near-future work (rides with B phase, persona/loader.ts parsePersonaMdInternal is a separate parallel parser).

EXPLICIT NON-GOALS: swarm/beacon/coordinator schema + wire types (drone-core domain-types Skill, beacon db/init.ts skills table, swarm/providers.ts mappers + writers, coordinator-ui skills page); skills__create wizard; persona loader/surfaces; macros.

STEPS (agent: coder unless noted; order = dependencies):

STEP 1 (drone-core): In drone-core/src/skill-types.ts add optional field to DroneSkillDefinition after `modelInvocation`:
  /** Author-facing remark (credit/license note). Shown on user-facing listings only; never sent to the LLM. Local-scope only: not propagated by swarm sync. */
  remark?: string;
Optional field → no consumer or test-mock breakage expected; verify with LSP find_references on DroneSkillDefinition (only additive-optional change).

STEP 2 — loader: drone-agent/src/plugins/skills/loader.ts parseSkillMd: add branch mirroring description handling —
  } else if (key === 'remark') {
    definition.remark = value === '' ? undefined : value;
  }
Single-line values only (parser has no multi-line scalar support); value passes through the existing quote-strip (rawValue.replace single/double quotes, loader.ts:73). Update the parseSkillMd docstring format example (loader.ts:9-23) to include a remark: '...' line noting it is author-facing, never LLM-facing.

STEP 3 — plugin surfaces: drone-agent/src/plugins/skills/index.ts
(a) skills__list: extend inputSchema.properties with includeRemark: { type: 'boolean', description: 'Include author remarks in the result.' } — deliberately NOT mentioned in the tool's description string (model should have no reason to set it; runtime input validation is advisory per ADR-161 family). In execute: when building the mapped skill objects, conditionally add remark: ...(input.includeRemark === true && s.remark ? { remark: s.remark } : {}).
(b) /skills list slash command: call ctx.engine.executeTool('skills__list', { includeRemark: true }) instead of ({}) (two call sites: 'list' and 'reload' subcommands — reload is list-with-reload, include remark there too).
(c) /skills recall confirmation: remark is NOT added to the skills__recall tool payload (its JSON is appended to the session for the LLM). Captured skills closure: const skillDef = getSkillById(id inside handler scope); build ctx.logger.info(`Loaded skill: ${skill.name} (${skill.source})${skillDef?.remark ? ` — ${skillDef.remark}` : ''}`).
(d) skills prompt fragment: NO CHANGE — verify it renders only id/description/recall (index.ts:76-87) and does not touch remark.

STEP 4 — TUI: drone-agent/src/tui/components/SkillsListBlock.tsx: in the skills loop add
  const remark = typeof s.remark === 'string' ? s.remark : undefined;
and after the id/desc line push a remark line only when present:
  {`      ↳ ${remark}`} with color={scheme.toolResult} italic — check DroneColorScheme (../theme.js) for a dedicated dim/muted color field first and prefer it; italic prop is supported by Ink Text. Renders nothing when remark absent in JSON, which by construction is all LLM-initiated lists.

STEP 5 — tests (new plan-required tests):
(a) NEW drone-agent/test/skills-loader.test.ts: unit coverage of parseSkillMd via loadSkillsFromDir on a tmpdir — remark parsed; single- and double-quoted remark unquoted; absent remark → undefined (not empty string); remark between recall array items does not corrupt recall parsing (array flush at next kv line, loader.ts:57-64); unknown keys still ignored.
(b) EXTEND drone-agent/test/skills-plugin.test.ts: fixture skill with remark in SKILL_MD family; assert (1) executeTool('skills__list', {}) payload contains NO 'remark' anywhere; (2) executeTool('skills__list', { includeRemark: true }) includes it; (3) skills__recall result JSON contains no 'remark' key; (4) via engine.buildSystemMessages() (pattern: test/systemprompt.test.tsx:83) assert the skills prompt fragment output does not contain the remark text; (5) slash-command handler with mock logger: confirmation line contains ' — <remark>' (mock DroneSlashCommandContext: logger.info capture + engine.executeTool passthrough).
(c) NEW drone-agent/test/skills-list-block.test.tsx: ink-testing-library render of SkillsListBlock with a ToolRenderState whose result JSON has remark → output contains ↳ line; without remark → no ↳ line (pattern: existing TUI tests, poll/assert on rendered frame content; no fixed-tick sleeps per project testing principle).

STEP 6 — reviewer pass: confirm explicit non-goals untouched (wizard.ts, persona/loader.ts, swarm/providers.ts, drone-beacon/src/db/*, drone-core domain-types.ts Skill type, skills prompt fragment). Run LSP find_references on DroneSkillDefinition to confirm no stale-consumer breaks (field is optional-additive). Per project principle: after the Step 1 drone-core edit run `pnpm -r run build` BEFORE trusting LSP diagnostics in dependent packages (they resolve drone-core from built dist/).

VALIDATION CRITERIA (final step of execution):
1. LSP diagnostics: zero new errors/warnings in all touched files and project-wide baseline (pre-existing test/fixtures/docker.ts + lsp-fake-server.ts ChildProcess errors are known-baseline, not new).
2. `pnpm -r run build` passes with zero errors.
3. `pnpm lint` passes (eslint + prettier; re-read files after prettier reformat).
4. `pnpm test` (fast suite) passes, including the new/extended tests above.
5. Negative assertions prove LLM cleanliness: skills prompt fragment, skills__recall payload, and default skills__list payload are remark-free; positive assertions prove user surfaces (/skills list, includeRemark:true, confirmation line, TUI block) render it when present.
6. Diff review confirms no changes under: drone-agent/src/plugins/skills/wizard.ts, drone-agent/src/plugins/persona/, drone-agent/src/plugins/swarm/, drone-beacon/, drone-coordinator/, drone-coordinator-ui/, drone-core/src/domain-types.ts.
7. Commit on config-library-overhaul branch (not main), including any new .drone-agent memory/insight files per project convention.