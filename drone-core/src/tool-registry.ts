// ── ToolRegistry ─────────────────────────────────────────────────────
//
// Central registry for all tool definitions. Replaces both the engine's
// internal Map<string, DroneToolDefinition> and the per-plugin
// ToolMountingCache instances. Tracks mount state per tool so the
// engine can expose only mounted tools to the LLM.
//
// -----------------------------------------------------------------------

import type { DroneToolDefinition } from './plugin-system.js';
import type { DroneToolDescriptor } from './session-types.js';

export class ToolRegistry {
  private tools = new Map<
    string,
    { definition: DroneToolDefinition; mounted: boolean }
  >();

  /**
   * Add a tool to the registry. The `canonicalName` is the full
   * `pluginId__toolName` string. Tools start unmounted.
   */
  add(canonicalName: string, tool: DroneToolDefinition): void {
    this.tools.set(canonicalName, { definition: tool, mounted: false });
  }

  /**
   * Remove a tool from the registry by canonical name. Silently does
   * nothing if the tool is not found.
   */
  remove(canonicalName: string): void {
    this.tools.delete(canonicalName);
  }

  /**
   * Mount a tool, making it visible to the LLM. Returns the tool
   * definition if found and not already mounted, or `undefined` if
   * the tool is not in the registry.
   */
  mount(canonicalName: string): DroneToolDefinition | undefined {
    const entry = this.tools.get(canonicalName);
    if (!entry || entry.mounted) return undefined;
    entry.mounted = true;
    return entry.definition;
  }

  /**
   * Unmount a tool, hiding it from the LLM. Silently does nothing if
   * the tool was not mounted or not found.
   */
  unmount(canonicalName: string): void {
    const entry = this.tools.get(canonicalName);
    if (!entry) return;
    entry.mounted = false;
  }

  /**
   * Check if a tool is currently mounted.
   */
  isMounted(canonicalName: string): boolean {
    return this.tools.get(canonicalName)?.mounted ?? false;
  }

  /**
   * Get a tool definition by canonical name, or `undefined` if not found.
   */
  get(canonicalName: string): DroneToolDefinition | undefined {
    return this.tools.get(canonicalName)?.definition;
  }

  /**
   * List all currently mounted tools as `DroneToolDescriptor` objects
   * (suitable for passing to the LLM).
   */
  listMounted(): DroneToolDescriptor[] {
    const result: DroneToolDescriptor[] = [];
    for (const [canonicalName, entry] of this.tools) {
      if (entry.mounted) {
        result.push({
          name: canonicalName,
          description: entry.definition.description,
          inputSchema: entry.definition.inputSchema,
          defaultHidden: entry.definition.defaultHidden,
        });
      }
    }
    return result;
  }

  /**
   * List all unmounted tools with their names and descriptions (no schemas).
   * Optionally filter by plugin ID (e.g. "file" returns only tools whose
   * canonical name starts with "file__").
   */
  listUnmounted(
    pluginFilter?: string
  ): Array<{ name: string; description: string }> {
    const result: Array<{ name: string; description: string }> = [];
    for (const [canonicalName, entry] of this.tools) {
      if (entry.mounted) continue;
      if (pluginFilter && !canonicalName.startsWith(`${pluginFilter}__`))
        continue;
      result.push({
        name: canonicalName,
        description: entry.definition.description,
      });
    }
    return result;
  }

  /**
   * List all unmounted tools with full schemas as `DroneToolDescriptor`
   * objects. Optionally filter by plugin ID.
   */
  listUnmountedWithSchemas(pluginFilter?: string): DroneToolDescriptor[] {
    const result: DroneToolDescriptor[] = [];
    for (const [canonicalName, entry] of this.tools) {
      if (entry.mounted) continue;
      if (pluginFilter && !canonicalName.startsWith(`${pluginFilter}__`))
        continue;
      result.push({
        name: canonicalName,
        description: entry.definition.description,
        inputSchema: entry.definition.inputSchema,
        defaultHidden: entry.definition.defaultHidden,
      });
    }
    return result;
  }

  /**
   * Return the number of currently mounted tools.
   */
  getMountedCount(): number {
    let count = 0;
    for (const entry of this.tools.values()) {
      if (entry.mounted) count++;
    }
    return count;
  }

  /**
   * Return the total number of tools in the registry (mounted + unmounted).
   */
  getTotalCount(): number {
    return this.tools.size;
  }

  /**
   * Return the set of plugin IDs that have registered tools, derived from
   * canonical names (everything before the first `__`).
   */
  getPluginIds(): string[] {
    const ids = new Set<string>();
    for (const canonicalName of this.tools.keys()) {
      const pluginId = canonicalName.split('__')[0];
      if (pluginId) ids.add(pluginId);
    }
    return Array.from(ids).sort();
  }

  /**
   * Remove all tools whose canonical name starts with the given prefix.
   * Returns the number of tools removed. Used by the engine to unregister
   * all tools for a given plugin.
   */
  removeByPrefix(prefix: string): number {
    let count = 0;
    for (const canonicalName of this.tools.keys()) {
      if (canonicalName.startsWith(prefix)) {
        this.tools.delete(canonicalName);
        count++;
      }
    }
    return count;
  }
}
