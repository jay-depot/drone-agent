// ── RuntimeFlagRegistry ──────────────────────────────────────────────
//
// A key-value registry for runtime flags that plugins can set during
// registration. The rendered output is injected into the system prompt
// by the context-budget-service, between config.systemPrompt and plugin
// prompt fragments.
//
// The `list-mount` key gets special treatment: it renders an explainer
// block that teaches the LLM the list/mount pattern and lists the active
// plugins. Other keys render as `key: value` lines.
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

const LIST_MOUNT_EXPLAINER = `## List/Mount Pattern

Some plugin tools use a list-mount pattern to keep context costs low.
Call \`<plugin>__list_tools\` to browse available tools, then
\`<plugin>__mount_tool\` to activate the ones you need. Mounted tools
get their full schemas. Call \`<plugin>__unmount_tool\` when done to
reduce clutter.`;

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

      const listMountValue = flags.get('list-mount');
      if (listMountValue) {
        sections.push(LIST_MOUNT_EXPLAINER);
        sections.push(`Active list-mount plugins: ${listMountValue}`);
      }

      const otherEntries = Array.from(flags.entries()).filter(
        ([key]) => key !== 'list-mount'
      );
      if (otherEntries.length > 0) {
        sections.push(
          ...otherEntries.map(([key, value]) => `${key}: ${value}`)
        );
      }

      return sections.join('\n\n');
    },
  };
}
