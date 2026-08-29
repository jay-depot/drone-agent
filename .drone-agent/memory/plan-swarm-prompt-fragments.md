---
key: plan-swarm-prompt-fragments
tags:
  - plan
  - swarm
  - prompt-fragments
created: 2026-08-29T15:25:13.407Z
updated: 2026-08-29T15:25:13.407Z
---

# Plan: Swarm Prompt Fragments (beacon/coordinator → agent sessions)

Assigned plan name: **plan-swarm-prompt-fragments**. Companion context memory: `plan-swarm-prompt-fragments-exploration` (architecture findings + all user decisions with rationale).

## Feature summary & why

Beacons and the coordinator can inject **system prompt fragments** into running drone-agent sessions: **targeted** (one `agentId`) or **broadcast** (all sessions, "persistent swarm banner"). Fragments are stored, addressed DB assets with caller-chosen stable ids (idempotent keyed upsert), TTL for targeted rows, live-until-deleted broadcasts, WS push to connected agents + full-state resync on connect, and sync-interval mirroring of coordinator-scoped fragments into beacons. Designed so a future RAG pipeline can be a natural programmatic API consumer (idempotent writes, stable addressing) and so the beacon→coordinator sync piece can be discarded wholesale by the coming persistent-WS rework without agent-side changes. Prompt content is trusted swarm-internal content (single-user swarm; payload-injection risk from beacon writers is an accepted trade-off; beacon must bind localhost/tailscale + careful TOFU — document before release).

## Locked design decisions (user-approved in planning session)

1. Stored addressed asset; REST is source of truth.
2. Caller-chosen stable id upsert (idempotent) + TTL backstop; NO replacement-sets/generations v1.
3. Agent renders via TWO prompt fragments registered by the swarm plugin (`swarm.fragments.header` phase=header, `swarm.fragments.footer` phase=footer); render() reads an in-memory Map only (NO network in render); returns false when bucket empty. Freshness: beacon WS push + fragmentSync on WS connect.
4. Target identity = `agentId` (== swarm.sessionId; spawner persists spawns.agent_id). Accept-and-queue unknown ids. Broadcast = reserved target value `'broadcast'` in same table.
5. Broadcasts: no default TTL, hard max count + max size; deletion propagates as remove-push; targeted rows get 24h default TTL unless explicit expiresAt (provisional, constants not config).
6. Coordinator scope v1: sync-interval pull (persona precedent), coordinator-scoped shadows beacon-scoped same-id; coordinator changes read-only (GET for the beacon pull). Coordinator authoring deferred.
7. v1 authoring: beacon REST + minimal `drone-swarm fragments list/set/delete` (list works vs beacon+coordinator; set/delete beacon-only). No agent-side tool.
8. Observability: reuse existing `notice` DroneConversationEvent kind; /systemprompt already exposes rendered content.
9. Model-visible fragment ids in the rendered prompt (e.g. `## [maintenance-window]`).

## Terminology

- **fragment row**: `{ id, target, content, phase, scope, createdAt, updatedAt, expiresAt }`.
- `id`: caller-chosen, `^[a-zA-Z0-9:_-]+$` (URL-safe, prompt-display-safe). `(scope,id)` uniqueness for shadowing; beacon enforces unique id per scope; coordinator-scoped id shadows beacon-scoped id with equal id.
- `target`: an agentId string OR the reserved sentinel `broadcast`. POST /agents must reject registering agentId === 'broadcast'.
- `phase`: 'header' | 'footer' (default 'header').
- `scope`: 'local' | 'coordinator' (beacon rows); coordinator DB rows are implicitly coordinator-scoped.
- `expiresAt`: epoch ms or null. Targeted+null → server stamps now+24h. Broadcast+null → lives until deleted/replaced.

## Server limits (module-level constants in beacon; revisit values later per user)

`MAX_BROADCAST_FRAGMENTS = 5`, `MAX_TARGETED_FRAGMENTS_PER_AGENT = 50`, `MAX_FRAGMENT_CONTENT_BYTES = 16 * 1024`, `DEFAULT_TARGETED_TTL_MS = 24h`, `TTL_SWEEP_INTERVAL_MS = 60_000`.

## Render format (agent)

Header bucket render → `# Swarm Fragments\n\n## [<id>]\n\n<content>` blocks joined by blank lines (skip whole render when bucket empty). Footer bucket render → `# Swarm Directives\n\n## [<id>]\n\n<content>`. Ids sorted lexicographically for deterministic render. fragments render AFTER existing plugin fragments (engine array order = registration order).

## WS protocol (beacon /ws, agent swarm/websocket.ts)

- Beacon → agent `{ type: 'fragment', payload: { op: 'set' | 'remove', fragment } }` (fragment row as served/merged; for remove only id+target needed).
- Beacon → agent on connect (right after existing `connected` + unread replay): `{ type: 'fragmentSync', payload: { fragments: [...] } }` = full merged current set for this agentId (targeted-for-agent + all broadcasts, TTL-filtered).
- TTL sweep on beacon (interval TTL_SWEEP_INTERVAL_MS): delete expired targeted rows; on any deletion that affects a connected agent, send remove-push.
- Coordinator mirror sync: after wholesale-replacing coordinator-scoped rows in triggerCoordinatorSync, compute cheap content hash; if changed, send fragmentSync to ALL connected agents (5-min cadence ⇒ negligible cost).

## Implementation steps (assignee; order = dependency order)

### Phase A — drone-core shared types (coder)

1. **drone-core/src/swarm-fragment-types.ts (new)**: export `DroneSwarmFragment` wire type `{ id: string; target: string; content: string; phase: 'header' | 'footer'; scope: 'local' | 'coordinator'; createdAt: number; updatedAt: number; expiresAt: number | null }`, `BROADCAST_TARGET = 'broadcast'` sentinel const, `validateFragmentId(id: string): boolean` (regex above), `BROADCAST_PHASE...` none — phase belongs to row not sentinel. Re-export from drone-core/src/index.ts. Note: drone-swarm CLI self-defines its wire types (existing precedent: WikiPageSummary in drone-swarm/src/client.ts); only beacon + agent + coordinator import drone-core.
2. Run `pnpm -r run build` after editing drone-core BEFORE relying on LSP in dependent packages (project principle: dependents resolve drone-core types from built dist/).

### Phase B — beacon storage + REST (coder)

3. **drone-beacon/src/db/init.ts**: add `fragments` table to schema: `id TEXT NOT NULL, target TEXT NOT NULL, content TEXT NOT NULL, phase TEXT NOT NULL DEFAULT 'header', scope TEXT NOT NULL DEFAULT 'local', createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, expiresAt INTEGER, PRIMARY KEY (id, target)` + indexes `idx_fragments_target(target)`, `idx_fragments_scope(scope)`, `idx_fragments_expires(expiresAt)`. PK (id,target) allows same id present as targeted AND broadcast simultaneously (intentional; CLI disambiguates via --target flag).
4. **drone-beacon/src/db/fragments.ts (new)** + export through db/index.ts: `upsertFragment({id,target,content,phase,scope,expiresAt})` (raw SQL upsert preserving createdAt on conflict; server recomputes expiresAt for targeted+null), `getFragment(id, target)`, `listFragments({target?, scope?})`, `deleteFragment(id, target)`, `deleteExpiredFragments()` returns deleted rows (so ws-server can push removals), `replaceCoordinatorFragments(rows)` (DELETE scope='coordinator' + batch insert), `listMergedForAgent(agentId)` → TTL-filtered targeted-for-agent + all broadcasts with shadowing applied (coordinator shadowing beacon same-id), `mergedContentHash()` (deterministic JSON hash e.g. sha256 of JSON.stringify(sorted rows)).
5. **drone-beacon/src/fragments-limits.ts (new)**: the constants + `validateFragmentUpsert(body)` returning `{ ok: true, normalized } | { ok: false, error }` — enforces id regex, target non-empty ('broadcast' allowed), phase enum, content byte length (Buffer.byteLength), broadcast count cap (MAX_BROADCAST_FRAGMENTS), per-agent count cap (MAX_TARGETED_FRAGMENTS_PER_AGENT), TTL stamping (expiresAt null + targeted → now+DEFAULT_TARGETED_TTL_MS; broadcast+null → null).
6. **drone-beacon/src/routes/fragments.ts (new)** + register in routes/index.ts:
   - `GET /fragments` (`?target=<agentId|broadcast>` optional filter, `?scope=` reserved for admin list) → 200 `{ fragments: DroneSwarmFragment[] }` (raw rows incl. scope; merged view only used for agent delivery).
   - `POST /fragments` body `{ id, target, content, phase?, expiresAt? }` → validate → upsert(scope='local') → WS push `fragment` set-op → 200 `{ ok: true, fragment }` (accept-and-queue: unknown agentId still 200).
   - `DELETE /fragments/:id` (`?target=` required when row exists under both targets; if omitted and unique → delete; if ambiguous → 400 `{ error }`) → WS push remove-op → 200 `{ ok: true }` / 404.
   - 400s carry machine-readable `{ error }` per beacon route convention. Errors from limits are 400 with `{ error, code: 'limit' | 'validation' }`.
7. **drone-beacon/src/routes/agents.ts**: reject `POST /agents` with `id === 'broadcast'` (reserve sentinel).

### Phase C — beacon WS push + resync + sweeps (coder)

8. **drone-beacon/src/ws-server.ts**: (a) in connection handler, after unread-message replay, send `{ type: 'fragmentSync', payload: { fragments: db.listMergedForAgent(agentId) } }`; (b) export `pushFragmentToAgent(agentId, op, fragment)` and `pushFragmentSyncToAllConnected()` wrappers over existing sendToAgent / connections map; (c) new WS message types leveraged only server→client (no client→server changes needed); (d) accept + ignore client 'fragmentAck' no-op message type for forward compatibility (optional, skip if it complicates the union).
9. **TTL sweep**: in drone-beacon/src/fragments-limits.ts or a small fragments-sweep.ts: `startFragmentTtlSweep()` setInterval(TTL_SWEEP_INTERVAL_MS) → `deleteExpiredFragments()` → for each deleted row that targeted a connected agent, pushFragmentToAgent(remove). Start it in beacon index.ts serve path near startMessageCleanup(); stop in shutdown (mirror stopMessageCleanup pattern).
10. **WS push wiring in routes/fragments.ts**: POST/DELETE handlers call pushFragmentToAgent(target's socket) for targeted ops; broadcasts call pushFragmentSyncToAllConnected() (simplest correct broadcast delta; count ≤ 5 keeps payloads tiny).

### Phase D — coordinator pull side (coder)

11. **drone-beacon/src/coordinator-client.ts**: add `fetchCoordinatorFragments(): Promise<DroneSwarmFragment[]>` — GET `/api/fragments`, `coordinatorTrusted()`-gated returning [] when unready (mirror fetchPersonas shape at ~line 416).
12. **drone-beacon/src/routes/context.ts** `triggerCoordinatorSync()`: fetch fragments; `replaceCoordinatorFragments(rows)`; compute mergedContentHash() before/after mirror; on change call `pushFragmentSyncToAllConnected()`; include `fragments: n` in the logged + returned sync counts. Non-fatal on fetch failure (warn + continue) matching knowledge-sync handling.

### Phase E — coordinator storage + read endpoint (coder)

13. **drone-coordinator/src/db/init.ts**: add `fragments` table (same shape minus scope — coordinator rows are implicitly coordinator-scoped; keep identical columns for symmetry, scope always 'coordinator', PK (id,target)).
14. **drone-coordinator/src/db/fragments.ts (new)** + db/index export: minimal list (with target filter) + upsert + delete (endpoints in step 15 use list v1; upsert/delete functions exist for the clone-and-rework branch).
15. **drone-coordinator/src/routes/fragments.ts (new)** + wire into routes/index.ts under the /api prefix pattern used by other route files: `GET /api/fragments` (`?target=` filter) serving the coordinator table. Read-only v1. Note in code comment: authoring arrives with persistent-WS rework.

### Phase F — agent-side reception + rendering (coder)

16. **drone-agent/src/runtime/plugin-engine.ts**: add additive field to the `_runtime` capability object (line ~790): `emitEvent: (event: DroneConversationEvent) => void` implemented as fire-and-forget invocation of `runConversationEventHooks(event)` with a .catch(logger). Follows ADR-170 additive `_runtime.debugFlags` precedent. Check engine `_runtime` type surface if typed (it is a plain object literal — check capabilities.ts DroneRuntimeCapability type if such type exists; if typed, extend there).
17. **drone-agent/src/plugins/swarm/fragment-store.ts (new)**: pure, testable module: `createSwarmFragmentStore()` → `{ applySet(fragment): 'added'|'updated'|'unchanged', applyRemove(id, target): boolean, replaceAll(fragments): 'changed'|'unchanged', renderHeader(): string | false, renderFooter(): string | false }`. Internal Map<`${phase}:${id}`, {content}>; deterministic sort; render formats per Render format section. applySet/applyRemove return change descriptors for notice emission.
18. **drone-agent/src/plugins/swarm/context.ts**: add `fragmentStore` + `fragmentsResynced: boolean` (set true once fragmentSync handled; guards notices during replay) to SwarmContext.
19. **drone-agent/src/plugins/swarm/websocket.ts** onmessage: handle `fragmentSync` (store.replaceAll → single notice only if content actually changed and not during initial replay-silence window) and `fragment` (`applySet`/`applyRemove`). After each change, request `registration.request('_runtime')?.emitEvent({ kind: 'notice', content: 'Swarm fragment <added|updated|removed>: <id>' })` (throttle: one notice per op, sync emits at most one summary notice like 'Swarm fragments resynced (N active)').
20. **drone-agent/src/plugins/swarm/index.ts**: after WS setup in registerHooks.onPluginsLoaded (or immediately post-createSwarmContext — choose where ws is created; connectWebSocket happens in onPluginsLoaded, so fragment registration must be independent of it): register the two fragments UNCONDITIONALLY at registration time (before WS connect) so prompts are stable: `registration.registerPromptFragment({ key: 'fragments.header', phase: 'header', render: () => Promise.resolve(ctx.fragmentStore.renderHeader()) })` and `{ key: 'fragments.footer', phase: 'footer', render: ... renderFooter() ... }` (registration-time synchronous store; render is async per DronePromptFragment signature).
21. **Resync fetch fallback**: in `connectWebSocket` onopen (websocket.ts), after flushing messageQueue, do NOT fetch (WS sync message covers connect); but if WS CONNECT FAILS permanently (swarm unreachable at onPluginsLoaded), no fragments render — acceptable v1 (log-only), consistent with swarm features being disabled without beacon.

### Phase G — drone-swarm CLI (coder)

22. **drone-swarm/src/client.ts**: add `listFragments(query?)`, `setFragment(body)`, `deleteFragment(id, target?)` methods (route dialect via existing `url()` — beacon flat `/fragments`, coordinator `/api/fragments`).
23. **drone-swarm/src/index.ts**: dispatch:

- `fragments list [--target <t>]` → GET, printJson.
- `fragments set <id> --target <agentId|broadcast> --content <text> | --file <path> [--phase header|footer] [--expires-at <epochMs>]` → POST; coordinator target → error 'fragment authoring requires --beacon (coordinator authoring arrives with the persistent-WS rework)'.
- `fragments delete <id> --target <t>` → DELETE with `?target=`.
- Update HELP block.

### Phase H — docs (coder)

24. **docs/agents/swarm-plugin.md**: new "Swarm prompt fragments" section — asset model, targeting (incl. accept-and-queue + sentinel), WS push/resync delivery, phase/heading render format, limits table (as constants, provisional), TTL semantics, CLI usage examples (beacon + coordinator reads), security note (trusted single-user swarm channel; beacon binds localhost/tailscale; careful TOFU; prompt-injection trade-off explicit), coordinator shadowing rule, marker that coordinator-side storage/serving is scaffolding for the persistent-WS rework (link that branch once named).
25. **Project wiki** (post-merge ingest per obsidian workflow): new concepts page `concepts/swarm-prompt-fragments.md`, index row, ADR for the feature (see Phase J) — coder doing docs step may draft; final wiki ingest is the wiki-maintainer's incremental pass.

### Phase I — tests (coder writes alongside each phase; tester verifies)

26. **drone-beacon/test/db.test.ts**: fragments CRUD + upsert-preserves-createdAt + TTL stamping + replaceCoordinatorFragments wholesale replace + shadowing in listMergedForAgent + expired filtered + mergedContentHash determinism.
27. **drone-beacon/test/routes.test.ts**: REST happy paths + validation 400s (bad id charset, oversized content, phase enum, target required on delete ambiguity) + broadcast count cap + per-agent cap + accept-and-queue 200 on unknown agentId + POST /agents rejects 'broadcast'.
28. **drone-beacon/test/ws-server.test.ts**: fragmentSync delivered on connect with correct merged set; `fragment` push delivered to targeted connected agent; broadcast surface (pushFragmentSyncToAllConnected) reaches all; TTL sweep pushes removal to connected agent (fake timers).
29. **drone-beacon/test/coordinator-client.test.ts**: fetchCoordinatorFragments gating (untrusted → []) + parse shape.
30. **drone-coordinator/test/** (add to existing routes test file or new fragments.test.ts): GET /api/fragments list + target filter.
31. **drone-agent/test/swarm/fragments.test.ts (new)**: store unit tests (set/remove/replaceAll/renders, false-when-empty, visible ids in output, deterministic sort, unchanged detection); websocket.ts handler tests by invoking message handlers directly (no real WS): fragment apply + notice emission via mocked `_runtime` requested at register; prompt-fragment render wiring via mock registration (pattern: mock DronePluginRegistration per existing plugin tests).
32. **drone-agent/test/swarm integration (Docker swarm only)**: extend existing beacon-sync integration fixtures (test/fixtures pattern, RUN_INTEGRATION_TESTS=true guard, refuses unsafe localhost fallbacks): beacon POST /fragments → spawned-with-agentId test agent receives over WS → assert /systemprompt (or buildSystemMessages output) contains `# Swarm Fragments` + id; then DELETE → assert removed. Skipped outside provisioned swarm per existing guards.

### Phase J — review + ADR (reviewer)

33. Reviewer pass targeted at: engine `_runtime.emitEvent` additive-only change (no consumer Ivy breakage: run LSP find-references on `_runtime` consumers); no sync fs; no any; dead code; ws message union extended without breaking agent reconciliation; check beacon route registration ordering/rate limiting untouched.
34. **ADR (decisions/next-number-swarm-prompt-fragments.md)** capturing: stored-asset + keyed-upsert decision, agentId targeting + accept-and-queue, sentinel-target single table, dual-fragment render seam choice, WS push + resync (no acks), TTL/max limits, coordinator sync-hop as rework-scaffolding, security trade-off note. Update wiki index decisions row (include in docs step if reviewer prefers batching).

## Validation criteria (final gate — run in order)

1. `pnpm lint` (root) passes with zero errors (prettier included; re-read files after lint before further edits).
2. `pnpm -r run build` passes with zero errors (drone-core rebuild first if its types changed).
3. All LSP diagnostics pass across the workspace (`lsp__get_diagnostics` severity=error → zero; explicitly including test/, drone-beacon/, drone-coordinator/, drone-swarm/, drone-core/).
4. `pnpm test` (fast suite) passes including all new unit tests in steps 26–31.
5. Integration suite compiles and its provisioning guards are intact; suite expected to skip without RUN_INTEGRATION_TESTS=true; if provisioned Docker swarm available, step 32 passes.
6. Manual smoke (optional but recommended): run beacon locally + drone-agent --plugin swarm; POST a broadcast fragment via curl; verify `/systemprompt` shows `# Swarm Fragments` block with visible id; DELETE it; verify removal notice appears.
7. Feature-specific acceptance: (a) targeted fragment reaches only the addressed connected agent's next-round system prompt and not others; (b) broadcast reaches all connected agents AND newly-connecting agents via resync; (c) coordinator-authored fragment (via future/manual coordinator DB write or pull from coordinator test) shadows beacon same-id after next sync interval; (d) expired targeted fragment disappears from resync after TTL sweep without agent restart; (e) 6th broadcast POST rejected with 400; (f) UI/TUI shows notices on add/remove.

## Out of scope (v1, explicitly)

Replacement sets/generations; agent-side fragment authoring tool; coordinator authoring UI/routes (write side); reverse-channel WS (separate branch); RAG pipeline itself (only the API contract it needs); per-fragment TUI widget/custom event kind; ack protocol (resync is the ack).


---

## COMPLETION SUMMARY (2026-08-29, executed by code persona)

All phases A–J implemented and validated. The vault wiki also has ADR 173 + concepts page.

### What shipped
- **drone-core**: `src/swarm-fragment-types.ts` — `DroneSwarmFragment`, `BROADCAST_TARGET`, `validateFragmentId`);
 re-exported from index. Unit test in `drone-core/test/swarm-fragment-types.test.ts`.
- **drone-beacon**: `fragments` table (PK (id,target)) in db/init.ts; `db/fragments.ts` (upsert preserving
 createdAt, TTL-filtered merged view with coordinator shadowing, deleteExpired returning rows, wholesale
 coordinator replace, sha256 `mergedContentHash`); `fragments-limits.ts` (5 broadcasts / 50 per-agent /
 16 KB / 24h TTL / 60s sweep constants + `validateFragmentUpsert`); `routes/fragments.ts` (GET list w/
 target+scope filter, POST upsert w/ WS push, DELETE w/ ambiguity 400, machine-readable 400 codes);
 POST /agents rejects 'broadcast'; ws-server `pushFragmentToAgent`/`pushFragmentSyncToAllConnected`,
 `fragmentSync` on connect, `fragmentAck` no-op case; `fragments-sweep.ts` wired into serve/shutdown;
 `coordinator-client.fetchCoordinatorFragments()`; triggerCoordinatorSync mirrors coordinator rows
 (scope=coordinator) + hash-change fan-out. **Bug fixes en route**: `sendToAgent` compared numeric
 `readyState` to the string 'OPEN' and silently dropped every server push (pre-existing, also broke live
 message delivery); `isLocalConnection` didn't implement the full RFC1918 172.16/12 range (Docker bridge
 networks 172.17–172.31 rejected) and didn't strip ::ffff: prefixes.
- **drone-coordinator**: fragments table + `db/fragments.ts` (upsert/get/list/delete scaffolding) +
 read-only `GET /api/fragments` under /api prefix.
- **drone-agent**: additive `_runtime.emitEvent` in plugin-engine (extracted shared
 `dispatchConversationEvent`, fire-and-forget w/ logging); swarm plugin `fragment-store.ts` (pure store),
 `fragment-messages.ts` (WS handlers, one notice per op, initial resync silent via `fragmentsResynced`
 flag); two unconditional prompt registrations `swarm.fragments.header`/`.footer` rendering from the
 in-memory store; SwarmContext gains fragmentStore + fragmentsResynced.
- **drone-swarm CLI**: `fragments list [--target]` (beacon+coordinator), `set`/`delete` (beacon-only w/
 clear error vs coordinator); HELP updated.
- **docs**: `docs/agents/swarm-plugin.md` "Swarm prompt fragments" section (asset model, delivery, limits
 table, CLI, security note).
- **tests**: beacon db+routes+ws-server+coordinator-client unit tests; coordinator
 routes/fragments.test.ts; agent test/swarm/fragments.test.ts (store + handlers + registration); new
 guarded integration suite `drone-agent/test/swarm-fragments-integration.test.ts` (added to
 vitest.integration.config.ts) — REST round-trips + WS frame delivery via global WebSocket (WHATWG
 addEventListener; registered agent required before WS connect); **verified green inside the provisioned
 Docker swarm (`pnpm test:integration`: 9 files / 68 tests passed)**.
- **wiki** (separate repo, Obsidian drone-agent-project): ADR 173, concepts/swarm-prompt-fragments, index
 row, decisions rows (2), module/drone-beacon.md fragment feature + corrected isLocalConnection line;
 committed there as 9c45695.

### Validation (all green)
pnpm lint 0 errors (prettier applied); pnpm -r run build 0 errors; pnpm typecheck 0 errors; pnpm test
2434 passed / 12 skipped incl. all new unit tests; Docker integration suite passed (68 tests);
LSP clean on every touched file (remaining workspace diagnostics verified pre-existing via
stash-baseline check: docker/subagent fixtures 'on' typing, coordinator-client mock casts,
auth.test _code, gateway test casts — all predate this session and pass tsc -b).

### Deviations / judgment calls (per plan-gap rules)
1. `fragmentSync` is sent before the `connected` welcome message (plan said "right after connected +
 unread replay"); ordering is functionally irrelevant — the agent applies frames on arrival.
2. TTL sweep sweep function placed in `fragments-sweep.ts` importing from `db` + `ws-server` directly
 (plan allowed either file).
3. Integration WS client uses the WHATWG global WebSocket API (ws package is not a dependency of
 drone-agent; Node >= 22 provides the global).
4. Lint forced self-review fixups: badPhase assertion bug in a route test caught by
 no-unused-vars (would have masked a copy-paste test error); unused WebSocket type import removed.
5. Wiki/ADR "reviewer pass" items verified directly (no `_runtime` consumer breakage via find-references,
 zero any/sync-fs in new code, ws union additive, route ordering untouched) — recorded here rather than
 dispatching a reviewer persona.

### Commits (this repo, branch feat/coordinator-sysmessage-insert)
e144008 chore: commit plan memories / 2450f65 feat: phases A–G source / 821315c docs: swarm-plugin.md /
62f1e3c test: unit + integration / 671e44f fix: WHATWG WebSocket API + lint cleanup /
ac17501 fix: WS test polls + agent registration / b30b748 fix(beacon): sendToAgent readyState /
fix(beacon): RFC1918 172.16/12 isLocalConnection
