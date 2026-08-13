// ── RuntimeFlagRegistry ──────────────────────────────────────────────
//
// A key-value registry for runtime flags that plugins can set during
// registration. The rendered output is injected into the system prompt
// by the context-budget-service, between config.systemPrompt and plugin
// prompt fragments.
//
// The `plugins` key lists all enabled plugin IDs so the LLM knows what
// plugins are available to filter by in `runtime__list_tools`.
// Other keys render as `key: value` lines.
//
// -----------------------------------------------------------------------

export type RuntimeFlagRegistry = {
  /** Set a flag, overwriting any previous value. */
  set(key: string, value: string): void;
  /** Append a value to a comma-separated flag, with dedup. */
  append(key: string, value: string): void;
  /** Get a flag's value, or undefined if not set. */
  get(key: string): string | undefined;
  /** Check if a flag is set. */
  has(key: string): boolean;
  /** Return all flag entries as a Map. */
  entries(): Map<string, string>;
  /** Render the flags as a system prompt block, or null if empty. */
  render(): string | null;
};

const TOOL_MANAGEMENT_EXPLAINER = `## Tool Management

When you do not have the necessary tool to perform a task, check whether it is available by calling runtime__list_tools. If it is, call runtime__mount_tool to activate it, and it will then be available for you to call. It is strongly recommended to call runtime__unmount_tool when you are done using a tool to free up resources. runtime__list_tools can optionally be filtered by plugin ID. Use the list of enabled plugins given below for valid names to filter by.`;

export function createRuntimeFlagRegistry(): RuntimeFlagRegistry {
  const flags = new Map<string, string>();

  return {
    set(key: string, value: string): void {
      flags.set(key, value);
    },

    append(key: string, value: string): void {
      const existing = flags.get(key);
      if (!existing) {
        flags.set(key, value);
        return;
      }
      const parts = existing.split(', ').filter(p => p !== '');
      if (!parts.includes(value)) {
        parts.push(value);
        flags.set(key, parts.join(', '));
      }
    },

    get(key: string): string | undefined {
      return flags.get(key);
    },

    has(key: string): boolean {
      return flags.has(key);
    },

    entries(): Map<string, string> {
      return new Map(flags);
    },

    render(): string | null {
      if (flags.size === 0) return null;

      const sections: string[] = ['# Runtime Flags'];

      // Always include the tool management explainer
      sections.push(TOOL_MANAGEMENT_EXPLAINER);

      // Render all flags as key: value lines
      const entries = Array.from(flags.entries());
      if (entries.length > 0) {
        sections.push(...entries.map(([key, value]) => `${key}: ${value}`));
      }

      return sections.join('\n\n');
    },
  };
}
