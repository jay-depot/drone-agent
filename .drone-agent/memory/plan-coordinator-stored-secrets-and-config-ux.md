---
key: plan-coordinator-stored-secrets-and-config-ux
tags:
  - plan
  - coordinator
  - secrets
  - config
  - ui
created: 2026-09-14T01:51:28.905Z
updated: 2026-09-14T01:51:28.905Z
---

# PLAN — Stored Secrets + Config UX Fixes (coordinator config pipeline, phase 2)

Status: PLANNED (grilling session 2026-09-13, resumed from imported agent-1789237517074). Design summary confirmed by user; ready for execution by `code` persona. Extends Plan B (plan-coordinator-config-ui-and-secret-handling, shipped 2026-09-11) and receiver-side interpolation (plan-receiver-side-env-var-interpolation, shipped 2026-09-12). Suggested branch: `feat/stored-secrets-config-split` off current `feat/coordinator-config-ui-and-secure-storage`.

## Summary & why
Two UI bugs in the coordinator config page (`drone-coordinator-ui/src/pages/config.tsx`) share one root cause: the Add and Edit dialogs share `editKey`, and `editKey !== null` is the sole "existing entry" discriminator, so the first keystroke in Add mode turns the new key "p" into a locked "existing" entry (BUG1) and permanently disables the secret checkbox (BUG2, second condition `&& editSecret`). Beyond fixing them, the user reframed the architecture: secrets and settings must not share one table/dialog. This plan introduces a coordinator-side **Stored Secrets** store with a dedicated modal UI, a distinct `${secret:NAME}` reference syntax resolved by the coordinator **at beacon pull time**, memory-only handling of resolved values on beacons, and allowlist-faithful key completion. SECURITY POSTURE NOTE: this deliberately extends the Plan-B model (coordinator plaintext-at-rest was already locked Q6 there); what is new is resolved values transiting beacon-ward over the existing mTLS channel — user-approved.

## Locked design decisions (grilling Q1–Q8)
- Q1 COMPLETIONS = Option A: from `UNDERLAY_ALLOWLIST` only (+ existing keys for wildcard families). No allowlist widening this round (`promptFile.*` NOT completable/savable yet — by design).
- ARCH: secrets split out of `coordinator_config` into a dedicated store + "Stored Secrets" modal (button top of Config page): list (name · `••••`+last4 · referenced-by N · updated), add, rotate (empty = keep current), delete (soft confirm listing referencing keys). Settings dialog loses the secret checkbox → BUG2 dissolves. Name charset `[A-Za-z0-9_]+` enforced; no description field v1; password-style input with reveal toggle.
- Q2 MODEL B: coordinator resolves `${secret:NAME}` into real values at beacon pull time. Real values live in coordinator SQLite and transit beacon-ward over mTLS. Resolved values must NEVER reach the UI-facing listing — resolution happens only on the beacon-facing payload.
- Q3 RETENTION A: coordinator marks resolved entries (`containsSecrets: true`) on a beacon-only payload; beacon holds secret-bearing rows in a memory-only overlay, persists non-secret rows to `beacon_config` SQLite exactly as today. Beacon restart wipes; boot initial-sync refills. NO pull-through proxy.
- Q4 SYNTAX B: distinct `${secret:NAME}` tokens (embedded mid-string OK). Plain `${VAR}` untouched → still env-resolved receiver-side (env regex `[A-Za-z0-9_]+` cannot match the colon — no namespace collision; `maskScalar` whole-value check `[^}]+` passes both forms). PUT save-time validation: unknown secret name → 400. Docs blurb on the settings dialog explaining both reference forms.
- Q5 DANGLING REF B+: resolver drops the affected row + warns; the key stays out of every pull until the reference is valid again (secret re-created with that name) or the setting is removed. Per-pull re-evaluation gives these semantics naturally. Secrets list shows referenced-by; delete shows soft confirm with referencing keys.
- Q6 PROPAGATION B: payload-less `configChanged` reverse-channel command broadcast on mutations (secrets add/rotate/delete + config PUT/DELETE); beacon handler = `triggerCoordinatorSync()`. Fire-and-forget; the 5-min pull + boot sync remain the correctness floor. (WS broadcast only — offline beacons self-heal via periodic pull; no HTTP fallback needed.) Running agent sessions keep old resolved values until next session start (settled in prior plan).
- Q7 MODAL SPEC: masked `••••`+last4 preview YES; description field NO; name charset enforced as above.
- Q8 LEGACY ROWS A: `secret: true` rows honored as-is; classification = flag OR value contains a `${secret:NAME}` reference; no migration; badge stays in table; API still accepts the flag; no new UI path creates it. Note: a legacy secret row with a real plaintext value now ships RAW on the beacon payload (deliberate posture extension — those rows were masking-corrupted garbage before; now they work).

## New API surface
- `GET /api/config` — UNCHANGED (UI-facing; unresolved + masked). Resolved values must never appear here.
- `GET /api/config/distribution` — NEW, beacon-facing: resolved values + `containsSecrets` flags.
- `PUT /api/config/:key` — MODIFIED: reject unknown `${secret:NAME}` refs (400); FIX latent bug: value omitted/empty must be accepted as keep-current when key exists AND stored row.secret === true (today the UI's sentinel omission 400s server-side — route requires `typeof value === 'string'`).
- `GET /api/secrets`, `PUT /api/secrets/:name`, `DELETE /api/secrets/:name` — NEW.
- beacon WS command `configChanged` — NEW (payload-less).

## Execution steps (S1→S12, with dependencies)

**S1 (drone-core) — reference-syntax helpers** → enables S4, S5.
File `drone-core/src/config-keys.ts`: add `SECRET_REF_PATTERN = /\$\{secret:([A-Za-z0-9_]+)\}/g` and `extractSecretRefs(value: string): string[]` (use `value.matchAll(SECRET_REF_PATTERN)` — never `.test()`/`.exec()` on the shared global regex, it is stateful; prefer `new RegExp(SECRET_REF_PATTERN.source)` if test-style checks are needed). Also add exported wire type `ResolvedConfigEntry extends CoordinatorConfigEntry { containsSecrets: boolean }`.
Tests: new `drone-agent/test/config-keys.test.ts` (root suite picks it up; do NOT rely on drone-core-local vitest — known "No test files found" quirk): none / single / multiple / embedded-mid-string / dedupe-irrelevant cases.

**S2 (coordinator) — masking module extraction** → enables S3, S5.
New `drone-coordinator/src/mask.ts`: move `maskScalar` and `maskSecretValue` out of `src/routes/config.ts` (routes file imports them; local copies deleted). No behavior change. Existing route tests must stay green.

**S3 (coordinator) — secrets store** → enables S4, S5.
`src/db/init.ts`: add table `coordinator_secrets (name TEXT PRIMARY KEY, value TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`.
New `src/db/secrets.ts`: `listSecrets()` → `{ name, maskedValue (via maskScalar), updatedAt }[]` (masked at DB layer so no route can leak raw); `getSecretValue(name): string | undefined` (raw, internal use only); `getSecretNames(): string[]`; `upsertSecret({name, value})` (INSERT ON CONFLICT(name) UPDATE value/updated_at, preserve created_at); `deleteSecret(name): boolean`. Name charset validation lives in the route, not the DB layer.
Tests: extend `test/db.test.ts` (CRUD + masked listing + rotate preserves created_at).

**S4 (coordinator) — resolver + distribution builder** → enables S5.
New `src/config-resolve.ts` (pure, no DB imports — route wires db in):
```ts
resolveSecretRefs(value, secrets: ReadonlyMap<string,string>):
  | { ok: true; value: string }        // every ${secret:N} replaced (embedded ok)
  | { ok: false; missing: string[] }
buildDistributionEntries(rows: CoordinatorConfigEntry[], getSecretValue):
  { entries: ResolvedConfigEntry[]; dropped: { key: string; missing: string[] }[] }
```
Classification per row: `containsSecrets = row.secret === true || extractSecretRefs(row.value).length > 0`. Resolution: replace all refs; any missing name → drop the whole row (providers entries are whole-entry units — same granularity as the receiver-side design) and record in `dropped`. Rows without refs keep stored value verbatim (legacy secret rows ship raw — see Q8 note).
Tests: unit — resolves embedded refs; drops row with missing name (and only that row); non-ref rows untouched; legacy secret:true flagged.

**S5 (coordinator) — routes** → enables S7, S8–S10 (API shapes). Depends on S2–S4.
`src/routes/config.ts`:
- PUT: after allowlist check, `const refs = extractSecretRefs(value); const unknown = refs.filter(n => !db.getSecretValue(n)); if (unknown.length) 400 "Unknown stored secret(s)..."`. Fix the sentinel bug: accept omitted-or-empty `value` when key exists AND stored `entry.secret === true` → upsert preserving stored value; otherwise 400 as today. Call `notifyConfigChanged()` (S6) fire-and-forget on success.
- DELETE: call `notifyConfigChanged()` fire-and-forget.
- NEW `GET /api/config/distribution`: `{ entries }` from `buildDistributionEntries(db.listCoordinatorConfig(), db.getSecretValue)`; log warn per dropped row (`Dropping config entry "<key>" from distribution: unknown secret reference(s) <names>`). Add a prominent comment: RESOLVED SECRET VALUES — never surface via UI-facing routes.
New `src/routes/secrets.ts` (register in `routes/index.ts`):
- `GET /secrets` → listSecrets() + per-name `referencedBy: string[]` (scan `listCoordinatorConfig()` values with extractSecretRefs) — one call powers list + delete-confirm + refcounts.
- `PUT /secrets/:name` → 400 unless `/^[A-Za-z0-9_]+$/`; create requires non-empty value; rotate with empty/omitted value keeps current (400 only when creating new with empty); `notifyConfigChanged()`.
- `DELETE /secrets/:name` → 404 if absent; `notifyConfigChanged()`.
Tests: extend/`test/routes/config.test.ts`-style + new secrets route tests: PUT validation 400; sentinel keep-current now 200 (red-first: fails pre-fix with 400); distribution route resolve/drop; secrets CRUD; referencedBy computed.

**S6 (coordinator) — configChanged broadcast** → pairs with S7. Depends on nothing else (can parallel S4).
`src/beacon-ws.ts`: add `getConnectedBeaconIds(): string[]` and `broadcastBeaconCommand(type: string): void` (short per-connection timeout ~2500ms, all errors swallowed+warned — a nudge is best-effort). Add `notifyConfigChanged()` (broadcasts `'configChanged'`). Used by S5 routes.
Tests: extend `test/beacon-ws.test.ts` via existing `_registerTestConnection`/`_getConnection` hooks: nudge reaches every connected id; offline → no-op, no throw.

**S7 (beacon) — memory-only overlay + sync split + WS case** → depends on S5 (route) + S6 (command exists).
- `src/coordinator-client.ts`: replace `getCoordinatorConfig()` with `getCoordinatorDistribution(): Promise<ResolvedConfigEntry[]>` (cfetch `${baseUrl}/api/config/distribution`); find-references sweep before deleting the old method (principle: shared-interface changes sweep all consumers/mocks).
- New `src/secret-overlay.ts`: module-level `Map<string, ResolvedConfigEntry>`; `setSecretOverlay(entries)` (clear+set), `overlayEntries()`, (process exit = wipe; nothing persisted).
- `src/routes/context.ts` sync block becomes:
```ts
const dist = await client.getCoordinatorDistribution();
db.replaceSwarmConfig(dist.filter(e => !e.containsSecrets));
setSecretOverlay(dist.filter(e => e.containsSecrets));
configCount = dist.length;
```
On throw: warn and leave BOTH previous stores untouched (today's catch semantics, replicated for the overlay).
- `src/routes/config.ts` GET /config: merged = `db.listMergedConfig()` then append overlay entries whose key is absent (beacon-local still wins; secret rows are absent from DB by construction).
- `src/coordinator-ws.ts`: new `case 'configChanged': void triggerCoordinatorSync().catch(warn); ack ok`.
Tests: overlay unit test; sync-split test (fake client with mixed entries → secret rows NOT in the SQLite beacon_config table, non-secret rows persisted, merged /config shows both); coordinator-down-at-boot → secret rows absent + warn + non-secret rows kept; ws case triggers sync. Co-locate with existing coordinator-config sync tests in `drone-beacon/test/`.

**S8 (UI) — settings dialog rework (BUG1 + BUG2 dissolution + blurb)** — `src/pages/config.tsx`. Depends on S5 API shapes only.
- Add `const [isNew, setIsNew] = useState(false)`; REMOVE `editSecret` state and the secret checkbox entirely. `openAdd`: `setEditKey(''); setIsNew(true)`. `openEdit(entry)`: `setEditKey(entry.key); setIsNew(false); setEditValue(entry.secret ? '' : entry.value)` (keep-current sentinel keyed off `entry.secret`).
- Key input: `disabled={!isNew}`; dialog title: `isNew ? 'Add Config' : `Edit ${editKey}` `; add-mode description (allowed patterns) unchanged.
- `handleSave`: body `{ description }` + value logic (omit value only when editing a legacy secret row with empty input — server keep-current now actually works post-S5; PUT response remains source of truth for the `secret` badge).
- Blurb (Q4) under the Key input in add mode: references — `${secret:NAME}` pulls from Stored Secrets at distribution time; `${ENV_VAR}` resolves receiver-side from agent env; new secrets belong in the Stored Secrets manager, never here.
- RED-FIRST regression test in `src/pages/config.test.tsx`: Add Config → type 'p' into key input → input still enabled and holds 'p'; complete 'providers.test' → save → PUT called with that key (fails pre-fix: input disables after 'p'). Also: no secret checkbox in dialog; legacy-secret edit shows keep-current sentinel.
- Existing-behavior note: table value preview already shows `${secret:...}` references verbatim (correct — a reference is not secret material).

**S9 (UI) — key completion (Q1)** — depends on S8 (same file).
New `src/lib/config-completions.ts`: `computeKeySuggestions(query, existingKeys, patterns: string[]): string[]` — candidates = existing keys ∪ patterns (exact pattern → itself; `X.*` → `X.`); filter `startsWith(query)`, drop exact-equals, sort, cap 8. Unit tests in `config-completions.test.ts`.
Wire into `config.tsx`: suggestions dropdown under the Key input in add mode; click-to-fill; Escape dismisses. No new dependencies; keyboard nav optional polish (out of scope v1).

**S10 (UI) — Stored Secrets modal (Q7)** — depends on S5.
- `src/lib/types.ts`: `StoredSecretEntry { name: string; maskedValue: string; updatedAt: number; referencedBy: string[] }`.
- New `src/components/stored-secrets-modal.tsx`: opens via "Stored Secrets" button beside "Add Config" on the Config page. List rows (name · maskedValue · referencedBy count/keys · updated) + Rotate/Delete + Add Secret. Value input: `type="password"` with show/hide toggle; rotate leaves value empty = keep current (body omits value); delete → confirm dialog listing `referencedBy` keys (soft guard). Errors → toast/ErrorBanner per house style (useApi/extractApiError conventions).
- Tests `stored-secrets-modal.test.tsx` (mocked fetch): list render, add PUTs, rotate-keep omits value, delete confirm shows referencing keys, delete fires DELETE.

**S11 (docs + ADR)** — depends on all above.
- `docs/agents/swarm-plugin.md`: new "Stored secrets and distribution" subsection (syntax, resolve-at-pull, containsSecrets, beacon memory-only overlay + restart wipe + boot refill, dangling drop+warn+stay-dropped, configChanged nudge, legacy rows honored) and REWRITE every now-false claim (notably the "secrets never transit the swarm in plaintext" passages — receiver-side interpolation section — and AGENTS.md Config System paragraph).
- `AGENTS.md`: Config System section — stored-secrets resolution at pull, mTLS transit, memory-only beacon handling.
- Project wiki: ADR `decisions/209-stored-secrets-config-split` (follow the decisions/ meta convention; include the posture-change rationale and the Q1–Q8 locked decisions; pitch-first summary per decision 193).

**S12 — validation sweep (final gate; MUST be last).**
See criteria below; include the red-first evidence collected in S5/S8 and the beacon DB no-secret-material check from S7 tests.

## Dependencies / execution order
S1, S2 (parallel) → S3 → S4 → S5 ∥ S6 → S7 → S8 → S9 → S10 → S11 → S12. (S8–S10 need only S5's API shapes and could interleave with S7, but sequential keeps review simple.) Reviewer gate after S4+S5+S7 (security-relevant): verify no resolved-value path reaches any UI-facing GET, overlay never touches disk, masking intact, mTLS-only reachability unchanged for /api.

## Validation criteria
1. LSP diagnostics clean on every touched file (after `pnpm build` — drone-core types resolve from dist/; run `pnpm build` post-S1 before trusting LSP in dependents).
2. `pnpm -r run build` exit 0; `pnpm -r run lint` exit 0 (prettier will reformat — re-read files before further edits).
3. Fast suite = ROOT `pnpm test` (NOT `pnpm -r run test`, which fails at drone-core "No test files found" — known infra quirk, see plan-receiver-side-env-var-interpolation execution record). All green, no new skips.
4. Red-first evidence: BUG1 regression test fails pre-fix; sentinel keep-current route test fails pre-fix (400); distribution drop test fails pre-impl. (Verify by stashing impl, per prior plan's practice.)
5. Cross-cutting sweep: find-references on `getCoordinatorConfig` (beacon client), `CoordinatorConfigEntry` consumers, and UI `editSecret` usages — zero stale references; mocks updated.
6. Beacon SQLite contains zero secret-bearing values: S7 test asserts `beacon_config` has no row for any `containsSecrets` key.
7. Manual smoke (handed to user): add secret → reference it in providers entry → fresh agent session authenticates with real value; beacon DB clean; rotate → new sessions pick up new value without beacon restart (configChanged path) and within ≤5 min otherwise; delete secret → row vanishes from next distribution + warn; re-create secret with same name → next sync restores distribution; UI GET /config never shows resolved values; legacy secret:true row (whole ${VAR} template) still distributes verbatim and env-resolves.

## Explicit non-goals (unchanged by this plan)
No allowlist expansion; no live mid-session re-apply; no pull-through proxy; no legacy-row migration; no per-beacon secret stores; no encryption-at-rest (still deferred from Plan B).