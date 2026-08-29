/**
 * One step in a macro definition.
 * - `slashCommand`: a line starting with `/` that is dispatched as a slash command
 * - `chatPrompt`: any other non-empty, non-comment line sent as a chat message
 */
export type DroneMacroStep =
  { kind: 'slashCommand'; line: string } | { kind: 'chatPrompt'; text: string };

/**
 * A parsed macro definition loaded from a .macro file.
 */
export type DroneMacroDefinition = {
  /** The slash command name, e.g. "/plan" */
  command: string;
  /** Human-readable description (from the #! line or first comment) */
  description: string;
  /** The file path this macro was loaded from */
  filePath: string;
  /** Ordered list of steps to execute */
  steps: DroneMacroStep[];
  /** Whether each positional arg (1..N) is required or optional */
  argSpec: { position: number; required: boolean }[];
  /** Whether $$ (catch-all) is accepted */
  hasCatchAll: boolean;
  /** Whether $$ is optional */
  catchAllOptional: boolean;
};
