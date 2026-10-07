---
tags: [decision, persona, swarm, beacon, coordinator, coordinator-ui, drone-core, drone-swarm-common, frontmatter, adr]
related: [concepts/identity-assets.md, entities/Persona.md, modules/drone-swarm-common.md, modules/drone-core.md, modules/drone-beacon.md, modules/drone-coordinator.md, modules/drone-coordinator-ui.md, modules/drone-agent-plugins.md]
---

# 228 — Derive persona DB metadata (name/description) from systemPrompt frontmatter

**Status**: Implemented (2026-10-05) · **Branch**: `fix/persona-wizard-empty-db-fields` · **Commit**: `54548947` (plan commit `93e88b15`) · **Plan**: project-memory `plan-persona-metadata-derivation` — *deleted from project memory after ingest*

**Summary**: A swarm-scope persona's whole `.md` file (YAML frontmatter + body) is persisted verbatim into the SQLite `systemPrompt` column. The **runtime** re-parses that column on read-back (so all rich fields survive), but the **`name`/`description` columns** — which the coordinator web UI reads and searches *directly* — were being written as junk (`name = <slug-id>`, `description = ''`) by the wizard write path, so swarm personas appeared nameless and description-less in the UI. This change makes the `.md` frontmatter the **source of truth** for `name`/`description` and turns those DB columns into a **derived projection** populated at the store layer: one shared `derivePersonaMetadata()` helper is called inside every persona write, and an idempotent startup backfill repairs legacy rows. The coordinator-UI persona editor stops asking for the two fields.

## Why

Swarm personas are stored as a *single blob*: the wizard (`persona__create`) writes the raw `.md` text and the swarm writers POST it as `systemPrompt`. The runtime (`reloadFromBeacon`) re-parses that blob with `parsePersonaMd()`, so `systemPromptOverride`, `promptFragments`, `uiColor`, `allowedTools`, … all round-trip. But the DB `name`/`description` columns were populated by the writers with `name: id` / `description: ''`, and the coordinator UI (personas list, its search box, the detail page) reads those columns **without** parsing the blob — so every wizard/LLM-authored swarm persona showed up as a bare slug with an empty description.

The two sources had also drifted into inconsistent authority: `scope` is explicitly **DB-authoritative** (`providers.ts` overrides the parsed scope from the DB row), while `name`/`description` were *runtime*-authoritative (via the parse) but DB-authoritative for the UI — a per-field split that depended on who authored the row. This ADR picks one rule for metadata: **the frontmatter wins; the columns mirror it.**

Precedent: the read-back half was already fixed by commit `6c6d350` ([227-skills-wizard-persona-owned-targets](227-skills-wizard-persona-owned-targets.md)'s sibling fix — the swarm plugin's `reloadFromBeacon` began calling `parsePersonaMd()` on the `.md` content and the beacon route began honoring `scope`). This ADR fixes the *write* half and the inert columns.

## Locked design decisions (8)

1. **Model A — frontmatter is the source of truth; the DB columns are a derived projection.** `name`/`description` are (re)computed from the `.md` content at write time so the store can never hold an inconsistent row. The columns exist for listing/search/UI only; they are never read back by the swarm runtime (which parses the blob).
2. **`name` == id (slug) for now.** For wizard output the frontmatter `name` equals the slug id. Human-readable names are a deliberate *future* possibility, explicitly out of scope; this ADR does not change the wizard's name convention.
3. **Derivation is server-side**, not in the wizard client — so *any* writer (wizard, CLI, migration, raw HTTP) produces consistent columns.
4. **The derivation rule mirrors the runtime loader exactly.** `name = frontmatter.name ?? id`; `description = frontmatter.description ?? \`Persona: ${id}\``; if the `description:` key is present but empty, `description = ''`. No-frontmatter/plain-body content yields `name = id`, `description = \`Persona: ${id}\`` — byte-identical to what `_parsePersonaMdInternal` would produce.
5. **The chokepoint is the DB layer.** Derivation happens inside `createPersona`, `updatePersona`, and (beacon) `upsertPersonaFromCoordinator` in **both** `drone-beacon/src/db/personas.ts` and `drone-coordinator/src/db/personas.ts`. This covers the routes, `seedDefaultAssets`, and the coordinator→beacon sync in one place.
6. **Those writers ignore client-supplied `name`/`description`.** `CreatePersonaRequest.name`/`description` become **optional**, and the swarm persona writers stop sending them (they POST `{ id, systemPrompt[, scope] }`).
7. **An idempotent startup backfill repairs legacy rows.** `backfillPersonaMetadata()` re-derives every row, writing only those whose values differ, and leaves `updatedAt` untouched. It runs once at startup in each server.
8. **The edit page drops the redundant fields.** The coordinator-UI persona editor keeps the **ID** field (create mode: the user types the id directly, no auto-slug-from-name; edit mode: visible + disabled as before) and **removes** the Name and Description inputs.

## Implementation

- `drone-swarm-common/src/persona-metadata.ts` — **new**: `derivePersonaMetadata(systemPrompt, id): { name; description }`. Own frontmatter regex `/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/` (allows a closing fence at EOF), single/double-quote stripping, and a `premountedTools`-aware scan that skips the nested plugin-id keys (a plugin id named `name` cannot be mistaken for the persona's name). Deliberately **not** built on `wiki-storage.ts`'s private `parseFrontmatter`, whose contract differs (requires a trailing `\n`, strips only double quotes, inline `[...]` lists). Exported from `drone-swarm-common/src/index.ts`.
- `drone-core/src/domain-types.ts` — `CreatePersonaRequest.name` / `.description` are now **optional** (they are derived, not inputs).
- `drone-beacon/src/db/personas.ts` — `createPersona` and `updatePersona` derive `name`/`description` from the (final, merged) `systemPrompt`; `upsertPersonaFromCoordinator` re-derives from the incoming `systemPrompt`; new `backfillPersonaMetadata(): number` (idempotent, no `updatedAt` bump).
- `drone-coordinator/src/db/personas.ts` — `createPersona` and `updatePersona` derive; new `backfillPersonaMetadata()`. (No `upsertPersonaFromCoordinator` on the coordinator.)
- Both `db/index.ts` barrels export `backfillPersonaMetadata`.
- `drone-beacon/src/index.ts` — runs `backfillPersonaMetadata()` right after `initDatabase(config.dbPath)` (logs the repaired count when > 0).
- `drone-coordinator/src/index.ts` — same, right after `seedDefaults()`.
- `drone-agent/src/plugins/swarm/providers.ts` — the beacon persona writer POSTs `{ id, systemPrompt }` and the coordinator writer `{ id, systemPrompt, scope: 'coordinator' }` (the junk `name`/`description` removed). Skill writers are untouched.
- `drone-coordinator-ui/src/pages/persona-editor.tsx` — Name + Description inputs, their state, and their validations removed; submit sends `{ id, systemPrompt, scope }`; helper copy notes the fields are derived from the frontmatter.
- `drone-coordinator-ui/src/lib/types.ts` — `CreatePersonaRequest.name`/`.description` optional (mirrors drone-core; the web package cannot import drone-core).
- Tests: `drone-swarm-common/test/persona-metadata.test.ts` (new, 7); derivation + backfill cases added to `drone-beacon/test/db.test.ts` and `drone-coordinator/test/db.test.ts`; the persona `PUT` route tests updated (`drone-beacon/test/routes.test.ts`, `drone-coordinator/test/routes/personas.test.ts`); the UI editor test rewritten (3 cases incl. the POST body omitting the fields).

## Validation

LSP clean; `pnpm -r run build` (8 packages), root `pnpm typecheck`, and `pnpm lint` all green; root `pnpm test` **3331 passed / 14 skipped / 0 failed**. Sweep confirmed every persona write path funnels through the deriving DB layer and the UI editor no longer references the fields (only explanatory copy).

## Consequences

- A wizard- or UI-authored swarm persona now lands with `name` = the frontmatter name (== slug) and `description` = the frontmatter description text — the coordinator UI shows real values and its search works.
- A UI-authored persona with a plain body (no frontmatter) is stored with `name = id`, `description = \`Persona: ${id}\`` — consistent with what the runtime derives.
- Legacy rows (blank descriptions from earlier wizard writes) are corrected on the next server restart; `updatedAt` is unchanged, so no false "recently updated" churn.
- `CreatePersonaRequest.name`/`description` are optional and **inert** on the swarm write paths — supplying them has no effect.
- The read-back path is unchanged: `persona__list` still reports correct `hasOverride` / `fragmentCount` / `uiColor`, and selecting a persona still injects its brief into the system prompt.

## Related

- identity-assets — personas as an identity asset; where metadata lives.
- [Persona](../../drone-core/src/domain-types.ts) — the persona `.md` format, including the `name`/`description` fields.
- [drone-swarm-common](../../drone-swarm-common/) — new `persona-metadata.ts` + `derivePersonaMetadata`.
- [drone-core](../../drone-core/) — `CreatePersonaRequest` (name/description now optional).
- [drone-beacon](../../drone-beacon/) — `db/personas.ts` derivation + startup backfill.
- [drone-coordinator](../../drone-coordinator/) — same, coordinator-side.
- [drone-coordinator-ui](../../drone-coordinator-ui/) — persona editor drops the Name/Description fields.
- [drone-agent-plugins](../../drone-agent/src/plugins/) — swarm persona writers stop sending junk metadata.
- [227-skills-wizard-persona-owned-targets](227-skills-wizard-persona-owned-targets.md) — the sibling persona/skills-wizard work; its commit range includes the read-back half (`6c6d350`) this ADR's write half completes.
