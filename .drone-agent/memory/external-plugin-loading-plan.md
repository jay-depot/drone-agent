---
key: external-plugin-loading-plan
tags:
  - plan
  - external-plugins
  - plugin-system
created: 2026-06-29T05:24:16.424Z
updated: 2026-06-29T05:24:16.424Z
---

# External Plugin Loading — Implementation Plan

## Summary

Add the ability to load external plugins from well-known directories at both user scope (`~/.drone-agent/plugins/`) and project scope (`<project>/.drone-agent/plugins/`). Project-level plugins require user trust on first encounter, persisted to a user-scoped trust file. The config directory override (`--config-dir`) propagates to the plugins directory.

## Design Decisions

1. **Auto-discovery**: Scan `~/.drone-agent/plugins/` and `<project>/.drone-agent/plugins/` for plugin directories
2. **Plugin format**: Each plugin is a directory named `<plugin-id>/` containing at minimum an `index.js` (or `.mjs`) that exports a `DronePlugin` object
3. **User plugins**: Loaded silently (no trust prompt — user owns their own config)
4. **Project plugins**: Require trust on first encounter; trust persisted to `~/.drone-agent/trusted-plugins.json`
5. **Trust file**: User-scoped JSON file mapping absolute plugin directory paths to `"trusted"` or `"untrusted"`
6. **Config dir override**: If `--config-dir` is provided, the user plugins directory follows (e.g., `--config-dir /custom/path` → `/custom/path/.drone-agent/plugins/`)
7. **New engine method**: `engine.addExternalPlugin(plugin)` to add plugins after engine construction
8. **No `--plugin` path support**: External plugins only load from well-known directories in this iteration

## Files to Modify

### 1. `drone-core/src/config-types.ts`
- Add `externalPlugins` config field to `DroneAgentConfig` and `PartialDroneAgentConfig`
- Add `trustedPlugins` config field (path → status map)
- Update `createDefaultAgentConfig()` and `applyAgentConfigLayer()`

### 2. `drone-core/src/config-schema.ts`
- Add `externalPlugins` and `trustedPlugins` to the TypeBox schema

### 3. `drone-core/src/index.ts`
- Export new types

### 4. `drone-agent/src/runtime/plugin-engine.ts`
- Add `addExternalPlugin()` method to `DronePluginEngine` type and implementation
- Add `addPluginToRegistry()` internal helper

### 5. `drone-agent/src/plugins/external-loader.ts` (NEW)
- `discoverExternalPlugins(userDir, projectDir)` — scans directories, returns `{ userPlugins, projectPlugins }`
- `loadPluginFromDirectory(dirPath)` — dynamically imports `index.js`/`index.mjs`, validates it's a `DronePlugin`
- `loadTrustedPlugins()` / `saveTrustedPlugin()` — read/write `~/.drone-agent/trusted-plugins.json`
- `promptForPluginTrust(plugin, projectDir, elicit)` — interactive trust prompt

### 6. `drone-agent/src/index.tsx`
- After config loading, discover external plugins
- Load user plugins immediately
- Check trust for project plugins; load trusted ones, defer unknowns
- Pass all loaded plugins to `createDronePluginEngine()`
- After engine init + elicitation setup, prompt for deferred plugins

### 7. `drone-agent/src/plugins/index.ts`
- Export `createExternalPluginLoader()` or similar

### 8. `drone-agent/src/lib.ts`
- Export new public types

### 9. `drone-agent/src/plugins/config/index.ts`
- Add `externalPlugins` and `trustedPlugins` to `KNOWN_CONFIG_KEYS`

## Step-by-Step Implementation

### Step 1: Add config types (drone-core)

In `drone-core/src/config-types.ts`:

```typescript
// Add to DroneAgentConfig:
externalPlugins: string[];  // Plugin IDs loaded from external dirs (for tracking)
trustedPlugins: Record<string, 'trusted' | 'untrusted'>;  // path → status

// Update createDefaultAgentConfig():
externalPlugins: [],
trustedPlugins: {},

// Update applyAgentConfigLayer():
externalPlugins: layer.externalPlugins ?? baseConfig.externalPlugins,
trustedPlugins: layer.trustedPlugins
  ? { ...baseConfig.trustedPlugins, ...layer.trustedPlugins }
  : baseConfig.trustedPlugins,
```

### Step 2: Update config schema (drone-core)

In `drone-core/src/config-schema.ts`, add to the `PartialDroneAgentConfigSchema`:

```typescript
externalPlugins: Type.Optional(Type.Array(Type.String())),
trustedPlugins: Type.Optional(
  Type.Record(Type.String(), Type.Union([Type.Literal('trusted'), Type.Literal('untrusted')]))
),
```

### Step 3: Export new types (drone-core)

In `drone-core/src/index.ts`, add the new types to the export list.

### Step 4: Create external plugin loader module (drone-agent)

Create `drone-agent/src/plugins/external-loader.ts`:

```typescript
import { readdir, access, readFile, writeFile, mkdir } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { DronePlugin, DroneElicitation } from 'drone-core';

export type DiscoveredExternalPlugins = {
  userPlugins: DronePlugin[];
  projectPlugins: DronePlugin[];
  deferredProjectPlugins: { plugin: DronePlugin; dirPath: string }[];
};

const PLUGINS_DIR_NAME = 'plugins';
const TRUSTED_PLUGINS_FILE = 'trusted-plugins.json';

function resolveUserPluginsDir(configDir?: string): string {
  const base = configDir ? path.resolve(configDir) : os.homedir();
  return path.join(base, '.drone-agent', PLUGINS_DIR_NAME);
}

function resolveProjectPluginsDir(projectDir: string): string {
  return path.join(projectDir, '.drone-agent', PLUGINS_DIR_NAME);
}

async function pathExists(p: string): Promise<boolean> {
  try { await access(p, fsConstants.F_OK); return true; }
  catch { return false; }
}

async function loadPluginFromDirectory(dirPath: string): Promise<DronePlugin | null> {
  // Try index.js, index.mjs
  for (const name of ['index.js', 'index.mjs']) {
    const entryPath = path.join(dirPath, name);
    if (await pathExists(entryPath)) {
      try {
        const mod = await import(/* @vite-ignore */ entryPath);
        const plugin: DronePlugin | undefined = mod.default ?? mod.plugin;
        if (!plugin || typeof plugin.register !== 'function' || !plugin.metadata) {
          return null;
        }
        return plugin;
      } catch { return null; }
    }
  }
  return null;
}

async function scanPluginsDir(pluginsDir: string): Promise<DronePlugin[]> {
  if (!(await pathExists(pluginsDir))) return [];
  const entries = await readdir(pluginsDir, { withFileTypes: true });
  const results: DronePlugin[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const plugin = await loadPluginFromDirectory(path.join(pluginsDir, entry.name));
      if (plugin) results.push(plugin);
    }
  }
  return results;
}

// Trust file management
function resolveTrustFilePath(): string {
  return path.join(os.homedir(), '.drone-agent', TRUSTED_PLUGINS_FILE);
}

async function loadTrustedPlugins(): Promise<Record<string, 'trusted' | 'untrusted'>> {
  const filePath = resolveTrustFilePath();
  if (!(await pathExists(filePath))) return {};
  try {
    const raw = await readFile(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch { return {}; }
}

async function saveTrustedPlugin(dirPath: string, status: 'trusted' | 'untrusted'): Promise<void> {
  const filePath = resolveTrustFilePath();
  const existing = await loadTrustedPlugins();
  existing[dirPath] = status;
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(existing, null, 2) + '\n', 'utf-8');
}

// Main discovery function
export async function discoverExternalPlugins(
  projectDir: string,
  configDir?: string
): Promise<DiscoveredExternalPlugins> {
  const userPluginsDir = resolveUserPluginsDir(configDir);
  const projectPluginsDir = resolveProjectPluginsDir(projectDir);

  const userPlugins = await scanPluginsDir(userPluginsDir);
  const allProjectPlugins = await scanPluginsDir(projectPluginsDir);

  const trusted = await loadTrustedPlugins();
  const projectPlugins: DronePlugin[] = [];
  const deferredProjectPlugins: { plugin: DronePlugin; dirPath: string }[] = [];

  for (const plugin of allProjectPlugins) {
    // We need to know the dirPath for trust lookup. Re-derive it.
    const dirPath = path.join(projectPluginsDir, plugin.metadata.id);
    const status = trusted[dirPath];
    if (status === 'trusted') {
      projectPlugins.push(plugin);
    } else if (status === 'untrusted') {
      // Skip silently
    } else {
      deferredProjectPlugins.push({ plugin, dirPath });
    }
  }

  return { userPlugins, projectPlugins, deferredProjectPlugins };
}

// Trust prompting
export async function promptForPluginTrust(
  plugin: DronePlugin,
  dirPath: string,
  projectDir: string,
  elicit: DroneElicitation
): Promise<'trusted' | 'untrusted' | 'skip'> {
  const answers = await elicit.ask([{
    id: 'trust',
    prompt: `Project "${path.basename(projectDir)}" wants to load plugin "${plugin.metadata.name}" (${plugin.metadata.id}) from:\n${dirPath}\n\nTrust this plugin?`,
    choices: [
      { value: 'yes', label: 'Yes, trust it' },
      { value: 'no', label: 'No, skip this time' },
      { value: 'never', label: 'No, and never ask again for this project' },
    ],
    defaultValue: 'no',
  }]);

  const choice = answers.trust;
  if (choice === 'yes') {
    await saveTrustedPlugin(dirPath, 'trusted');
    return 'trusted';
  } else if (choice === 'never') {
    await saveTrustedPlugin(dirPath, 'untrusted');
    return 'untrusted';
  } else {
    return 'skip';
  }
}
```

### Step 5: Add `addExternalPlugin()` to the engine

In `drone-agent/src/runtime/plugin-engine.ts`:

1. Add to the `DronePluginEngine` type:
```typescript
addExternalPlugin: (plugin: DronePlugin) => Promise<boolean>;
```

2. Add implementation inside `createDronePluginEngine()`:
```typescript
async function doAddExternalPlugin(plugin: DronePlugin): Promise<boolean> {
  const pluginId = plugin.metadata.id;
  if (pluginMap.has(pluginId)) {
    return false; // Already registered (built-in or duplicate)
  }
  // Add to registry
  pluginMap.set(pluginId, plugin);
  enabledPluginIds.add(pluginId);
  // Register it
  registeredPlugins.push(await registerPlugin(plugin));
  // Run catch-up lifecycle hooks
  for (const callback of hookBuckets.onPluginsLoaded) {
    await callback();
  }
  for (const callback of hookBuckets.onSessionStart) {
    await callback();
  }
  return true;
}
```

3. Add to the return object:
```typescript
addExternalPlugin: doAddExternalPlugin,
```

### Step 6: Wire into main entry point

In `drone-agent/src/index.tsx`, after config loading and before engine creation:

```typescript
// Discover external plugins
const { userPlugins, projectPlugins, deferredProjectPlugins } =
  await discoverExternalPlugins(process.cwd(), invocation.options.configDir);

// Combine all plugins
const allPlugins = [
  ...createBuiltInPlugins({...}),
  ...userPlugins,
  ...projectPlugins,
];

// Create engine with all plugins
const engine = createDronePluginEngine({
  plugins: allPlugins,
  config: resolvedConfig.config,
  logger,
  runtimeOptions: {...},
});
```

Then, after engine initialization and elicitation setup, prompt for deferred plugins:

```typescript
// After elicitation is set up, handle deferred project plugins
if (deferredProjectPlugins.length > 0) {
  const elicit = engine.getElicitation();
  if (elicit) {
    for (const { plugin, dirPath } of deferredProjectPlugins) {
      const result = await promptForPluginTrust(plugin, dirPath, process.cwd(), elicit);
      if (result === 'trusted') {
        await engine.addExternalPlugin(plugin);
      }
      // 'untrusted' and 'skip' both mean don't load
    }
  }
}
```

### Step 7: Update config plugin known keys

In `drone-agent/src/plugins/config/index.ts`, add to `KNOWN_CONFIG_KEYS`:
```typescript
'externalPlugins',
'trustedPlugins',
```

### Step 8: Update lib.ts exports

In `drone-agent/src/lib.ts`, export the new loader:
```typescript
export { discoverExternalPlugins, promptForPluginTrust } from './plugins/external-loader.js';
export type { DiscoveredExternalPlugins } from './plugins/external-loader.js';
```

### Step 9: Add tests

Create `drone-agent/test/external-loader.test.ts`:

- Test `loadPluginFromDirectory()` with a temp directory containing a valid plugin
- Test `loadPluginFromDirectory()` with missing/invalid plugin
- Test `scanPluginsDir()` with mixed content
- Test `loadTrustedPlugins()` / `saveTrustedPlugin()` round-trip
- Test `discoverExternalPlugins()` with user and project plugins
- Test trust filtering (trusted, untrusted, unknown)
- Test `engine.addExternalPlugin()` adds tools and runs hooks

### Step 10: Update AGENTS.md

Add documentation about external plugin loading to `AGENTS.md`.

## Validation Criteria

1. All LSP checks pass (no TypeScript errors)
2. `pnpm build` succeeds for all packages
3. `pnpm test` passes (all existing + new tests)
4. Manual verification:
   - Create a valid external plugin in `~/.drone-agent/plugins/test-plugin/index.js`
   - Start drone-agent — plugin should be loaded and its tools available
   - Create a project-level plugin in `<project>/.drone-agent/plugins/project-plugin/index.js`
   - Start drone-agent in that project — should prompt for trust
   - Select "Yes" — plugin loads; subsequent starts load silently
   - Select "No, and never ask again" — plugin skipped; subsequent starts skip silently
   - Verify `~/.drone-agent/trusted-plugins.json` is created with correct entries
   - Verify `--config-dir /custom/path` causes user plugins to be loaded from `/custom/path/.drone-agent/plugins/`
5. Edge cases:
   - Empty plugins directories (no crash)
   - Invalid plugin files (graceful skip, no crash)
   - Duplicate plugin IDs between external and built-in (external is rejected, no crash)
   - Non-interactive mode (`--once`): deferred plugins are silently skipped (no hang)
