// ── Persona types ──────────────────────────────────────────────────

import type { DroneSkillDefinition } from './skill-types.js';
import type { DroneToolDescriptor } from './session-types.js';
import type {
  DronePersonaProvider,
  DronePersonaWriter,
} from './provider-types.js';

export type DronePersonaDefinition = {
  id: string;
  name: string;
  description: string;
  systemPromptOverride?: string;
  promptFragments?: string[];
  /**
   * Optional TUI color tint. When the persona is active, the TUI cycles
   * this color in as a tint over the base grayscale theme. Any blessed-
   * compatible color string works (named, hex, or 256-color code).
   */
  uiColor?: string;
  /**
   * The scope this persona was loaded from. `'user'` means it came from
   * `~/.drone-agent/personas/`, `'project'` means it came from
   * `<project>/.drone-agent/personas/`.
   */
  scope?: 'user' | 'project' | 'beacon' | 'coordinator';
  /**
   * Optional list of skill ids owned by this persona. Skills are loaded
   * from a `skills/` subdirectory relative to the persona file.
   * @deprecated Skills are now auto-detected from the skills/ subdirectory.
   */
  skillIds?: string[];
  /**
   * Optional glob patterns for filtering which tools the LLM sees when
   * this persona is active. Each pattern is matched against the canonical
   * tool name (e.g. `exec.run`, `mcp.filesystem.read`). Supports `*` and
   * `?` wildcards. Prefix a pattern with `!` to exclude matching tools.
   * When absent, all tools are visible.
   *
   * Example: `['exec.*', 'file.*', '!exec.run']`
   */
  allowedTools?: string[];
  /**
   * Optional glob patterns for filtering which global skills the LLM
   * sees when this persona is active. Each pattern is matched against
   * the skill id. Supports `*` and `?` wildcards. Prefix a pattern with
   * `!` to exclude matching skills. Persona-owned skills (from the
   * `skills/` subdirectory) are always visible regardless of this filter.
   * When absent, all global skills are visible.
   */
  allowedSkills?: string[];
  /**
   * Optional override for the chained tool call limit (session.maxToolIterations).
   * When set, this value is used instead of the configured limit while this
   * persona is active. Useful for personas that need many tool rounds (e.g.
   * a `code` persona) without raising the global safety limit.
   */
  toolCallLimit?: number;
};

/**
 * Capability offered by the persona broker plugin. Lets other plugins
 * query and manage personas, filter tools/skills, and react to persona
 * changes.
 */
export type DronePersonaCapability = {
  getActivePersona: () => DronePersonaDefinition | null;
  getPersonas: () => DronePersonaDefinition[];
  selectPersona: (id: string | null) => void;
  onPersonaChange: (
    callback: (persona: DronePersonaDefinition | null) => void
  ) => void;
  /**
   * Reload persona files from disk. Called by the persona.create
   * workflow after writing a new file, and exposed so other plugins
   * (or tests) can force a refresh.
   */
  reloadPersonas: () => Promise<void>;
  /** Register a persona provider. Providers are sorted by precedence (ascending). */
  registerProvider: (provider: DronePersonaProvider) => void;
  /** Unregister a persona provider by id. */
  unregisterProvider: (providerId: string) => void;
  /** Register a persona writer. Writers are sorted by precedence (ascending). */
  registerWriter: (writer: DronePersonaWriter) => void;
  /** Unregister a persona writer by id. */
  unregisterWriter: (writerId: string) => void;
  /** Get all registered persona writers, sorted by precedence. */
  getWriters: () => DronePersonaWriter[];
  /**
   * Filter a list of tool descriptors based on the active persona's
   * `allowedTools` patterns. Returns all tools when no persona is active
   * or when the persona has no `allowedTools` field.
   */
  getFilteredTools: (allTools: DroneToolDescriptor[]) => DroneToolDescriptor[];
  /**
   * Filter a list of global skills based on the active persona's
   * `allowedSkills` patterns, then append persona-owned skills (which
   * are always visible). Returns all skills when no persona is active
   * or when the persona has no `allowedSkills` field.
   */
  getFilteredSkills: (
    allSkills: DroneSkillDefinition[]
  ) => DroneSkillDefinition[];
};
