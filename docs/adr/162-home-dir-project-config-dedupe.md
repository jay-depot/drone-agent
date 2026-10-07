---
tags: [decision, config, bug-fix, scope-policy, discovery]
related: [decisions/155-provider-model-config.md, architecture/config-cascade.md, concepts/scope-hierarchy.md, modules/drone-agent-plugins.md]
---

# 162: Home-Directory Project-Config Dedupe

**Status**: Implemented (2026-08-25)

## Context

Launching drone-agent from `$HOME` crashed at startup with a provider-scope violation. Root cause is a spec gap in project-config discovery, not a policy bug:

- The user layer loads from `~/.drone-agent/config.json`.
- `findProjectConfigPath()` walked ancestor directories from the start directory checking each level for `.drone-agent/config.json`, with **no boundary concept at all** — so a launch from `$HOME` (or any subdirectory whose ancestors contain only the user's own `.drone-agent/`) rediscovered the user config and loaded it a second time tagged as **project** scope.
- `enforceProviderScopePolicy` ([155-provider-model-config](155-provider-model-config.md)) then saw a project-scope layer containing `providers` — banned at project scope — and threw, exiting the agent.

Discovery never considered that the walked-to file might *be* the user config. Worse, the buggy primitive had **three call sites**, not one:

| Call site | Effect of the bug |
|---|---|
| `loadAgentConfig` (`runtime/config.ts`) | Startup-fatal error |
| `writeConfigValue` (`plugins/config/index.ts`) | From `$HOME`, project-scope `config.set` silently wrote to the user config file — and if no config existed yet, the create-fresh fallback would have *recreated* the real user config as a one-key file (data loss) |
| `discoverLayers` (`plugins/config/index.ts`) | `/config` provenance misreported user keys as coming from project scope |

## Decision

**Dedupe project-config discovery against the effective user config path by file identity**, applied at the discovery choke point so every call site inherits the fix.

1. `findProjectConfigPath` is replaced by `resolveProjectConfig(startDirectory, userConfigPath?)` returning `{ path?, skippedDuplicatePath? }`. The walk logic is unchanged (nearest `.drone-agent/config.json`, stop at filesystem root), but a candidate lexically equal (`path.resolve`) to the effective user config path is skipped and reported as `skippedDuplicatePath`. The effective user path defaults to `$HOME/.drone-agent/config.json` and honors the `--config-dir` override used by tests/migrations.
2. **Loud-but-non-fatal**: `loadAgentConfig` appends a one-time warning ("Found \<p\> while searching for project config, but it is the same file as the user config; skipping redundant project-scope load.") through the existing `resolvedConfig.warnings` → `logger.warn` startup surface. Nothing else changes about the session: the user layer still applies once, merge results are identical to a projectless launch, and memory/skills/personas keep treating cwd as today.
3. **Project-scope writes refuse**: `config.set` with project scope when discovery resolves to the shared file throws *"Cannot write project-scope config: … the session has no distinct project. Use 'user' scope instead."* A user asking for project-level config from `$HOME` has a misunderstanding somewhere; silently mutating global config (or recreating it via the fallback) would hide that. Genuine no-config projects still create `<cwd>/.drone-agent/config.json`.
4. `/config` layer provenance (`discoverLayers`) skips duplicates silently — the startup warning already surfaced once.

### Rejected alternative: home-boundary rule

Stopping the walk at `$HOME` ("home is never a project") was considered and rejected: network mounts and external media make the rule ambiguous (projects legitimately live under mountpoints below `$HOME`; `$HOME` itself can be a mount). File-identity comparison sidesteps filesystem topology entirely — we only skip when the discovered file *is* the user config. Symlinked homes are explicitly out of scope for the lexical comparison.

A first-class "no-project mode" across all subsystems (memory, skills/personas providers, search, LSP workspace root all independently use cwd as "the project") remains future work; nothing besides config actually broke at `$HOME`.

## Key Points

- Discovery primitives that walk toward a fixed anchor (like `$HOME`) must consider colliding with that anchor. The dedupe lives in the walker itself so all consumers stay consistent — fixing only the crashing call site would have left the silent-write and provenance bugs behind.
- The refusal message teaches the escape hatch ('user' scope) instead of just failing; the warning keeps the skip discoverable, which matters because this bug class survived precisely because nothing ever said anything.
- Test harness note: the existing `os.homedir()` mock pattern makes the launch-from-home scenario directly reproducible; seven regression tests cover dedupe+warning, merge equivalence vs a projectless launch, distinct projects below home, the `configDir` cross-case, nearest-config-wins, the write refusal (byte-for-byte user-file assertion), and the create-branch.
- Validation: LSP clean; `pnpm -r run build`, `pnpm lint`, fast suite 2233 passed / 9 skipped; grep proves zero remaining references to the deleted export; built-dist smoke test with `HOME=$(mktemp -d)` shows home-launch booting with the exact warning where it previously exited fatally. Commit `0244ea9` on `main`.

## Related

- [155-provider-model-config](155-provider-model-config.md) — the provider scope ban that turns the phantom project layer into a fatal
- [config-cascade](005-config-cascade.md) — layer precedence and discovery
- scope-hierarchy — what "project" means across local/swarm scopes
- [drone-agent-plugins](../../drone-agent/src/plugins/) — the config plugin's get/set surfaces
