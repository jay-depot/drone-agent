---
key: plan-skills-wizard-persona-owned-targets
tags:
  - plan
  - skills
  - persona
  - persona-owned-skills
  - swarm
  - wizard
  - authoring
created: 2026-10-04T00:00:00.000Z
updated: 2026-10-04T00:00:00.000Z
---

# Plan: `skills__create` wizard gains persona-owned skill targets

## Feature summary

The skills-creation wizard (`skills__create`) can currently author **global** skills only. It picks a
`DroneSkillWriter` from `skillsCap.getWriters()` and asks the user for a storage scope
(`project | user | beacon | coordinator`). There is **no persona-owned writer**, so the wizard cannot author a
skill owned by a persona.

This plan adds persona-owned skill authoring to that wizard. A persona-owned skill lives under its owner
(`personas/<personaId>/skills/<skillId>.md` at local scopes; a persona-scoped DB row at swarm scope) and
**inherits the owner's scope** (established by ADR 226, D4). The wizard gains an owner-first picker, a parallel
owned-writer registry, owned writers at all four scopes, and a small symmetric beacon proxy pair so the
coordinator-owned case works through the beacon's trust gate.

**Why.** ADR 226 delivered persona-owned skills at every scope plus coordinator-UI CRUD, but explicitly
deferred the agent-side authoring path (decision D5). This plan closes that gap for the _create_ flow. A
follow-up seed (`planning-seed-skills-management-tools`) captures the _management_ surface
(update/delete/move/rename).

**Not in scope:** agent-facing skill management tools; the persona wizard prompting for owned skills; the
deferred "unified authoring-target registry" refactor (a pointer only; see the seed).

## Locked decisions (do not re-litigate)

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | Offer **all four scopes** (`project`, `user`, `beacon`, `coordinator`).                                                                                                                                                                                                                                                                                                                                                            |
| Q2  | **Parallel owned-writer registry** now: new `DroneOwnedSkillWriter` type + `registerOwnedWriter`/`unregisterOwnedWriter`/`getOwnedWriters` on `DroneSkillsCapability`. `getWriters()` is untouched. The _unified authoring-target registry_ is the acknowledged eventual direction, deliberately deferred.                                                                                                                         |
| Q3  | **Owner-first picker.** Question 1 = eligible personas + `No owner (global skill)`, with **no-owner as the default and first row**. No owner → ask storage scope over global writers (today's flow). Owner → scope is **derived** and never asked. Eligibility = personas whose scope has a registered owned writer. The owner question is omitted entirely when no owned writers are registered (today's flow is byte-identical). |
| Q4  | **Symmetric beacon proxy pair**: add `GET` **and** `POST /coordinator/personas/:id/skills` to the beacon, plus `CoordinatorClient.getOwnedSkills`/`createOwnedSkill`. `createOwnedSkill` upserts the returned row into the beacon's local skills table (closes the coordinator-sync lag). Coordinator-owned `exists` = `GET` proxy + id filter; beacon-owned `exists` = beacon `GET /personas/:id/skills`.                         |
| Q5  | **Local owned writers live in `persona-provider-{project,user}`.** `exists` uses a file `access` on `personas/<id>/skills/<id>.md`.                                                                                                                                                                                                                                                                                                |
| Q6  | **`personaId?`** added to the wizard `inputSchema`. Precedence **owner > scope > ask**. A supplied `personaId` skips the owner question (`scope` ignored); a scope-only input goes straight to the global path for that scope. An unresolvable `personaId` **throws**. `personaId` is added to `toolResult`.                                                                                                                       |
| Q7  | After an owned write: `personaCap.reloadPersonas()` **and** `skillsCap.reloadSkills()` (errors swallowed as today); the Q4 POST proxy closes the coordinator lag. **Conditional kickMessage**: if the owner is not the active persona, say the skill is owned by X and to switch with `/persona select X`.                                                                                                                         |
| Q8  | **Full test sweep**: wizard tests; fix the one broken full-literal capability mock; per-provider owned-writer tests; the two new proxy routes; the client methods; the proxy-upsert; broker `getOwnedWriters` ordering.                                                                                                                                                                                                            |
| Q9  | New seed `planning-seed-skills-management-tools` = full management surface with owner-aware targeting + a pointer to the deferred unified registry.                                                                                                                                                                                                                                                                                |

## Verified facts (as of 2026-10-04, branch `feat/swarm-persona-owned-skills`)

- Wizard: `drone-agent/src/plugins/skills/wizard.ts`. `askScope` selects a writer by
  `writers.find(w => w.scope === inputScope)` and the elicitation choices use `value: w.scope`, so two writers
  can never share a scope today. Overwrite checks call `writer.exists(id)` with the bare id.
- Registered skill writers today: `skill-provider-project` (`scope: 'project'`), `skill-provider-user`
  (`scope: 'user'`), `swarm/providers.ts` `beaconSkillWriter` (`'beacon'`) and `coordinatorSkillWriter`
  (`'coordinator'`). No persona-owned writer.
- Owned-skill loading: `persona-provider-{project,user}/index.ts` call
  `loadPersonaOwnedSkills(personaDir, ids, { source, precedence })` from `persona/owned-skills.ts`, registering a
  `DroneSkillProvider` with id `persona-owned-skills-{project,user}` and precedence
  `PRECEDENCE_PERSONA_{PROJECT=1500,USER=2500}`. Its `reloadSkills` is a **no-op** ("reloaded as part of persona
  reload"). Owned skills are keyed by `skillStorageKey(personaId, id)`.
- `skillStorageKey(personaId, id)` in `drone-core/src/skill-key.ts` returns `<personaId>/<id>` or bare `<id>`.
- `persona.md` lives at `personas/<id>/persona.md`; owned skills at `personas/<id>/skills/<skillId>.md`
  (subdirectory name is the persona id — `loadPersonasFromDir`).
- Every loaded persona carries a `scope`: local loaders stamp `'user'`/`'project'`; the swarm loader
  (`reloadFromBeacon`) stamps `'beacon'`/`'coordinator'` from the row's DB scope.
- Beacon `POST /personas/:id/skills` (`drone-beacon/src/routes/skills.ts`) **derives** the storage scope from the
  owner row (`persona.scope === 'coordinator' ? 'coordinator' : 'local'`), sets `personaId`, and **does not**
  push to the coordinator. `GET /personas/:id/skills` lists the owner's skills.
- Coordinator `POST /personas/:id/skills` (`drone-coordinator/src/routes/skills.ts`) creates a
  **coordinator-scoped** owned row.
- **Neither server has a single-GET for an owned skill**; the global `GET /skills/:id` resolves global rows only
  (`getGlobalSkill`). Owned lookups must list-and-match.
- The beacon's `/coordinator/*` proxy family (`drone-beacon/src/routes/coordinator.ts`) covers reads
  (`/coordinator/personas`, `/coordinator/skills`, `/coordinator/beacons`, `/coordinator/agents/location`) and
  spawn endpoints — but **no owned-skill write**.
- `CoordinatorClient` (`drone-beacon/src/coordinator-client.ts`) is the beacon's single mTLS'd, fingerprint-pinned
  coordinator HTTP client. Proxies must use it (ADR 177 precedent: "a proxy can never drift from how this client
  authenticates").
- `insertWriterSorted` (`drone-core/src/sorted-registry.ts`) orders writers by
  `SCOPE_ORDER = { project: 0, user: 1, beacon: 2, coordinator: 3 }`, unknown → 99.
- Broker: `drone-agent/src/plugins/skills/index.ts` holds `const writers: DroneSkillWriter[]`, offers
  `registerWriter`/`unregisterWriter`/`getWriters`. `skills__recall`/`skills__list` already accept an `all`
  operator flag (ADR 226, Step 7e).
- Broken-by-interface mock: `drone-agent/test/self-improvement/persona-owned-skill-paths.test.ts` defines
  `makeSkillsCap(): DroneSkillsCapability` as a **full object literal** — it must gain the three new methods.
  `drone-agent/test/tui-completion.test.ts` casts through `unknown`, so it is safe.

---

## Implementation steps

Each step is atomic and independently testable. Dependencies are noted as `after: <step>`.

### Step 1 — Add the `DroneOwnedSkillWriter` type (coder)

**File:** `drone-core/src/provider-types.ts` (after `DroneSkillWriter`).

```ts
/**
 * A writer for persona-owned skills. Unlike `DroneSkillWriter`, a single
 * instance serves every owner at its scope: the owner is an argument, and the
 * target location is derived from the owner (the skill inherits the owner's
 * scope). Registered once per scope; safe across persona reloads.
 */
export type DroneOwnedSkillWriter = {
  /** Unique id for this writer (e.g. 'persona-owned-skills-project'). */
  id: string;
  /** The scope whose personas this writer can serve. */
  scope: 'project' | 'user' | 'beacon' | 'coordinator';
  /** Human-readable label for the owner picker for a given persona. */
  labelFor: (personaId: string) => string;
  /** Check whether `personaId` already owns a skill with this id. */
  exists: (personaId: string, id: string) => Promise<boolean>;
  /** Write a skill .md file owned by `personaId`. Returns the location. */
  writeSkill: (
    personaId: string,
    id: string,
    content: string
  ) => Promise<{ filePath: string }>;
};
```

Export it from `drone-core/src/index.ts` alongside `DroneSkillWriter` (line ~196).

**Validation:** `pnpm -r run build` passes.

### Step 2 — Add the owned-writer registry to the skills broker (coder)

**Files:** `drone-core/src/capabilities.ts` (the `DroneSkillsCapability` type, ~line 133) and
`drone-agent/src/plugins/skills/index.ts` (the offered capability, ~line 187).

In `capabilities.ts`, add to `DroneSkillsCapability`:

```ts
  /** Register a persona-owned skill writer. Sorted by precedence (ascending). */
  registerOwnedWriter: (writer: DroneOwnedSkillWriter) => void;
  /** Unregister a persona-owned skill writer by id. */
  unregisterOwnedWriter: (writerId: string) => void;
  /** Get all registered owned-skill writers, sorted by precedence. */
  getOwnedWriters: () => DroneOwnedSkillWriter[];
```

In `skills/index.ts`, add `const ownedWriters: DroneOwnedSkillWriter[] = [];` beside `writers`, and implement the
three methods with `insertWriterSorted` / `removeById` exactly as `registerWriter` et al. do (log the
registration). `getWriters()` is unchanged.

**Validation:** `pnpm -r run build` passes; `pnpm -r run typecheck` passes.

### Step 3 — Sweep every `DroneSkillsCapability` implementer and mock (coder) — after: 2

Use LSP `find_references` on `DroneSkillsCapability` (and a `grep` for the identifier as a belt-and-suspenders
cross-check). Fix every full-object literal. Confirmed sites:

- `drone-agent/test/self-improvement/persona-owned-skill-paths.test.ts` — `makeSkillsCap(): DroneSkillsCapability`
  (adds `registerOwnedWriter: () => {}`, `unregisterOwnedWriter: () => {}`, `getOwnedWriters: () => []`).
- The broker's own `capability` object (step 2).
- `drone-agent/test/tui-completion.test.ts` casts via `unknown` — verify no change is needed.
- Re-run the sweep after any later step that touches the interface.

**Validation:** `pnpm -r run typecheck` and `pnpm -r run build` pass with zero errors.

### Step 4 — Local owned writers in `persona-provider-{project,user}` (coder) — after: 2, 3

**Files:** `drone-agent/src/plugins/persona-provider-project/index.ts`,
`drone-agent/src/plugins/persona-provider-user/index.ts`.

In each, after the persona writer registration, build and register an owned writer that reuses the plugin's
existing `personaDir` and the owned-skill provider id:

```ts
const ownedWriter: DroneOwnedSkillWriter = {
  id: PERSONA_SKILLS_PROVIDER_ID, // 'persona-owned-skills-project'
  scope: 'project', // 'user' in the user provider
  labelFor: (personaId: string) =>
    `Owned by persona "${personaId}" (${relativeSkillsPath})`,
  exists: async (personaId: string, id: string) => {
    const filePath = path.join(personaDir, personaId, SKILLS_DIR, `${id}.md`);
    try {
      await access(filePath, fsConstants.F_OK);
      return true;
    } catch {
      return false;
    }
  },
  writeSkill: async (personaId: string, id: string, content: string) => {
    const skillsDir = path.join(personaDir, personaId, SKILLS_DIR);
    const filePath = path.join(skillsDir, `${id}.md`);
    await mkdir(skillsDir, { recursive: true });
    await writeFile(filePath, content, 'utf-8');
    return { filePath };
  },
};
if (skillsCap) skillsCap.registerOwnedWriter(ownedWriter);
```

The exact file existence check deliberately detects a file that "appeared during the wizard", matching the
existing global local writers. Reuse the module's existing `path`/`access`/`mkdir`/`writeFile`/`fsConstants`
imports; the plugins already define `CONFIG_DIR`/`PERSONA_DIR` — add `const SKILLS_DIR = 'skills';` if absent.

**Validation:** unit test (step 11) writes `personas/<id>/skills/x.md` and reads it back; the file lands in the
expected directory.

### Step 5 — Beacon-owned writer in the swarm plugin (coder) — after: 2, 3

**File:** `drone-agent/src/plugins/swarm/providers.ts` (in `registerSkillProviders`, next to
`beaconSkillWriter`).

```ts
const beaconOwnedSkillWriter: DroneOwnedSkillWriter = {
  id: 'swarm-owned-skill-beacon',
  scope: 'beacon',
  labelFor: personaId =>
    `Owned by persona "${personaId}" (beacon-local, swarm hub)`,
  exists: async (personaId: string, id: string) => {
    try {
      const res = await fetch(
        `${ctx.baseUrl}/personas/${encodeURIComponent(personaId)}/skills`
      );
      if (!res.ok) return false;
      const rows = (await res.json()) as BeaconSkill[];
      return rows.some(s => s.id === id);
    } catch {
      return false;
    }
  },
  writeSkill: async (personaId: string, id: string, content: string) => {
    const res = await fetch(
      `${ctx.baseUrl}/personas/${encodeURIComponent(personaId)}/skills`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id,
          name: id,
          description: '',
          trigger: '',
          body: content,
        }),
      }
    );
    if (!res.ok) {
      throw new Error(`Failed to write owned skill to beacon: ${res.status}`);
    }
    return { filePath: `${ctx.baseUrl}/personas/${personaId}/skills/${id}` };
  },
};
skillsCap.registerOwnedWriter(beaconOwnedSkillWriter);
```

The beacon route derives the storage scope from the owner row; the client never sends it (trust model).

**Validation:** covered by step 12/13 tests plus the wizard fast-path test (step 11).

### Step 6 — Beacon proxy: `GET`/`POST /coordinator/personas/:id/skills` (coder)

**File:** `drone-beacon/src/routes/coordinator.ts`.

Add two routes that delegate to new client methods (following the existing `getCoordinatorClient()` +
`try/catch` → 502 pattern):

```ts
// List a coordinator persona's owned skills
app.get<{ Params: { id: string } }>(
  '/coordinator/personas/:id/skills',
  async (request, reply) => {
    const client = getCoordinatorClient();
    if (!client)
      return reply.code(503).send({ error: 'Coordinator not configured' });
    try {
      return await client.getOwnedSkills(request.params.id);
    } catch (err) {
      return reply.code(502).send({
        error: 'Coordinator error',
        details: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  }
);

// Create a coordinator persona's owned skill
app.post<{ Params: { id: string }; Body: Record<string, unknown> }>(
  '/coordinator/personas/:id/skills',
  async (request, reply) => {
    const client = getCoordinatorClient();
    if (!client)
      return reply.code(503).send({ error: 'Coordinator not configured' });
    const created = await client.createOwnedSkill(
      request.params.id,
      request.body
    );
    if (created === null)
      return reply.code(503).send({ error: 'Coordinator unavailable' });
    return reply.code(201).send(created);
  }
);
```

### Step 7 — `CoordinatorClient.getOwnedSkills` / `createOwnedSkill` (coder) — after: 6

**File:** `drone-beacon/src/coordinator-client.ts`.

Add both to the `CoordinatorClient` interface and implementation, using the existing `coordinatorTrusted()`
guard, `cfetch`, and `Skill` type:

```ts
async getOwnedSkills(personaId: string): Promise<Skill[]> {
  if (!coordinatorTrusted()) return [];
  const res = await cfetch(
    `${baseUrl}/api/personas/${encodeURIComponent(personaId)}/skills`
  );
  if (!res.ok) {
    logger.warn(`Failed to get owned skills: ${res.status}`);
    return [];
  }
  const rows = (await res.json()) as Skill[];
  return rows.map(s => ({ ...s, scope: 'coordinator' as const }));
},

async createOwnedSkill(
  personaId: string,
  body: Record<string, unknown>
): Promise<Skill | null> {
  if (!coordinatorTrusted()) return null;
  const res = await cfetch(
    `${baseUrl}/api/personas/${encodeURIComponent(personaId)}/skills`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  );
  if (!res.ok) {
    logger.warn(`Failed to create owned skill: ${res.status}`);
    return null;
  }
  const created = (await res.json()) as Skill;
  // Close the coordinator-sync lag: make the row visible to the local
  // skill providers immediately (same path the periodic sync uses).
  upsertSkillFromCoordinator({ ...created, scope: 'coordinator' });
  return { ...created, scope: 'coordinator' as const };
},
```

Import `upsertSkillFromCoordinator` from `./db/index.js`.

### Step 8 — Coordinator-owned writer in the swarm plugin (coder) — after: 7

**File:** `drone-agent/src/plugins/swarm/providers.ts`.

```ts
const coordinatorOwnedSkillWriter: DroneOwnedSkillWriter = {
  id: 'swarm-owned-skill-coordinator',
  scope: 'coordinator',
  labelFor: personaId =>
    `Owned by persona "${personaId}" (coordinator, global swarm hub)`,
  exists: async (personaId: string, id: string) => {
    try {
      const res = await fetch(
        `${ctx.baseUrl}/coordinator/personas/${encodeURIComponent(personaId)}/skills`
      );
      if (!res.ok) return false;
      const rows = (await res.json()) as BeaconSkill[];
      return rows.some(s => s.id === id);
    } catch {
      return false;
    }
  },
  writeSkill: async (personaId: string, id: string, content: string) => {
    const res = await fetch(
      `${ctx.baseUrl}/coordinator/personas/${encodeURIComponent(personaId)}/skills`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id,
          name: id,
          description: '',
          trigger: '',
          body: content,
        }),
      }
    );
    if (!res.ok) {
      throw new Error(
        `Failed to write owned skill to coordinator: ${res.status}`
      );
    }
    return {
      filePath: `${ctx.baseUrl}/coordinator/personas/${personaId}/skills/${id}`,
    };
  },
};
skillsCap.registerOwnedWriter(coordinatorOwnedSkillWriter);
```

The agent always calls the **beacon** (`ctx.baseUrl`), which proxies to the coordinator through the trusted
client. Note en route: the pre-existing `coordinatorSkillWriter.exists` hits the beacon URL even for the
coordinator scope — leave it as-is (out of scope) but do not copy it.

### Step 9 — Wizard: owner-first picker + writer binding (coder) — after: 2, 4, 5, 8

**File:** `drone-agent/src/plugins/skills/wizard.ts`.

Add a binding helper so the rest of the wizard keeps using the plain `DroneSkillWriter` shape:

```ts
/** Wrap an owned writer + owner as a plain DroneSkillWriter for the write path. */
function bindOwnedWriter(
  personaId: string,
  writer: DroneOwnedSkillWriter
): DroneSkillWriter {
  return {
    id: writer.id,
    scope: writer.scope,
    label: writer.labelFor(personaId),
    exists: (id: string) => writer.exists(personaId, id),
    writeSkill: (id: string, content: string) =>
      writer.writeSkill(personaId, id, content),
  };
}
```

Resolve the target in `run` (replacing the single `askScope` call):

```ts
const personaCap = ctx.requestCapability<DronePersonaCapability>('persona');
const ownedWriters = skillsCap.getOwnedWriters();

let writer: DroneSkillWriter;
let ownerPersonaId: string | undefined;

if (typeof input.personaId === 'string' && input.personaId.trim().length > 0) {
  // Fast path: owner supplied. Scope is derived from the owner.
  const personaId = input.personaId.trim().toLowerCase();
  const persona = personaCap?.getPersonas().find(p => p.id === personaId);
  const scope = persona?.scope;
  const ownedWriter = scope
    ? ownedWriters.find(w => w.scope === scope)
    : undefined;
  if (!persona || !ownedWriter) {
    throw new Error(
      `Cannot author a skill owned by persona "${personaId}": the persona is not loaded, or no owned-skill writer serves its scope.`
    );
  }
  ownerPersonaId = persona.id;
  writer = bindOwnedWriter(persona.id, ownedWriter);
} else if (input.scope) {
  // Global path for the requested scope.
  const match = writers.find(w => w.scope === input.scope);
  if (!match) {
    throw new Error(/* same wording as today's no-writer error */);
  }
  writer = match;
} else {
  // Owner-first question (omitted entirely when no owned writers).
  ({ writer, ownerPersonaId } = await askOwnerThenScope(
    ctx.elicit,
    writers,
    ownedWriters,
    personaCap
  ));
}
```

`askOwnerThenScope` (new, replaces `askScope`):

```ts
async function askOwnerThenScope(
  elicit: DroneElicitation,
  writers: DroneSkillWriter[],
  ownedWriters: DroneOwnedSkillWriter[],
  personaCap: DronePersonaCapability | undefined
): Promise<{ writer: DroneSkillWriter; ownerPersonaId?: string }> {
  if (ownedWriters.length === 0) {
    // No personas to own a skill: today's exact single scope question.
    return { writer: await askScope(elicit, undefined, writers) };
  }
  const servableScopes = new Set(ownedWriters.map(w => w.scope));
  const personas = (personaCap?.getPersonas() ?? []).filter(
    p => p.scope && servableScopes.has(p.scope)
  );
  const answers = await elicit.ask([
    {
      id: 'owner',
      prompt: 'Who should own this skill?',
      choices: [
        { value: '', label: 'No owner (global skill)' },
        ...personas.map(p => {
          const w = ownedWriters.find(ow => ow.scope === p.scope)!;
          return { value: p.id, label: w.labelFor(p.id) };
        }),
      ],
      defaultValue: '',
    },
  ]);
  const ownerId = answers.owner ?? '';
  if (ownerId.length === 0) {
    return { writer: await askScope(elicit, undefined, writers) };
  }
  const persona = personas.find(p => p.id === ownerId)!;
  const ownedWriter = ownedWriters.find(w => w.scope === persona.scope)!;
  return {
    writer: bindOwnedWriter(persona.id, ownedWriter),
    ownerPersonaId: persona.id,
  };
}
```

Import `DroneOwnedSkillWriter` and `DronePersonaCapability` from `drone-core`. `askScope` stays unchanged for
the no-owner path and the `input.scope` path.

**Invariants to preserve:** when `ownedWriters.length === 0` and no `personaId`/`scope` input, the wizard asks
exactly one question with today's choices and default — the existing tests must pass unmodified.

### Step 10 — Wizard: inputSchema, reload, toolResult, kickMessage (coder) — after: 9

**Same file.**

1. **inputSchema** — add (keep `additionalProperties: false`):

```ts
      personaId: {
        type: 'string',
        description:
          'Optional — author a skill owned by this persona. Scope is derived from the owner; `scope` is ignored. The wizard skips the owner question.',
      },
```

2. **Reload** — after the successful write, replace the current single `reloadSkills()` call with:

```ts
try {
  await personaCap?.reloadPersonas();
} catch (err) {
  logger.warn(`reloadPersonas after write failed: ${toMsg(err)}`);
}
try {
  await skillsCap.reloadSkills();
} catch (err) {
  logger.warn(`reloadSkills after write failed: ${toMsg(err)}`);
}
```

(`personaCap?.reloadPersonas()` must run **before** `reloadSkills()` so the owned-skill provider re-registers.)

3. **toolResult** — add `personaId: ownerPersonaId ?? null` (and keep `scope: writer.scope`).

4. **kickMessage** — make it conditional on the owner:

```ts
const ownerNote = ownerPersonaId
  ? ownerPersonaId === personaCap?.getActivePersona()?.id
    ? `It is owned by the active persona "${ownerPersonaId}" and is available now.`
    : `It is owned by persona "${ownerPersonaId}" and is NOT visible to this session. ` +
      `Switch with \`/persona select ${ownerPersonaId}\` to use it.`
  : '';
```

Append `ownerNote` to the existing kickMessage text for the owned case; the global wording is unchanged.

**Validation:** the wizard's happy path, fast path, and conditional wording are covered by step 11.

### Step 11 — Wizard unit tests (tester) — after: 10

**File:** `drone-agent/test/skills-wizard.test.ts` (extend). Extend `makeContext` so the `skills` capability can
also carry `getOwnedWriters`, and add a `persona` capability to the map. Add:

- **owner picker, global path** — `getOwnedWriters` returns one entry; scripted elicitation answers
  `{ owner: '' , scope: 'project' }`; asserts the file lands at `.drone-agent/skills/<id>.md`.
- **owner picker, owned path** — answers `{ owner: 'alice' }`; asserts the owned writer's `writeSkill` was called
  with `('alice', id, content)` (fake writer records the call), and `toolResult.personaId === 'alice'`.
- **no owned writers → single question** — `getOwnedWriters: () => []`; assert exactly today's scope question
  is asked (scripted elicitation with one answer) and no `owner` question.
- **`personaId` fast path** — no owner question is asked; owner `alice` with scope `project` binds the right
  writer; `toolResult.personaId === 'alice'`.
- **unresolvable `personaId` throws** — e.g. persona not loaded, or its scope has no owned writer.
- **composite overwrite** — the owned writer's `exists` returns true; scripted `{ overwrite: 'yes' }` rewrites;
  `{ overwrite: 'no' }` throws `Refusing to overwrite`.
- **conditional kickMessage** — owner not active ⇒ kickMessage matches `/persona select alice/`; owner active
  (persona capability's `getActivePersona` returns it) ⇒ kickMessage does not.
- **reload wiring** — after an owned write, both `reloadPersonas` and `reloadSkills` were called, in that order.

### Step 12 — Broker + provider tests (coder) — after: 2, 4, 5, 8

- New/extended test for the broker `getOwnedWriters` ordering (project → user → beacon → coordinator) and
  unregister-by-id.
- `drone-agent/test/` per-provider owned-writer test: registering the writer through the plugin and asserting
  `exists`/`writeSkill` write `personas/<id>/skills/<id>.md` under a temp dir. Follow the existing
  `test/persona-provider*.ts` / `test/persona-owned-skills.test.ts` patterns.
- Repair `test/self-improvement/persona-owned-skill-paths.test.ts`'s mock (step 3).

### Step 13 — Beacon proxy + client tests (tester) — after: 6, 7

**Files:** `drone-beacon/test/coordinator-proxy.test.ts` (extend) and
`drone-beacon/test/coordinator-client.test.ts` (extend).

- `GET /coordinator/personas/:id/skills` → 503 without a client; pass-through with a fake client asserting the
  argument.
- `POST /coordinator/personas/:id/skills` → 503 when the client returns null; 201 pass-through otherwise.
- `CoordinatorClient.getOwnedSkills` returns `[]` when untrusted and maps scope to `coordinator`.
- `CoordinatorClient.createOwnedSkill` upserts the created row locally (assert a beacon DB read sees it) and
  returns `null` when untrusted.

### Step 14 — Full local verification (tester) — after: 11, 12, 13

Run the plan's **validation criteria** below end to end.

---

## Dependency / execution order

```
1 → 2 → 3
2 → 4 → 9 → 10 → 11
2 → 5 ↗
6 → 7 → 8 ↗
2,4,5,8 → 12
6,7 → 13
11,12,13 → 14
```

Steps 4, 5, 6 and 7 can proceed in parallel once the interface (1–3) is settled; 8 depends on 7; 9 depends on
4, 5, 8.

## Validation criteria

All of the following must hold before the work is "done":

1. **LSP is clean.** `lsp.get_diagnostics` reports no errors or warnings for the workspace (all packages,
   including tests).
2. `pnpm -r run build` — zero errors.
3. `pnpm -r run typecheck` — zero errors.
4. `pnpm -r run lint` — zero errors (prettier runs after eslint; re-read files before further edits).
5. `pnpm -r run test` (the fast suite) — passes, including the new wizard, provider, broker, proxy, and client
   tests.
6. **Interface sweep is complete:** no `DroneSkillsCapability` object literal anywhere is missing
   `registerOwnedWriter`/`unregisterOwnedWriter`/`getOwnedWriters` (verified via LSP find-references plus a
   `grep` cross-check).
7. **Behavioral checks:**
   - With no owned writers registered, `skills__create` asks exactly one question with today's choices and
     default, and writes to the same locations as before (no regression).
   - With owned writers registered, the owner question appears first with `No owner (global skill)` as the
     default/first row.
   - Selecting an owner derives the scope and never asks for one.
   - A supplied `personaId` skips the owner question; an unresolvable one throws.
   - An owned write triggers `reloadPersonas()` then `reloadSkills()`.
   - A coordinator-owned write is visible on the beacon immediately after the write (proxy upsert).
   - The kickMessage names `/persona select <owner>` when the owner is not active, and does not when it is.
8. **The final step (14) re-checks every criterion above against the finished work.**

---

## Completion summary (2026-10-05)

**Status: DONE — all 14 steps executed.** Commit `43e1daf8` on branch
`feat/swarm-persona-owned-skills` (+1127/−38 across 18 files, including a new test file).

### What shipped

- **`drone-core`** — `DroneOwnedSkillWriter` type (`provider-types.ts`), exported from `index.ts`; the three
  registry methods (`registerOwnedWriter` / `unregisterOwnedWriter` / `getOwnedWriters`) on
  `DroneSkillsCapability` (`capabilities.ts`). `getWriters()` untouched.
- **Skills broker** (`drone-agent/src/plugins/skills/index.ts`) — parallel `ownedWriters` registry, sorted by
  scope via `insertWriterSorted`.
- **`persona-provider-{project,user}`** — owned writers writing `personas/<id>/skills/<id>.md` with a file
  `access` existence check.
- **Swarm plugin** (`swarm/providers.ts`) — `beacon`- and `coordinator`-owned writers.
- **Beacon** — new symmetric proxy pair `GET`/`POST /coordinator/personas/:id/skills`
  (`routes/coordinator.ts`) + `CoordinatorClient.getOwnedSkills`/`createOwnedSkill`
  (`coordinator-client.ts`); the POST upserts the created row locally via `upsertSkillFromCoordinator`.
- **Wizard** (`skills/wizard.ts`) — owner-first picker (`No owner (global skill)` default/first row),
  `personaId` input (owner > scope > ask precedence, unresolvable throws), `bindOwnedWriter` helper,
  `reloadPersonas()` then `reloadSkills()` after an owned write, `personaId` in `toolResult`, conditional
  kickMessage naming `/persona select <owner>` when the owner is not active.
- **Tests** — wizard (24), broker + provider (`test/owned-skill-writers.test.ts`, 3), beacon proxy (24) and
  client (41); repaired the one full-literal `DroneSkillsCapability` mock.

### Verification

All validation criteria met: LSP clean; `pnpm -r run build` / `typecheck` clean; `pnpm lint` clean;
`pnpm test` **3317 passed, 14 skipped** (0 failures); interface sweep complete (grep + LSP find-references —
only the `unknown`-cast `tui-completion.test.ts` mock remains, no change needed).

### Notes for the next implementer

- **`pnpm typecheck` at the repo root also runs `tsc -p tsconfig.test.json`**, which type-checks test files that
  the per-package `tsc -b` misses. New test helpers returning object literals for `DroneElicitationAnswers`
  (`Record<string,string>`) must be explicitly typed — inline `if (...) return { ... }` closures infer a union
  with `undefined` optionals that fails the index signature. Fixed with a typed `dispatchElicit` helper.
- **`apply_diff` calls that target the same file in parallel race and can corrupt it.** Combine same-file
  hunks into a single patch.
- Out of scope (left as-is, per plan): the pre-existing `coordinatorSkillWriter.exists` in `swarm/providers.ts`
  hits the beacon URL even for the coordinator scope (a `DroneSkillWriter`, not an owned writer).

### Follow-ups

- `planning-seed-skills-management-tools` captures the deferred *management* surface
  (update/delete/move/rename) and the eventual unified authoring-target registry.
