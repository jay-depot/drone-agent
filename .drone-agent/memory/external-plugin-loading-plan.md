---
key: external-plugin-loading-plan
tags:
  - plan
  - external-plugins
  - plugin-system
  - completed
created: 2026-06-29T05:24:16.424Z
updated: 2026-06-29T05:47:45.080Z
---

# External Plugin Loading — Implementation Complete

## Summary

The external plugin loading feature has been fully implemented. Here's what was done:

### Files Created
- `drone-agent/src/plugins/external-loader.ts` — Discovery, loading, and trust management for external plugins
- `drone-agent/test/external-loader.test.ts` — 24 tests covering all functionality

### Files Modified
- `drone-core/src/config-types.ts` — Added `externalPlugins` and `trustedPlugins` to `DroneAgentConfig` and `PartialDroneAgentConfig`, with defaults in `createDefaultAgentConfig()` and merge logic in `applyAgentConfigLayer()`
- `drone-core/src/config-schema.ts` — Added TypeBox schema for new config fields
- `drone-agent/src/runtime/plugin-engine.ts` — Added `addExternalPlugin()` method to `DronePluginEngine` type and implementation
- `drone-agent/src/index.tsx` — Wired external plugin discovery into startup flow, with deferred trust prompting after elicitation setup
- `drone-agent/src/plugins/config/index.ts` — Added `externalPlugins` and `trustedPlugins` to `KNOWN_CONFIG_KEYS`
- `drone-agent/src/lib.ts` — Exported new public API
- `drone-agent/test/helpers.ts` — Added `addExternalPlugin` to fake engine
- `AGENTS.md` — Added documentation for external plugin loading

### Architecture
- User-scope plugins (`~/.drone-agent/plugins/`) are loaded silently
- Project-scope plugins (`<project>/.drone-agent/plugins/`) require trust on first encounter
- Trust decisions stored in `~/.drone-agent/trusted-plugins.json` (user-scoped)
- Config dir override (`--config-dir`) propagates to plugins directory
- Deferred plugins are prompted for after elicitation setup; skipped in non-interactive modes
- `engine.addExternalPlugin()` adds plugins post-construction with catch-up lifecycle hooks

### Validation
- `pnpm build` passes cleanly
- `pnpm test` passes: 35 test files, 524 tests
