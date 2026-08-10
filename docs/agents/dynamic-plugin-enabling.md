# Dynamic Plugin Enabling

The plugin engine supports `enablePlugin(pluginId)` — dynamically enabling and registering a plugin mid-session. This is used by bootstrap workflows to activate recommended plugins immediately after writing config, without requiring a restart.

## Behavior

- Returns `false` if the plugin ID is unknown
- Returns `true` (idempotent) if the plugin is already enabled
- Throws if a non-optional dependency is not enabled
- Registers tools, workflows, hooks, and capabilities
- Runs `onPluginsLoaded` and `onSessionStart` hooks for catch-up

## CLI Flag

The `--plugin` CLI flag enables plugins for the current session by merging plugin IDs into the `enabledPlugins` config before engine initialization. Supports comma-separated names (`--plugin bootstrap,lsp,git`) and repeated flags.
