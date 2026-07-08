/**
 * External plugin loader — discovers, loads, and manages trust for plugins
 * from well-known directories at user scope (~/.drone-agent/plugins/) and
 * project scope (<project>/.drone-agent/plugins/).
 *
 * User-scope plugins are loaded silently (the user owns their own config).
 * Project-scope plugins require user trust on first encounter, persisted to
 * ~/.drone-agent/trusted-plugins.json.
 *
 * If the config directory is overridden via --config-dir, the user plugins
 * directory follows (e.g. --config-dir /custom/path → /custom/path/.drone-agent/plugins/).
 */

import { readdir, access, readFile, writeFile, mkdir } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { DronePlugin, DroneElicitation } from 'drone-core';

// ── Constants ───────────────────────────────────────────────────────

const PLUGINS_DIR_NAME = 'plugins';
const TRUSTED_PLUGINS_FILE = 'trusted-plugins.json';

// ── Public types ─────────────────────────────────────────────────────

export type DiscoveredExternalPlugins = {
  /** Plugins loaded from the user-scope directory (loaded silently). */
  userPlugins: DronePlugin[];
  /** Project-scope plugins that are already trusted (loaded immediately). */
  projectPlugins: DronePlugin[];
  /** Project-scope plugins with no trust decision yet (deferred for prompting). */
  deferredProjectPlugins: { plugin: DronePlugin; dirPath: string }[];
};

// ── Internal helpers ────────────────────────────────────────────────

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the user-scope plugins directory.
 * If configDir is provided, use that as the base instead of the home directory.
 */
function resolveUserPluginsDir(configDir?: string): string {
  const base = configDir ? path.resolve(configDir) : os.homedir();
  return path.join(base, '.drone-agent', PLUGINS_DIR_NAME);
}

/**
 * Resolve the project-scope plugins directory.
 */
function resolveProjectPluginsDir(projectDir: string): string {
  return path.join(projectDir, '.drone-agent', PLUGINS_DIR_NAME);
}

/**
 * Resolve the path to the trusted-plugins.json file (always user-scoped).
 */
function resolveTrustFilePath(): string {
  return path.join(os.homedir(), '.drone-agent', TRUSTED_PLUGINS_FILE);
}

// ── Plugin loading ──────────────────────────────────────────────────

/**
 * Load a single plugin from a directory by dynamically importing its
 * index.js or index.mjs file. Returns null if the directory does not
 * contain a valid plugin entry point.
 *
 * The imported module must export a `DronePlugin` object either as the
 * default export or as a named export `plugin`.
 */
export async function loadPluginFromDirectory(
  dirPath: string
): Promise<DronePlugin | null> {
  for (const name of ['index.js', 'index.mjs']) {
    const entryPath = path.join(dirPath, name);
    if (await pathExists(entryPath)) {
      try {
        // Read the file content and use a data URL to bypass vite-node's
        // resolver (vitest v3 intercepts dynamic import() and cannot resolve
        // files outside the project root).
        const content = await readFile(entryPath, 'utf-8');
        const dataUrl = `data:text/javascript,${encodeURIComponent(content)}`;
        const mod = await import(dataUrl);
        const plugin: DronePlugin | undefined = mod.default ?? mod.plugin;
        if (
          !plugin ||
          typeof plugin.register !== 'function' ||
          !plugin.metadata
        ) {
          return null;
        }
        return plugin;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * Scan a plugins directory and load all valid plugins from its subdirectories.
 * Returns an empty array if the directory does not exist.
 */
async function scanPluginsDir(pluginsDir: string): Promise<DronePlugin[]> {
  if (!(await pathExists(pluginsDir))) {
    return [];
  }

  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(pluginsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const results: DronePlugin[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirPath = path.join(pluginsDir, entry.name);
    const plugin = await loadPluginFromDirectory(dirPath);
    if (plugin) {
      results.push(plugin);
    }
  }
  return results;
}

// ── Trust file management ──────────────────────────────────────────

/**
 * Load the trusted-plugins.json file from the user's .drone-agent directory.
 * Returns an empty object if the file does not exist or is corrupt.
 */
export async function loadTrustedPlugins(): Promise<
  Record<string, 'trusted' | 'untrusted'>
> {
  const filePath = resolveTrustFilePath();
  if (!(await pathExists(filePath))) {
    return {};
  }
  try {
    const raw = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      return {};
    }
    // Validate and sanitize entries
    const result: Record<string, 'trusted' | 'untrusted'> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (value === 'trusted' || value === 'untrusted') {
        result[key] = value;
      }
    }
    return result;
  } catch {
    return {};
  }
}

/**
 * Save a trust decision for a plugin directory path to the user's
 * trusted-plugins.json file. Creates the file if it does not exist.
 */
export async function saveTrustedPlugin(
  dirPath: string,
  status: 'trusted' | 'untrusted'
): Promise<void> {
  const filePath = resolveTrustFilePath();
  const existing = await loadTrustedPlugins();
  existing[dirPath] = status;
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(existing, null, 2) + '\n', 'utf-8');
}

// ── Main discovery ─────────────────────────────────────────────────

/**
 * Discover external plugins from both user and project scope directories.
 *
 * User-scope plugins are returned in `userPlugins` (always loaded).
 * Project-scope plugins are split into:
 *   - `projectPlugins`: already trusted (loaded immediately)
 *   - `deferredProjectPlugins`: no trust decision yet (deferred for prompting)
 *
 * Project-scope plugins that are explicitly untrusted are silently skipped.
 *
 * @param projectDir - The project directory to scan for project-scope plugins.
 * @param configDir - Optional override for the user config directory.
 */
export async function discoverExternalPlugins(
  projectDir: string,
  configDir?: string
): Promise<DiscoveredExternalPlugins> {
  const userPluginsDir = resolveUserPluginsDir(configDir);
  const projectPluginsDir = resolveProjectPluginsDir(projectDir);

  const [userPlugins, allProjectPlugins] = await Promise.all([
    scanPluginsDir(userPluginsDir),
    scanPluginsDir(projectPluginsDir),
  ]);

  const trusted = await loadTrustedPlugins();
  const projectPlugins: DronePlugin[] = [];
  const deferredProjectPlugins: { plugin: DronePlugin; dirPath: string }[] = [];

  for (const plugin of allProjectPlugins) {
    const dirPath = path.join(projectPluginsDir, plugin.metadata.id);
    const status = trusted[dirPath];
    if (status === 'trusted') {
      projectPlugins.push(plugin);
    } else if (status === 'untrusted') {
      // Silently skip
    } else {
      // Unknown — defer for prompting
      deferredProjectPlugins.push({ plugin, dirPath });
    }
  }

  return { userPlugins, projectPlugins, deferredProjectPlugins };
}

// ── Trust prompting ────────────────────────────────────────────────

/**
 * Prompt the user to trust a project-scope plugin.
 *
 * @returns 'trusted' if the user chose to trust it,
 *          'untrusted' if the user chose to never ask again,
 *          'skip' if the user chose to skip this time.
 */
export async function promptForPluginTrust(
  plugin: DronePlugin,
  dirPath: string,
  projectDir: string,
  elicit: DroneElicitation
): Promise<'trusted' | 'untrusted' | 'skip'> {
  const answers = await elicit.ask([
    {
      id: 'trust',
      prompt: `Project "${path.basename(projectDir)}" wants to load plugin "${plugin.metadata.name}" (${plugin.metadata.id}) from:\n${dirPath}\n\nTrust this plugin?`,
      choices: [
        { value: 'yes', label: 'Yes, trust it' },
        { value: 'no', label: 'No, skip this time' },
        { value: 'never', label: "No, and don't ask again for this project" },
      ],
      defaultValue: 'no',
    },
  ]);

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
