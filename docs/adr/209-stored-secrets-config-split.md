---
tags: [coordinator, config, secrets, mcp, adr]
related: [modules/drone-coordinator.md, modules/drone-coordinator-ui.md, modules/drone-beacon.md, modules/drone-agent-plugins.md, concepts/beacon-config-override-spec.md, decisions/157-runtime-truth-context-windows.md]
---

# Stored secrets split from coordinator config + config UX fixes

**Summary**: Secrets and settings no longer share the coordinator's config table/UI. A dedicated **Stored Secrets** store (separate `coordinator_secrets` table) is referenced from settings via a distinct `${secret:NAME}` token that the coordinator resolves into the real value **at beacon-pull time** on a beacon-only `/api/config/distribution` payload; beacons hold secret-bearing entries in a **memory-only overlay** and never persist them. Beacons re-pull on a payload-less `configChanged` reverse-channel nudge after secret/setting mutations. Along the way the coordinator's config PUT gained save-time reference validation + a latent sentinel keep-current bug fix, and the Config UI fixed the eager key-lock (BUG1) and lost its secret checkbox (BUG2 dissolvested).

## Context

Two bugs plus one feature request landed on the coordinator Config page; the reported root cause was shared: the Add and Edit dialogs used `editKey !== null` as the sole existing-entry discriminator, so the first keystroke of a new key flipped it into a locked "existing" entry and permanently disabled its secret checkbox. Beyond the bug fix, the user reframed the architecture: secrets and settings should not share one table and one dialog at all. The prior model stored secrets as whole-value `${VAR}` templates with **no server ever holding the real value** (receiver-side env interpolation at session-apply); that only worked end-to-end when the secret was a template, so real API keys could never be managed through the UI.

## Decision

1. **A dedicated Stored Secrets store.** New `coordinator_secrets (name TEXT PRIMARY KEY, value TEXT NOT NULL, ...)` table. Values are plaintext-at-rest on the coordinator (the same posture as coordinator config under Plan B), masked on read (`••••` + last 4) at the DB module so listing can't leak raw, and write-only on rotate (empty value → keep current). Names use the env-var charset `[A-Za-z0-9_]+`.
2. **Settings reference secrets via `${secret:NAME}`, resolved at beacon pull time.** A config value may embed `${secret:NAME}` tokens. The coordinator substitutes them with the real stored values only in `buildDistributionEntries`, consumed exclusively by the beacon-facing `GET /api/config/distribution`. The UI-facing `GET /api/config` stays unresolved and masked — a resolved value never reaches the UI. The env regex `[A-Za-z0-9_]+` cannot match the colon, so `${secret:NAME}` never collides with receiver-side `${VAR}` env templates. The config PUT route validates references at save time (unknown name → 400).
3. **Beacons do not retain resolved secret values.** The distribution payload flags secret-bearing rows (`containsSecrets`); the beacon holds those in a module-level in-memory overlay and persists only non-secret rows to `beacon_config`. A beacon restart wipes the overlay; the startup sync refills it. A beacon compromise at rest therefore yields zero secret material — a deliberate, user-approved posture extension (this is what makes the "type a real key once in the UI" flow possible).
4. **Dangling references drop the row and stay dropped.** A setting whose `${secret:NAME}` can't be resolved (secret deleted after save) is dropped from the distribution payload with a warning, and stays out of every pull until the reference is valid again or the setting is removed (per-pull re-evaluation gives these semantics naturally). The secrets list shows referenced-by counts and the delete confirm lists referencing settings.
5. **Reverse-channel `configChanged` nudge for rotation/change propagation.** On every secret add/rotate/delete and every config PUT/DELETE, the coordinator broadcasts a payload-less `configChanged` command to connected beacons; each beacon's handler calls `triggerCoordinatorSync()` immediately. Fire-and-forget — the 5-minute periodic sync + startup sync remain the correctness floor, and running agent sessions keep old resolved values until their next session start.
6. **Config UI fixes.** The settings dialog uses an explicit `isNew` boolean (not `editKey !== null`) so a new key's first keystroke stays editable (BUG1); the secret checkbox is removed entirely (BUG2 dissolves — new secrets live in the Stored Secrets manager); a blurb documents both reference forms; the key input offers allowlist-faithful completions (`providers.*` → `providers.`, existing keys, exact patterns); and a "Stored Secrets" button opens the manager modal.
7. **Legacy `secret:true` rows are honored as-is.** Classification is `flag OR value contains a ${secret:...} reference`; no migration. Such rows ship their stored value on the distribution payload flagged `containsSecrets`.

## Implementation

- `drone-core/src/config-keys.ts` — `SECRET_REF_PATTERN`, `extractSecretRefs`, `ResolvedConfigEntry` (extends coordinator entry with `containsSecrets`)
- `drone-coordinator/src/db/init.ts` — `coordinator_secrets` table
- `drone-coordinator/src/db/secrets.ts` — `listSecrets` (masked) / `getSecretValue` (raw internal) / `getSecretNames` / `upsertSecret` / `deleteSecret`
- `drone-coordinator/src/mask.ts` — `maskScalar`/`maskSecretValue` extracted (reused by DB secret listing)
- `drone-coordinator/src/config-resolve.ts` — `resolveSecretRefs` + `buildDistributionEntries` (the only resolver; drops dangling rows)
- `drone-coordinator/src/routes/config.ts` — PUT reference validation + sentinel keep-current fix (omitted/empty value keeps stored secret) + `GET /api/config/distribution`; configChanged nudges on write
- `drone-coordinator/src/routes/secrets.ts` — `GET /api/secrets` (with referenced-by) / `PUT /secrets/:name` / `DELETE /secrets/:name`
- `drone-coordinator/src/beacon-ws.ts` — `getConnectedBeaconIds` / `broadcastBeaconCommand` / `notifyConfigChanged`
- `drone-beacon/src/coordinator-client.ts` — `getCoordinatorConfig` → `getCoordinatorDistribution` (hits `/api/config/distribution`)
- `drone-beacon/src/secret-overlay.ts` — memory-only `Map` overlay; `setSecretOverlay`/`overlayEntries`
- `drone-beacon/src/routes/context.ts` — sync split (non-secret → `beacon_config`, secret → overlay); both untouched on throw
- `drone-beacon/src/routes/config.ts` — merged `GET /config` appends overlay entries; `configChanged` WS case → `triggerCoordinatorSync`
- `drone-coordinator-ui/src/pages/config.tsx` + `lib/config-completions.ts` + `components/stored-secrets-modal.tsx` — dialog rework, completion dropdown, secrets manager modal

## Tests

- `drone-agent/test/config-keys.test.ts` — `extractSecretRefs` (embedded, multiple, dedup, env-regex non-collision, shared-pattern immutability)
- `drone-coordinator/test/config-resolve.test.ts` — resolve embedded refs; drop only the dangling row; non-ref rows untouched; legacy `secret:true` flagged
- `drone-coordinator/test/db.test.ts` — secrets CRUD, masked listing, rotate preserves createdAt
- `drone-coordinator/test/routes/config.test.ts` — PUT unknown-ref 400, sentinel keep-current 200, distribution resolve/drop
- `drone-coordinator/test/routes/secrets.test.ts` — CRUD, name charset, create-requires-value, rotate-keep-current, referenced-by
- `drone-coordinator/test/beacon-ws.test.ts` — broadcast to connected beacons, offline no-op, `configChanged` command shape
- `drone-beacon/test/secret-distribution.test.ts` — **secret values never land in `beacon_config` SQLite**; merged `GET /config` exposes overlaid values; sync-throw leaves both stores untouched
- `drone-beacon/test/coordinator-ws.test.ts` — `configChanged` handler re-pulls
- `drone-coordinator-ui/src/pages/config.test.tsx` — BUG1 regression (key stays editable after first letter), no secret checkbox; `lib/config-completions.test.ts` — suggestion logic; `components/stored-secrets-modal.test.tsx` — list/add/rotate/delete/toast

## Key Points

- **Resolution happens only on the beacon-facing payload.** The UI-facing listing is untouched and masked; there is exactly one resolver (`buildDistributionEntries`) and one caller.
- **A beacon compromise at rest yields zero secret material.** Secret-bearing rows never touch `beacon_config`; the overlay is process memory that a restart wipes.
- **The coordinator holds real secret values — a deliberate posture extension over the prior "no server holds a real secret" model.** User-approved; this is what makes storing/rotating real API keys in the UI work.
- **Rotation propagation is nudge-accelerated but pull-truthful.** The `configChanged` broadcast only collapses the latency; correctness never depends on it.

## Related

- beacon-config-override-spec — the coordinator config underlay this extends
- [drone-coordinator](../../drone-coordinator/) — secrets store + distribution route + reverse-channel broadcast
- [drone-beacon](../../drone-beacon/) — memory-only overlay, sync split, `configChanged` case
- [drone-coordinator-ui](../../drone-coordinator-ui/) — config dialog rework, completions, secrets modal
