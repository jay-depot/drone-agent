/**
 * Theme system for the TUI.
 *
 * The default scheme is intentionally grayscale. Plugins (and personas)
 * can push "color overrides" onto a stack — each override is a single
 * tint color that swaps into the accent slots of the grayscale base.
 * The TUI cycles through the active overrides on a timer; when an
 * override is "done", the plugin that pushed it must pop it.
 *
 * The point of this is delight, not information density — overriding the
 * theme does not change semantics, only visual character.
 */

/**
 * A palette of named roles mapped to blessed color strings.
 *
 * blessed accepts named colors ('red', 'cyan', 'gray'…), 256-color codes
 * ('203'), or hex strings ('#ff8800'). Anything in `string` form works.
 */
export type DroneColorScheme = {
  /** Border color for the chat log. */
  border: string;
  /** Primary accent — chat log border, help border. */
  primary: string;
  /** The user-input prefix `> `. */
  userInput: string;
  /** Generic info / session-level messages. */
  info: string;
  /** Success / "OK" messages. */
  success: string;
  /** Warning messages. */
  warning: string;
  /** Error messages. */
  error: string;
  /** Reasoning text (`💭`). */
  reasoning: string;
  /** Tool call indicator (`→ tool: …`). */
  toolCall: string;
  /** Tool result indicator (`← …`). */
  toolResult: string;
  /** Help overlay border. */
  helpBorder: string;
  /** Status bar background. */
  statusBg: string;
  /** Status bar foreground. */
  statusFg: string;
  /** Input box background. */
  inputBg: string;
  /** Input box foreground. */
  inputFg: string;
};

/**
 * The default grayscale scheme. No hue, just shades. Easy on the eyes,
 * terminal-friendly, never clashes with another plugin's tint.
 */
export const DEFAULT_GRAYSCALE_SCHEME: DroneColorScheme = {
  border: 'gray',
  primary: 'gray',
  userInput: 'white',
  info: 'white',
  success: 'white',
  warning: 'white',
  error: 'white',
  reasoning: 'gray',
  toolCall: 'gray',
  toolResult: 'gray',
  helpBorder: 'gray',
  statusBg: 'black',
  statusFg: 'white',
  inputBg: 'black',
  inputFg: 'white',
};

/**
 * A single color pushed onto the override stack.
 *
 * `id` is how the plugin identifies itself when popping the override,
 * so it should be unique and stable (the plugin id, or a namespaced
 * variant like `persona:researcher`). `tint` is any blessed-compatible
 * color string — the actual color that swaps into the accent slots.
 */
export type DroneColorOverride = {
  id: string;
  label?: string;
  tint: string;
};

/**
 * Apply a tint to a base scheme. The tint replaces the primary accent
 * slots (border, primary, userInput, helpBorder) and leaves the rest
 * grayscale. This keeps overrides legible: a tinted theme still reads
 * as grayscale-with-a-hue rather than a full re-skin.
 */
export function applyTint(
  base: DroneColorScheme,
  tint: string
): DroneColorScheme {
  return {
    ...base,
    border: tint,
    primary: tint,
    userInput: tint,
    helpBorder: tint,
  };
}

/**
 * Wrap `text` with a blessed color tag using `color` as the fg color.
 * e.g. `colorTag('hello', 'red')` → `{red-fg}hello{/red-fg}`.
 *
 * Centralising this keeps the message-rendering code in tui/index.ts
 * from caring about the blessed tag syntax.
 */
export function colorTag(text: string, color: string): string {
  return `{${color}-fg}${text}{/${color}-fg}`;
}
