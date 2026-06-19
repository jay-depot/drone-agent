/**
 * Ink-based TUI for drone-agent.
 *
 * The previous implementation used `blessed`, which is unmaintained.
 * This module mounts the React `<App>` component from `./app.tsx` via
 * Ink's `render()` and exposes the resulting `Instance` so callers
 * (currently `src/index.ts`) can `waitUntilExit()` to align with
 * `runHooks('onShutdown')` ordering.
 *
 *   ┌──────────────────────────────────────┐
 *   │ Chat log (scrollable)                │
 *   │                                      │
 *   │                                      │
 *   ├──────────────────────────────────────┤
 *   │ Input line                           │
 *   ├──────────────────────────────────────┤
 *   │ model:llama3.1 │ plugins:5 │ ctx:12% │
 *   │                          /home/u/cwd │
 *   └──────────────────────────────────────┘
 *
 * The base theme is grayscale. Plugins (and personas) can push color
 * overrides via the capability exposed by the App component; the TUI
 * cycles through active overrides on a timer. See `tui/theme.ts`.
 */

import { render } from 'ink';
import type { Instance } from 'ink';
import { App } from './app.js';
import type { DroneTuiOptions } from './types.js';

/**
 * Mount the chat TUI. Returns the underlying Ink Instance so callers
 * can `await instance.waitUntilExit()` if they need to align teardown
 * with hook ordering. The blessed version returned `void`; the new
 * shape is strictly more capable.
 */
export function createTui(opts: DroneTuiOptions): Instance {
  // We deliberately do NOT pass `alternateScreen: true`. Default Ink
  // behaviour renders into the normal scrollback, which:
  //   1. Keeps chat history visible after the user quits.
  //   2. Lets users select text with the terminal's native mouse/key
  //      bindings (Shift-drag, triple-click, Cmd+C in iTerm2 / kitty).
  // Alt-screen mode would break both of these.
  return render(<App {...opts} />, { exitOnCtrlC: true });
}
