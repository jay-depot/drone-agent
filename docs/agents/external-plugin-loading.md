# External Plugin Loading

External plugins can be loaded from well-known directories at both user scope (`~/.drone-agent/plugins/`) and project scope (`<project>/.drone-agent/plugins/`). Each plugin is a directory named `<plugin-id>/` containing at minimum an `index.js` (or `.mjs`) that exports a `DronePlugin` object (either as the default export or as a named export `plugin`).

## Trust Model

- **User-scope plugins** are loaded silently — the user owns their own config.
- **Project-scope plugins** require user trust on first encounter. Trust decisions are persisted to `~/.drone-agent/trusted-plugins.json` (user-scoped, so a project cannot push its own trust).

The trust prompt offers three options:
- **Yes, trust it** — loads the plugin now and on future starts
- **No, skip this time** — skips the plugin for this session only
- **No, and don't ask again** — marks the plugin as untrusted, skipped forever

If the config directory is overridden via `--config-dir`, the user plugins directory follows (e.g., `--config-dir /custom/path` → `/custom/path/.drone-agent/plugins/`).

## Key Files

- `drone-agent/src/plugins/external-loader.ts` — discovery, loading, trust management
- `drone-agent/src/runtime/plugin-engine.ts` — `addExternalPlugin()` method
- `drone-core/src/config-types.ts` — `externalPlugins`, `trustedPlugins` config fields

## Engine Integration

External plugins are discovered before engine creation. User and trusted project plugins are merged with built-in plugins and passed to `createDronePluginEngine()`. Deferred project plugins are prompted for after elicitation is set up, then added via `engine.addExternalPlugin()`.

In non-interactive modes (`--once`, `--output-json`), deferred plugins are silently skipped.
