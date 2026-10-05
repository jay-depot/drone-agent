---
key: plan-persona-metadata-derivation
tags:
  - plan
  - persona
  - swarm
  - beacon
  - coordinator
  - coordinator-ui
  - drone-swarm-common
  - drone-core
  - frontmatter
created: 2026-10-05T15:59:24.050Z
updated: 2026-10-05T15:59:24.050Z
---

# Plan: derive persona DB metadata (name/description) from systemPrompt frontmatter

## Why

Swarm-scope personas persist the whole `.md` file (YAML frontmatter + body) into the SQLite `systemPrompt` column. The runtime re-parses that column on read-back (`drone-agent/src/plugins/swarm/providers.ts:57`), so rich fields survive. But the DB `name`/`description` columns are written as junk by the wizard/LLM-tool write path (`name = <id>`, `description = ''`) and the coordinator UI (list, search, detail) reads those columns directly — so swarm personas appear nameless and description-less in the web UI.

**Fix:** the `.md` frontmatter is the source of truth for `name`/`description`; the DB columns become a derived projection populated at write time. The UI editor stops asking for them.

Precedent: commit `6c6d350` already fixed the read-back side by parsing on read (ADR origin page: `drone-agent-swarm-persona-contents-system-prompt-injection-fix-origin`). This plan fixes the write side + the inert columns.

## Locked decisions

1. **Model A** — `.md` frontmatter is the single source of truth for `name`/`description`; DB columns are derived (write-time only, for UI/listing).
2. **`name` == id** (slug) for now. Human-readable names are a deliberate future possibility, out of scope.
3. Derivation is **server-side** (not the wizard client).
4. Derivation rule **mirrors the runtime loader exactly**: `name = frontmatter.name ?? id`; `description = frontmatter.description ?? \`Persona: ${id}\``. If the `description:` key is present but empty, `description = ''` (matches `loader.ts`). No-frontmatter/plain body → `name = id`, `description = \`Persona: ${id}\``.
5. Chokepoint = **DB layer**: derive inside `createPersona`, `updatePersona`, **and** `upsertPersonaFromCoordinator` in BOTH `drone-beacon/src/db/personas.ts` and `drone-coordinator/src/db/personas.ts`. Covers routes + `seedDefaultAssets` + coordinator sync.
6. Those writers **ignore** client-supplied `name`/`description`. `CreatePersonaRequest.name`/`description` become **optional** in `drone-core`; the swarm writers stop sending junk.
7. **Startup backfill** (idempotent) repairs legacy rows; it does **not** bump `updatedAt`.
8. **Edit page** keeps the `id` field (create mode: user types the id directly, no auto-slug-from-name; edit mode: keep it visible+disabled as today); **remove** the `name` and `description` inputs.

## Architecture notes / verified facts

- Wizard write: `drone-agent/src/plugins/persona/wizard.ts:377` → `writer.writePersona(id, candidateText)` (raw `.md` only).
- Swarm writers: `drone-agent/src/plugins/swarm/providers.ts:139-147` (beacon) and `:170-183` (coordinator) POST `{ id, name: id, description: '', systemPrompt: content }` to `${baseUrl}/personas`.
- Runtime read-back: `providers.ts:57` `parsePersonaMd(p.id, p.systemPrompt)`; scope taken from DB at `:59`.
- Beacon routes: `drone-beacon/src/routes/personas.ts` POST `/personas` (scope = body `'coordinator'` else `'local'`), PUT `/personas/:id`, DELETE `/personas/:id`.
- Coordinator routes: `drone-coordinator/src/routes/personas.ts` POST `/personas`, PUT `/personas/:id`, DELETE `/personas/:id`.
- Runtime parser (`drone-agent/src/plugins/persona/loader.ts`): frontmatter regex `/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/`; key regex `/^(\s*)([\w-]+):\s*(.*)$/`; strips surrounding `'…'` and `"…"`; `name` initialised to `id`, `description` to `` `Persona: ${id}` ``; indented keys after `premountedTools:` are plugin ids (skip).
- Beacon/coordinator `personas` table: `name TEXT NOT NULL`, `description TEXT NOT NULL`.
- Startup: beacon `src/index.ts:263` `initDatabase(config.dbPath)`; coordinator `src/index.ts:583` `initDatabase(...)` + `:584` `seedDefaults()`.
- `drone-swarm-common` already depended on by both servers; its private `parseFrontmatter` in `wiki-storage.ts:29` has a DIFFERENT contract (requires `\n` after closing fence, strips only double quotes, inline `[...]` lists) — do NOT reuse or alter it.
- UI: `drone-coordinator-ui/src/pages/persona-editor.tsx` (fields name/id/description/scope/systemPrompt), `personas.tsx` (list shows+searches name+description), `persona-detail.tsx` (shows name+description). Types in `drone-coordinator-ui/src/lib/types.ts`.
- Dependency direction: `drone-core` and `drone-swarm-common` are dist-resolved by dependents, so rebuild them before relying on LSP/typecheck downstream.

## Steps (each atomic; recommended order)

### Step 1 — shared helper (drone-swarm-common) [agent: coder]

New file `drone-swarm-common/src/persona-metadata.ts`:

```ts
const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;
const stripQuotes = (raw: string) =>
  raw.replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1');

/**
 * Derive persona name/description the same way the runtime loader does:
 * frontmatter `name`/`description`, else `id` / `Persona: ${id}`.
 */
export function derivePersonaMetadata(
  systemPrompt: string,
  id: string
): { name: string; description: string } {
  let name = id;
  let description = `Persona: ${id}`;
  const match = systemPrompt.match(FRONTMATTER_RE);
  if (!match) return { name, description };
  let inPremount = false;
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^(\s*)([\w-]+):\s*(.*)$/);
    if (!kv) continue;
    const [, indent, key, raw] = kv;
    if (inPremount && indent.length > 0) continue; // plugin id inside premountedTools
    inPremount = false;
    if (key === 'premountedTools') {
      if (stripQuotes(raw.trim()) === '') inPremount = true;
      continue;
    }
    if (key === 'name') name = stripQuotes(raw.trim());
    else if (key === 'description') description = stripQuotes(raw.trim());
  }
  return { name, description };
}
```

Add `export * from './persona-metadata.js';` to `drone-swarm-common/src/index.ts`.
Tests: `drone-swarm-common/test/persona-metadata.test.ts` — frontmatter name+desc; missing frontmatter → defaults; empty `description:` → `''`; fence at EOF (`\n?`); single-quoted values; indented/premount keys not misread.

### Step 2 — drone-core type change [agent: coder]

`drone-core/src/domain-types.ts`: make `CreatePersonaRequest.name` and `.description` **optional**:

```ts
export type CreatePersonaRequest = {
  id: string;
  name?: string;
  description?: string;
  systemPrompt: string;
  scope?: 'local' | 'coordinator';
};
```

Run `pnpm -r run build` before touching dependents.

### Step 3 — beacon DB layer [agent: coder]

`drone-beacon/src/db/personas.ts` (import `derivePersonaMetadata` from `drone-swarm-common`):

- `createPersona(req, scope='local')`: replace `name: req.name, description: req.description` with
  `const { name, description } = derivePersonaMetadata(req.systemPrompt, req.id);`
- `updatePersona(id, req)`: compute `const systemPrompt = req.systemPrompt ?? existing.systemPrompt;` then `const { name, description } = derivePersonaMetadata(systemPrompt, id);` and set `systemPrompt, name, description` on the updated object (after the `...req` spread so they win).
- `upsertPersonaFromCoordinator(p)`: derive from `p.systemPrompt`/`p.id` and run `stmt.run({ ...p, name, description })`.
- Add `backfillPersonaMetadata(): number` — iterate `listPersonas()`, derive, `UPDATE personas SET name=@name, description=@description WHERE id=@id` only when a value differs, return the count. Must NOT touch `updatedAt`.
- Export `backfillPersonaMetadata` from `drone-beacon/src/db/index.ts`.

### Step 4 — coordinator DB layer [agent: coder]

`drone-coordinator/src/db/personas.ts`: same as Step 3 for `createPersona` (scope is hardcoded `'coordinator'`), `updatePersona`, and add/export `backfillPersonaMetadata`. (Coordinator has no `upsertPersonaFromCoordinator`.) Export from `drone-coordinator/src/db/index.ts`.

### Step 5 — startup backfill wiring [agent: coder]

- Beacon `src/index.ts`: after `initDatabase(config.dbPath)` (line ~263):
  ```ts
  const repairedPersonas = backfillPersonaMetadata();
  if (repairedPersonas > 0)
    logger.info(`Persona metadata: backfilled ${repairedPersonas} row(s)`);
  ```
- Coordinator `src/index.ts`: after `seedDefaults()` (line ~584), same block.

### Step 6 — swarm writers stop sending junk [agent: coder]

`drone-agent/src/plugins/swarm/providers.ts`: beacon writer body → `{ id, systemPrompt: content }`; coordinator writer body → `{ id, systemPrompt: content, scope: 'coordinator' }`.

### Step 7 — UI editor [agent: coder]

`drone-coordinator-ui/src/pages/persona-editor.tsx`:

- Remove `name`/`description` state, `handleNameChange`, their inputs, and their `handleSubmit` validations.
- Keep `id` (with the existing "auto-generate from name on create" removed — user types it), `scope`, `systemPrompt`.
- Load effect: drop `setName(p.name)` / `setDescription(p.description)`.
- Submit body → `{ id: personaId.trim(), systemPrompt: systemPrompt.trim(), scope }`.
- `drone-coordinator-ui/src/lib/types.ts`: make `CreatePersonaRequest.name`/`.description` optional (mirror drone-core).
  Leave `personas.tsx` and `persona-detail.tsx` as-is — they display the now-correct derived values.

### Step 8 — tests [agent: tester]

- Update `drone-coordinator/test/db.test.ts` ("should create a persona" name assertion ~:83, update test ~:123/:132) and `drone-beacon/test/db.test.ts` ("should update a persona") to derive-based expectations.
- Add create/update derivation tests (frontmatter present + absent) and `backfillPersonaMetadata` tests (repairs a legacy row, is idempotent, leaves `updatedAt` unchanged) in both packages' db tests.
- Verify existing route/seed/ownership tests still pass (they assert on ids/skills, not name/desc).
- Add/adjust a `persona-editor` UI test asserting Name/Description inputs are gone and the POST body omits them.

### Step 9 — check the work against the Validation Criteria [agent: reviewer]

Run every criterion below; report pass/fail with evidence.

## Validation criteria

- **LSP**: `lsp__get_diagnostics` (workspace, `severity: error`) reports zero errors in all packages. (Rebuild `drone-core` + `drone-swarm-common` first — dependents resolve from `dist/`.)
- **Build**: `pnpm -r run build` — zero errors.
- **Lint**: `pnpm -r run lint` — zero errors (prettier will reformat; re-read files after).
- **Tests**: `pnpm -r run test` — the fast suite green, including new `derivePersonaMetadata`, backfill, and UI-editor tests.
- **Behavioral**:
  1. Wizard create at project/user/beacon/coordinator scope → the DB row has `name` = frontmatter `name` (== id for wizard output) and `description` = the frontmatter description text (NOT empty).
  2. Coordinator UI editor shows only ID / Scope / System Prompt — no Name or Description fields.
  3. Creating a persona via the UI editor with a plain body → row has `name = id`, `description = \`Persona: ${id}\`` (consistent with the runtime).
  4. A legacy row (blank `description`) is corrected on server restart, and its `updatedAt` is unchanged.
  5. Read-back is unaffected: `persona__list` still reports correct `hasOverride` / `fragmentCount` / `uiColor` for swarm personas, and selecting one still injects its brief into `/systemprompt`.
- **Sweep**: confirm no remaining caller relies on client-supplied persona `name`/`description` (grep `createPersona(`/`updatePersona(`/`upsertPersonaFromCoordinator(` and the UI POST body).
