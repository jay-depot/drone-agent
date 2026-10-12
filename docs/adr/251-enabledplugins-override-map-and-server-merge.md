---
tags: [decision]
related:
  [
    005-config-cascade.md,
    095-config-deep-merge-refactor.md,
    dynamic-plugin-enabling.md,
    DroneAgentConfig.md,
  ]
---

# 251 — `enabledPlugins` override map + 1-level `servers` map merge

**Status**: Accepted (2026-10-12)

## Context

Three agent-config keys were resolved by **replacement** when the config
layers were merged, but they are naturally extensible collections and should
be resolved by **merge**:

- `enabledPlugins` — a whitelist **array** that replaced the inherited list
  wholesale. A project `.drone-agent/config.json` had to repeat the entire
  home plugin list verbatim to add one plugin.
- `lsp.servers` / `mcp.servers` — whole-map replaces; a more-local layer
  could not add a single server without restating the whole map.

## Decision

### `enabledPlugins` is a sparse override map

`enabledPlugins` becomes `Record<string, boolean>`:

- `true` — force-enable the plugin.
- `false` — force-disable the plugin.
- absent — no opinion.

The map merges per-key (highest layer wins) and is applied as a **sparse
override over the built-in default plugin set** (`required || defaultEnabled`).
Whitelist mode is removed, and with it the "`[]` means use the defaults"
overload.

### Engine-owned resolution order

The engine resolves the effective set in this order:

1. Seed `Set(getDefaultEnabledPluginIds(plugins))`.
2. Apply the config map: `true` adds, `false` deletes.
3. Re-add `required` plugins.
4. Re-add CLI-flag namespaces (`--plugin`, `--swarm`).
5. Validate.

Both `required` and the CLI flag overrides **beat** an explicit `false`: a
CLI flag is the highest layer, and a `required` plugin cannot be disabled.

### Validation

- `true` + unknown plugin id → **throw** (`Config enabled unknown plugin: <id>`).
- `false` + unknown plugin id → **ignore** (a stale disable entry is harmless).

The resolved `DroneAgentConfig.enabledPlugins` stays the **map**; the engine
owns resolution and `applyAgentConfigLayer` stays pure.

`enabledPlugins: null` clears all inherited overrides (reverting to the
default base). Entry-level `null` is not part of the `enabledPlugins`
contract.

### New `mergeMaps` merge rule

A new uniform `deepMerge` rule kind — `mergeMaps` — is applied to
`enabledPlugins`, `trustedPlugins`, `providers`, `lsp.servers`, and
`mcp.servers`:

- Shallow merge, one level; a same-name entry **replaces** the lower layer's
  entry.
- A `null` **entry** deletes that entry from the base.
- A `null` **whole value** clears the map to `{}`.

`lsp.servers` / `mcp.servers` entry-delete uses the path `lsp.servers.<id>` /
`mcp.servers.<id>` (not `lsp.<id>`). `providers` / `trustedPlugins` thereby
gain removal — a local veto of a swarm-distributed provider or trust entry.

The resolved `lsp.servers` / `mcp.servers` are **always** a `Record` (never
`null`; a collection-null normalizes to `{}`). This is load-bearing:
consumers iterate them with `Object.keys` / `Object.entries`.

`externalPlugins` stays **replace** (unchanged).

### Registration surface

`DronePluginRegistration` gains the engine's existing `listPlugins()`, so a
plugin can observe whether another plugin is active without reaching into the
engine (the `persona` plugin's swarm-detection branch now uses it).

### `config.set`

`config.set` accepts a wildcard key `enabledPlugins.*` (boolean), validated by
prefix match. Bare `enabledPlugins` remains allowed (a wholesale map). This
lets the bootstrap workflow write single-key upserts without a read-modify-
write race.

### Migration

The schema keeps a **tolerant read** for the legacy array form (`array | map |
null`) during a deprecation window. A one-time migration translates
`array → { id: true }` and rewrites the file in place with a timestamped
`.old` backup and an atomic tmp/rename. Unlike the providers migration,
**project scope is rewritten too** (the override map carries no provider
references). The migration is idempotent and emits one advisory notice:

> `enabledPlugins` was translated from a list to an override map; it now
> layers over the default plugin set, so default-enabled plugins your list
> omitted will also load.

## Consequences

- Adding a plugin at project scope is now a one-line `{ "<id>": true }`
  rather than restating the whole list.
- `lsp.servers` / `mcp.servers` can be extended and pruned per-scope.
- The swarm/beacon underlay allowlist (`UNDERLAY_ALLOWLIST`) is deliberately
  **unchanged** — none of these keys arrive via the beacon.

## Follow-ups (not in this change)

- Remove legacy array support once the deprecation window closes.
- Swarm distribution of these keys requires a session-level, persona-tied
  permission (they are a code-execution surface).
- Per-id provenance in `config.get` (it tracks dotted leaf keys only).
- Deep (field-level) merge of individual `servers` entries — merge is 1-level
  by design.

## Related

- [005-config-cascade](005-config-cascade.md) — Config layering
- [095-config-deep-merge-refactor](095-config-deep-merge-refactor.md) — `deepMerge` / `MergeSpec`
- [dynamic-plugin-enabling](../../docs/agents/dynamic-plugin-enabling.md) — `--plugin`
