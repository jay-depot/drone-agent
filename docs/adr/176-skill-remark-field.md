---
tags: [decision, skills, frontmatter, tui, llm-visibility]
related:
  [
    entities/Skill.md,
    modules/drone-core.md,
    modules/drone-agent-plugins.md,
    concepts/broker-provider.md,
    decisions/161-runtime-enforcement-required-tool-inputs.md,
    decisions/029-dynamic-writer-registration.md,
  ]
---

# 176: Skill `remark` frontmatter field (v1, local-scope)

**Status**: Implemented (2026-08-29, branch `config-library-overhaul`, commit `47b3832`)

## Context

The `config-library/` example setup carries hand-ported skills that credit their original authors in a `remark:` frontmatter field (e.g. `grilling.md`, `grill-with-docs.md`, `domain-modelling.md`: `remark: 'All credit to Matt Pocock. I just ported it.'`). The field's semantics: an **author-facing comment — attribution/license notes — that may be shown to the user but must never reach the LLM**. The rationale is publishing-ethics rather than model context: personal use without credit is very different from publishing a port that way, and the remark is the author's voice traveling with the source file.

Until this ADR, `remark` was dead metadata: `parseSkillMd`'s hardcoded if/else chain reads only `name`/`description`/`recall`/`model-invocation` and silently ignores every other key, so the field never reached `DroneSkillDefinition`.

The real design problem was **where remarks may surface**. Skill payloads serve two audiences at once: `skills__list`'s JSON result feeds both the LLM (as tool result) and the TUI/slash-command rendering. Naively adding the field to the payload leaks author prose into model context as pure noise (attribution doesn't inform recall decisions). The surfaces:

- The **skills prompt fragment** (LLM-facing): renders only `id`/`description`/`recall` — must stay remark-free.
- **`skills__recall`** tool result: its JSON is appended to the session as a synthetic tool result (the recall mechanism itself), so it must stay remark-free.
- **`skills__list`**: dual-audience — the TUI's `SkillsListBlock` and `/skills list` both render _from the tool result_, but the LLM also reads it when it calls the tool.
- `/skills recall`'s confirmation line (`Loaded skill: …`) is human-only logger output.

Additionally, swarm-synced skills (beacon/coordinator providers) flow through the `skills` SQLite table and fixed wire mappings — a new definition field would be silently dropped there (`skill-library`-era skills don't have remarks; the field's first users are all local-scope).

## Decision

**An optional, unadvertised, opt-in input is the visibility gate** (one code path, no duplicated render logic):

1. `DroneSkillDefinition` gains `remark?: string` (drone-core, after `modelInvocation`), documented as author-facing, user-listings-only, never-LLM, local-scope only.
2. `parseSkillMd` reads a single-line `remark:` key with the same quote-stripping as `description`; empty value → `undefined` (absence must not become an empty string).
3. `skills__list` gains an `includeRemark: boolean` input, **default false and deliberately absent from the tool's description string** — the model has no reason to set it (per ADR-161-family convention, `executeTool` schema enforcement is advisory, so an unadvertised optional input is safe to rely on). With `includeRemark === true && s.remark`, the payload spread-adds `remark`.
4. The `/skills list` and `/skills reload` slash commands (human-initiated, host-side) pass `includeRemark: true`; `SkillsListBlock` renders an indented italic `↳ <remark>` line (color `scheme.toolResult` — the color scheme has no dedicated muted field) exactly when the JSON carries it, which by construction is only user-initiated listings.
5. `skills__recall`'s payload is **not** extended — its result is appended to the session for the LLM. The remark surfaces on the `/skills recall` confirmation line instead, via a `getSkillById` lookup: `Loaded skill: <name> (<source>) — <remark>`.
6. The **prompt fragment is untouched** (a negative test pins its remark-freedom via `engine.buildSystemMessages()`), as are the `skills__create` wizard, the persona loader (a separate parser), and all beacon/coordinator/wire types.

**Scope boundary**: v1 is local-scope only — user/project providers carry the full definition, so the field flows for free; swarm propagation is future work ("B phase"), which will also touch persona remark support and stamp a default `Created at [datetime] by create-skill workflow` remark in the wizard.

## Consequence

- Skills can carry author attribution that humans see (lists, recall confirmations) and models never do — enforced by tests, not convention: default `skills__list` payload, `skills__recall` payload, and the rendered prompt fragment are all negative-asserted remark-free in the fast suite.
- Swarm-synced copies of the same skill will not show remarks until the B phase wires `Skill`/`CreateSkillRequest`/beacon+coordinator schema — documented limitation, not a bug.
- Unknown frontmatter keys remain silently ignored, so the parser change is purely additive (the 43 `DroneSkillDefinition` references are all type-annotation usages; nothing broke).

## Key Points

- When a tool-result payload feeds both the LLM and a rendering surface, "user-facing but never LLM-facing" must be implemented as a mechanism. The unadvertised optional input + render-only-if-present pattern achieves strict separation with one code path; prefer it over duplicating render paths.
- Attribution metadata belongs to the source file (authoring time), which is why local-scope v1 matches the actual use case and the swarm/DB layer stays out.
- The config-library copies are the canonical published form; live `~/.drone-agent` copies are working snapshots and may drift (accepted: these are snapshots, not a synchronized clone).

## Validation

LSP clean; `pnpm -r run build` and `pnpm lint` zero errors; fast suite 2398 passed / 0 failed (164 files) including 13 new remark tests across `skills-loader.test.ts` (6), `skills-plugin.test.ts` (+5, incl. prompt-fragment negativity via `buildSystemMessages()` and the slash confirmation line via `engine.dispatchSlashCommand`), and `skills-list-block.test.tsx` (2). Diff review confirmed the non-goals (wizard, persona, swarm/beacon/coordinator) untouched.

## Related

- [Skill](../../drone-core/src/domain-types.ts) — the field on the definition type
- [161-runtime-enforcement-required-tool-inputs](161-runtime-enforcement-required-tool-inputs.md) — why an unadvertised optional input works as a gate
- [029-dynamic-writer-registration](029-dynamic-writer-registration.md) — creation scopes (remark not wired into the wizard in v1)
- identity-assets — personas are near-future remark work
- [drone-core](../../drone-core/), [drone-agent-plugins](../../drone-agent/src/plugins/) — where the field and surfaces live
