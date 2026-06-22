---
name: ui-architecture
description: 'A description of drone-agent''s ui architecture and how to work with it'
recall:
  - you are going to work on the drone-agent TUI's Ink components
model-invocation: true
---
# Ui-architecture

## Overview

This skill describes the Ink-based TUI architecture for `drone-agent`. The TUI is built with [Ink 5.x](https://github.com/vadimdemedes/ink) (React for CLIs) and replaces a previous `blessed`-based implementation. It renders a four-region layout (five when elicitation is active): a scrollable chat log, a mid panel, an input line, an optional elicitation prompt, and a status bar. The TUI deliberately avoids the alternate screen buffer so chat history remains in the terminal scrollback after exit.

## Architecture

### Entry point

`src/tui/index.tsx` — mounts the `<App>` component via `ink`'s `render()` and returns the `Instance` so callers can `await instance.waitUntilExit()`. The `createTui(opts)` function is called from `src/index.tsx` (the main CLI entry point).

### Component tree

```
<App>                              (src/tui/app.tsx)
├── <ChatLog>                      (src/tui/components/ChatLog.tsx)
├── <MidPanel>                     (src/tui/components/MidPanel.tsx)
├── <InputLine>                    (src/tui/components/InputLine.tsx)
│   └── <MultilineTextInput>      (src/tui/components/MultilineTextInput.tsx)
├── <ElicitationPrompt>            (inline in app.tsx)
│   └── <FreeformPrompt>          (inline in app.tsx)
│       └── <FreeformInput>        (inline in app.tsx)
└── <StatusBar>                    (src/tui/components/StatusBar.tsx)
```

### Layout

Four (or five) regions stacked vertically via `flexDirection="column"`:

```
┌──────────────────────────────────────┐
│ Chat log (scrollable via <Static>)   │
│                                      │
├──────────────────────────────────────┤
│ TODO: 3/5 │ Insights: 12            │
├──────────────────────────────────────┤
│ Input line                           │
├──────────────────────────────────────┤
│ [Elicitation prompt — shown when     │
│  a workflow asks a question]         │
├──────────────────────────────────────┤
│ Status bar (model | plugins | pwd)   │
└──────────────────────────────────────┘
```

The mid panel is a full-width horizontal bar between the chat log and input line. It renders widget content inline with ` │ ` separators. It only appears when at least one widget has non-empty content.

### Key design decisions

1. **No alternate screen** — `render(<App />, { exitOnCtrlC: true })` without `alternateScreen: true`. Keeps chat visible after quit and allows native text selection.

2. **`<Static>` for chat log** — Past entries use Ink's `<Static>` component so they never reflow. Only new entries are appended. This avoids flicker and keeps scroll position stable.

3. **Custom `MultilineTextInput`** — Replaces `ink-text-input`'s `TextInput` to support multi-line input via Ctrl+J (linefeed). Enter alone submits; Ctrl+J inserts a newline. Arrow keys navigate the cursor. The cursor is rendered as an inverse block.

4. **Color override stack** — The base theme is grayscale (`DEFAULT_GRAYSCALE_SCHEME`). The persona plugin pushes `DroneColorOverride` objects onto a stack via a direct subscription to `onPersonaChange` in `app.tsx`. The TUI cycles through active overrides on a 5-second timer. Only three accent slots (border, primary, userInput) are swapped; the rest stay grayscale. Overrides are NOT auto-cleaned — plugins must pop them.

   **Note:** The `DroneTuiCapability` type is defined in `types.ts` but is **not** offered as a runtime capability. There is no generic `engine.getCapability('tui')` path. Color overrides are currently only wired for the persona plugin. If a new plugin needs to push an override, wire it directly in `app.tsx` (similar to the persona `useEffect`).

5. **Elicitation** — Workflows/plugins can ask the user questions via `DroneElicitation`. The TUI renders an inline picker (arrow-key-driven numbered list) or freeform text input just above the status bar. The `askQuestion` callback returns a Promise that resolves when the user commits. Only one question is active at a time.

6. **Mid-panel widgets** — Plugins register mid-panel content by offering a `MidPanelWidget` as their plugin capability. Each widget has an `id`, `label`, and `getContent()` returning lines to render. Empty content hides the widget. The `App` component discovers widgets by iterating a hardcoded list of known plugin IDs (`['todo', 'self-improvement']`) and calling `engine.getCapability<MidPanelWidget>(pluginId)`. The todo plugin (summary: `TODO: [completed] / [total]`) and self-improvement plugin (insight count) are the primary consumers.

   **Note:** The `registerMidPanelWidget` callback exists in `app.tsx` but is only called from the hardcoded discovery effect, not by plugins directly. To add a new mid-panel widget, add the plugin's ID to the hardcoded list in `app.tsx` and have the plugin offer the widget as its capability via `registration.offer(...)`.

7. **Global keybindings** — `useInput` in App handles Esc/Ctrl+C (quit), `?` (help when input is empty). Note: the help text mentions F1 but there is no F1 keybinding (Ink's `useInput` does not provide an `f1` flag). The elicitation `useInput` handles arrow keys, Enter, number shortcuts, and Esc/Ctrl+C for the active question.

### Theme system

Defined in `src/tui/theme.tsx`:

- `DroneColorScheme` — 14 named color roles (border, primary, userInput, info, success, warning, error, reasoning, toolCall, toolResult, statusBg, statusFg, inputBg, inputFg).
- `DEFAULT_GRAYSCALE_SCHEME` — All grayscale, no hue.
- `applyTint(base, tint)` — Replaces border, primary, and userInput with the tint color.
- `ColorTag` — `<Text color={color}>{children}</Text>` wrapper for consistent color application.

### Types

Defined in `src/tui/types.ts`:

- `MidPanelWidget` — `{ id, label, getContent: () => string[] }`
- `DroneTuiCapability` — `{ pushColorOverride, popColorOverride, registerMidPanelWidget }` (defined but **not offered** as a runtime capability; see notes above)
- `DroneTuiOptions` — The full options object passed to `createTui()`, containing `engine`, `conversation`, `model`, and `logger` references.

### Chat log entries

`ChatEntry` has `id` (stable React key), `kind` (info|user|reasoning|toolCall|toolResult|error|plain|success), and `text`. Each kind maps to a color from the scheme via `renderEntry()`.

### Model picker

`ModelPicker` (in `src/tui/components/ModelPicker.tsx`) is a standalone Ink component rendered *before* the chat TUI during first-run setup. It's mounted via its own `render()` call and unmounted after selection, so it doesn't conflict with the chat TUI's raw mode.

## Patterns and conventions

### Adding a new component

1. Create the file in `src/tui/components/`.
2. Import Ink primitives (`Box`, `Text`, `useInput`, `useStdout`, etc.) from `'ink'`.
3. Import `DroneColorScheme` from `'../theme.js'` and use `ColorTag` for colored text.
4. Export a function component. Use `JSX.Element` as the return type.
5. Import and use in `app.tsx`.

### Using the theme

```tsx
import { ColorTag, type DroneColorScheme } from '../theme.js';

function MyComponent({ scheme }: { scheme: DroneColorScheme }): JSX.Element {
  return (
    <Box>
      <ColorTag color={scheme.primary}>Hello</ColorTag>
    </Box>
  );
}
```

### Adding a new chat entry kind

1. Add the kind string to `ChatEntry['kind']` union in `ChatLog.tsx`.
2. Add a case to `renderEntry()` in `ChatLog.tsx`.
3. Add a color slot to `DroneColorScheme` in `theme.tsx`.
4. Add the default color to `DEFAULT_GRAYSCALE_SCHEME`.
5. Use `log(text, 'yourKind')` in `app.tsx`.

### Pushing a color override from a plugin

Color overrides are currently only wired for the persona plugin. To add a new one, add a `useEffect` in `app.tsx` that subscribes to the plugin's capability and calls `pushColorOverride`/`popColorOverride` directly:

```tsx
// In app.tsx:
useEffect(() => {
  const myPluginCap = opts.engine.getCapability<MyPluginCap>('my-plugin');
  if (!myPluginCap) return;
  myPluginCap.onChange((active) => {
    if (active) {
      pushColorOverride({ id: 'my-plugin', tint: '#ff8800' });
    } else {
      popColorOverride('my-plugin');
    }
  });
}, [opts.engine, pushColorOverride, popColorOverride]);
```

### Registering a mid-panel widget from a plugin

Plugins offer their widget as a capability under their own plugin ID. The TUI discovers it by iterating a hardcoded list of known widget plugin IDs in `app.tsx`.

**In the plugin:**
```ts
registration.offer({
  id: 'my-widget',
  label: 'Stats',
  getContent: () => ['line 1', 'line 2'],
});
```

**In `app.tsx`:** Add the plugin's ID to the hardcoded list:
```ts
const knownWidgetPluginIds = ['todo', 'self-improvement', 'my-widget'];
```

### Wiring elicitation

The App wires elicitation on mount via `opts.engine.setElicitation(...)`. The `askQuestion` callback updates React state to show the picker/input and returns a Promise. The user's answer is committed via `commitAnswer(value)` or cancelled via `cancelQuestion()`.

### Testing

Use `ink-testing-library` for component tests. See `ink-testing-library` docs for `render()` and `StdinContext` patterns. The `ModelPicker` is a good candidate for unit testing.

## Examples

### Example: Adding a "typing indicator" to the chat log

The `ChatLog` component accepts an optional `tail` prop (`ReactNode`) rendered above the static entries. This is used for in-flight content that updates without re-rendering the log. **Note:** The `tail` prop is currently not passed by `App` — it's available for future use:

```tsx
<ChatLog entries={entries} tail={<Text dimColor>Agent is thinking...</Text>} scheme={scheme} />
```

### Example: Custom status bar item

The `StatusBar` component receives `left` and `cwd` strings. To add a new status item, modify the `statusLeft` construction in `app.tsx`:

```tsx
const statusLeft = ` model:${model} │ plugins:${pluginCount} │ tools:${toolCount} │ ctx:${ctxPct ?? '?'}%${personaLabel} │ myItem:${myValue} `;
```

### Example: Handling a new slash command

Add a new `if` branch in `runSlashCommand` in `app.tsx`:

```tsx
if (trimmed === '/mystats') {
  log(`Some stats here`, 'info');
  return;
}
```

Then add it to `printHelp()` so it appears in the help output.
