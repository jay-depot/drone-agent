---
tags: [decision, swarm, config, llm, adr]
related:
  [
    modules/drone-agent.md,
    modules/drone-beacon.md,
    decisions/212-coordinator-config-pipeline.md,
    decisions/213-swarm-config-underlay-resolution.md,
  ]
---

# ADR 241: Swarm config underlay — broker reactivity & save-time provider validation

**Status**: Implemented (2026-10-09, branch `feat/swarm-config-startup-underlay`)

## Context

The coordinator → beacon → agent config underlay (ADRs 212/213) applies at
session start: the swarm hook calls `configCap.rebuild()`, which merges the
beacon's rows under the on-disk layers and mutates the engine's shared config
object in place. That machinery was verified correct end to end — but nothing
downstream _reacted_ when the underlay landed. Three consequences, confirmed
live against a real coordinator-stored `providers.openrouter` entry:

1. **`/model` served a stale listing for up to 60s.** The llm broker warms its
   discovery cache in `onPluginsLoaded` — before the underlay exists — and
   `invalidateDiscovery()` only ran on an explicit provider switch. The
   listing therefore showed only locally-configured providers until the
   60-second `DISCOVERY_TTL_MS` expired; waiting 60s made the swarm provider
   appear, which is how the defect was found.
2. **A swarm-pinned `llm.active` never took effect.** `maybeAutoActivate()`
   ran only in `onPluginsLoaded`, when the pin's provider did not exist yet.
   Activation was pinned to the pre-underlay state for the whole session.
3. **An authoring mistake shipped silently to every agent.** The coordinator's
   `PUT /config/:key` stored `providers.*` values verbatim with no parse
   check; a value with a trailing comma was saved without complaint, resolved
   its `${secret:…}` reference correctly, flowed beacon → agent, and was then
   dropped by the agent's `BeaconConfigInjector` with a one-time-per-process
   log warning. The provider simply vanished from every connected agent.

Fixing (1) and (2) by _waiting_ is impossible to do cheaply: hook order is
registration order and the swarm plugin registers after the static built-ins,
so an llm-plugin `onSessionStart` hook would run **before** the swarm hook's
`rebuild()` — the broker cannot self-position after the underlay. Reordering
plugins to fix a data-flow dependency would be fragile for exactly the reason
the order exists (the swarm plugin needs host wiring via `createBuiltInPlugins`).

## Decision

### D1 — `DroneConfigCapability.onLayersChanged(cb) → unsubscribe` (optional)

The config plugin keeps a per-registration callback registry (closure state,
never module scope — a module-scope registry would leak subscribers across
engines in tests and multi-instance hosts) and fires every callback at the
**end of `rebuild()`**, after the shared config mutation, so subscribers
observe the new values the moment they run. Each callback is isolated in its
own try/catch; a throwing subscriber is logged (non-fatal) and later
subscribers still run. The field is **optional** on the drone-core
`DroneConfigCapability`, so no implementer sweep was needed and consumers
that never call it are unaffected.

The config plugin does **not** diff: it fires on every `rebuild()`. Filtering
no-op rebuilds is the subscriber's job (D2), which keeps the primitive narrow
and lets each consumer define "relevant change" for itself.

### D2 — The llm broker subscribes with a fingerprint guard

At register time the broker requests the `config` capability and, when
`onLayersChanged` exists, snapshots a baseline fingerprint **before any
underlay can fire** — the subscribe-time snapshot is the pre-underlay state,
so the first post-rebuild fire carries the real diff. The fingerprint is
`JSON.stringify({ providers, llm.active })`:

- `providers` — the whole map; any entry change (added, removed, edited
  `baseUrl`/`apiKey`/models) changes the string.
- `llm.active` — the pin string itself (not the whole `llm` object; unrelated
  fields like `modelRoles` must not trigger provider reactivation).

On each fire the broker recomputes the fingerprint; **equal → return** (a
no-op `rebuild()` costs one JSON stringify, zero churn). Different → the
broker logs a provider-id diff notice (`LLM config changed: providers added
[x] removed [y]` — **ids only**; the fingerprint itself embeds resolved API
keys and is never logged), invalidates the discovery cache, re-evaluates
activation (D3), and re-warms the listing fire-and-forget
(`void buildModelListing().catch(noop)`) so an immediate `/model` is served
from a fresh cache without anyone having waited.

### D3 — Activation re-evaluation rules (`reactToConfigChange`)

Three rules, driven by one new piece of state: `manualSelection`, set **only**
by the capability's user-driven paths (`setModel`, `activateProvider` — the
`/model` command and the `--model` override) and never by auto-activation:

1. **No manual selection this session.** Auto-activate the resolved
   `llm.active` when it differs from the current selection; when the pin is
   unset or unresolvable, run the startup fallback chain (first configured
   provider with a driver) with the existing warn. This is what makes a
   swarm-pinned `llm.active` work at session start.
2. **Manual selection already made.** Never auto-switch. When the underlay
   pins a different selection, notice once (`Swarm config underlay sets
llm.active to "…" — current selection x/y kept`) and keep serving. The
   fingerprint guard makes this genuinely once per distinct pinned value —
   including the mid-session `enablePlugin` catch-up path, which re-runs
   `onSessionStart` hooks and therefore fires `onLayersChanged` mid-session.
3. **Active provider vanished from config.** Keep the cached instance
   (instances are never evicted) so an in-flight conversation is not broken;
   warn once. The listing and discovery reflect the new config; chat
   continuity is preserved.

The startup fallback loop was extracted into a shared
`activateFromConfig(logWhenNone)` helper used by both `maybeAutoActivate()`
and the reactive path (no duplicated chain). `maybeAutoActivate` keeps its
"already active → return" guard, so the reactive path cannot fight it.

### D4 — Coordinator save-time provider validation

`PUT /config/:key` now rejects a `providers.*` value that is not a JSON
**object** with a 400 naming the parse error (`must be a JSON object: …`).
Applied only when a non-empty string value targets a `providers.` key, so:
non-provider keys are untouched (they legitimately carry scalars), and the
write-only secret sentinel (omitted/empty value on an existing secret row =
"keep current") is unaffected. The UI needed no change — the add/edit dialog
already surfaces 400s via `extractApiError`. This closes the silent-vanish
failure mode at the source: an unparseable row can no longer be stored at
all.

### D5 — Underlay application visibility (minimal)

The swarm session-start log line is enriched into a single info line:
provider names with declared model counts, the resolved `llm.active`, and
underlay-row recency (`underlay rows fetched Ns ago (M rows)`) from a new
`BeaconConfigInjector.getLastAppliedEntries()` that records the raw rows of
the last successful fetch. Recency makes a stale-beacon situation visible in
the log (the beacon-freshness model itself is unchanged — see D6). Provider
names and counts only; secret material never appears.

### D6 — Explicitly out of scope

- **Agent→beacon freshness re-pull.** The beacon's view is kept fresh by the
  coordinator's `configChanged` nudge + boot sync + the 5-minute periodic
  floor. A session-start "refresh before apply" round-trip would duplicate
  the nudge and add latency; row recency in the log (D5) covers observability.
- **`BeaconConfigInjector` fetch timeout.** The unbounded `fetch` predates
  this change; noted as follow-up material, not taken here.
- **Live mid-session re-apply of ordinary config changes.** Underlay
  application remains a session-start (or plugin-enable catch-up) event; the
  reactive path changes what happens _after_ it fires, not when it fires.

## Consequences

- Swarm-configured models and `llm.active` pins are usable immediately at
  session start; `/model` no longer serves a 60s-stale listing.
- The llm broker now depends on the `config` capability at register time —
  but only optionally: when the capability (or the new field) is absent the
  broker behaves exactly as before, so local-only agents and existing tests
  with minimal registration mocks are unaffected.
- No-op rebuilds (unchanged layers) are cheap and silent for the broker;
  changed rebuilds produce at most: one provider-diff notice, one
  activation/re-evaluation log line, one listing re-warm.
- Coordinator config authoring errors now fail at save time with an
  actionable message instead of silently dropping on every agent.
- `providers` entries remain whole-entry units: the fingerprint treats any
  entry edit as a change, and `CONFIG_MERGE_SPEC`'s per-key whole-entry
  replace semantics are untouched.

## Validation

Red-first per step: `onLayersChanged` contract tests (fires after shared
mutation, unsubscribe, throwing-subscriber isolation), broker reactivity
tests (stale-listing invalidation, auto-activation, manual-selection
protection, vanished-provider continuity, no-op silence, unsubscribe),
coordinator route tests (valid object accepted, trailing comma 400 + not
stored, array 400, non-provider keys untouched, secret sentinel preserved),
injector recency tests. Full sweep: LSP clean, `pnpm lint` zero, `pnpm -r
run build` zero, fast suite green.
