// ── DebugFlagRegistry ──────────────────────────────────────────────
//
// A shared registry of enabled debug subsystems (e.g. "llm", "tools").
// Created once at startup from the `--debug` CLI flag and passed to both
// the plugin engine and the conversation service so each layer can check
// only the flags it cares about. Mutated at runtime by the `/debug` slash
// command, so toggling a flag takes effect immediately everywhere.
//
// -----------------------------------------------------------------------

export type DebugFlagRegistry = {
  /** Check whether a debug subsystem is currently enabled. */
  isEnabled(name: string): boolean;
  /** Enable a debug subsystem by name (idempotent). */
  enable(name: string): void;
  /** Disable a debug subsystem by name (idempotent). */
  disable(name: string): void;
  /** Return the list of currently enabled subsystem names. */
  list(): string[];
};

export function createDebugFlagRegistry(initial?: string[]): DebugFlagRegistry {
  const enabled = new Set<string>(initial ?? []);

  return {
    isEnabled(name: string): boolean {
      return enabled.has(name);
    },
    enable(name: string): void {
      enabled.add(name);
    },
    disable(name: string): void {
      enabled.delete(name);
    },
    list(): string[] {
      return Array.from(enabled);
    },
  };
}
