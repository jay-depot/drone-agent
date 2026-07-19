// ── ToolMountingCache ───────────────────────────────────────────────
//
// A reusable data structure for managing list/mount style tool collections.
// Stores full DroneToolDefinition objects (including execute functions).
// Methods: addTool, removeTool, replaceTool, mountTool, unmountTool,
// exportMounted, exportAvailable, listAvailable, isMounted.
//
// One instance per server/scope — mount/unmount operations only touch that
// instance's tools, preventing cross-server clobbering.
//
// -----------------------------------------------------------------------

import type {
  DroneToolDefinition,
  DronePluginRegistration,
} from './plugin-system.js';
import { getCanonicalToolName } from './utils.js';

export class ToolMountingCache {
  private available = new Map<string, DroneToolDefinition>();
  private mounted = new Set<string>();
  private readonly pluginId: string;

  /**
   * @param pluginId The plugin ID that owns this cache (e.g. 'mcp').
   *   Used to construct canonical tool names for registration/unregistration.
   */
  constructor(pluginId: string) {
    this.pluginId = pluginId;
  }

  /**
   * Add a tool to the available pool. The `name` parameter is the internal
   * key (e.g. `"echo"`), while `tool.name` is the short name that will be
   * combined with the plugin ID to form the canonical name when registered
   * (e.g. `"mcp__demo__echo"`). The caller is responsible for setting
   * `tool.name` to the short name (e.g. `"demo__echo"`).
   */
  addTool(name: string, tool: DroneToolDefinition): void {
    this.available.set(name, tool);
  }

  /**
   * Remove a tool from the available pool. If the tool was mounted, it is
   * also unmounted (the caller must call `unmountTool` separately to
   * unregister it from the engine; this only removes it from the cache).
   */
  removeTool(name: string): void {
    this.available.delete(name);
    if (this.mounted.has(name)) {
      this.mounted.delete(name);
    }
  }

  /**
   * Replace a tool in the available pool without changing its mount state.
   * If the tool was mounted, the new definition will be used on next mount.
   */
  replaceTool(name: string, tool: DroneToolDefinition): void {
    this.available.set(name, tool);
  }

  /**
   * Mount a tool by registering it with the plugin engine. Returns the
   * tool definition if found and not already mounted, or `undefined` if
   * the tool is not in the available pool.
   */
  mountTool(
    name: string,
    registration: DronePluginRegistration
  ): DroneToolDefinition | undefined {
    const tool = this.available.get(name);
    if (!tool || this.mounted.has(name)) return tool;
    registration.registerTool(tool);
    this.mounted.add(name);
    return tool;
  }

  /**
   * Unmount a tool by unregistering it from the plugin engine. Silently
   * does nothing if the tool was not mounted.
   */
  unmountTool(name: string, registration: DronePluginRegistration): void {
    if (!this.mounted.has(name)) return;
    const tool = this.available.get(name);
    if (tool) {
      const canonicalName = getCanonicalToolName(this.pluginId, tool.name);
      registration.unregisterTool(canonicalName);
    }
    this.mounted.delete(name);
  }

  /**
   * Export all currently mounted tool definitions.
   */
  exportMounted(): DroneToolDefinition[] {
    return Array.from(this.mounted)
      .map(name => this.available.get(name))
      .filter((t): t is DroneToolDefinition => t !== undefined);
  }

  /**
   * Export all available tool definitions (both mounted and unmounted).
   */
  exportAvailable(): DroneToolDefinition[] {
    return Array.from(this.available.values());
  }

  /**
   * List all available tools with their names and descriptions (no schemas).
   * Useful for the `__list_tools` meta-tool response.
   */
  listAvailable(): Array<{ name: string; description: string }> {
    return Array.from(this.available.entries()).map(([name, tool]) => ({
      name,
      description: tool.description,
    }));
  }

  /**
   * Check if a tool is currently mounted.
   */
  isMounted(name: string): boolean {
    return this.mounted.has(name);
  }

  /**
   * Get the canonical mounted tool definition name for a given internal key.
   * Returns `undefined` if the tool is not in the available pool. This lets
   * callers report the actual registered name (which may include a collision
   * disambiguation suffix) without re-deriving it.
   */
  getToolDefName(name: string): string | undefined {
    return this.available.get(name)?.name;
  }
}
