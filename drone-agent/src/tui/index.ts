/**
 * Minimal blessed-based TUI for drone-agent.
 *
 * Layout:
 *   ┌──────────────────────────────────────┐
 *   │ Chat log (scrollable)                │
 *   │                                      │
 *   │                                      │
 *   ├──────────────────────────────────────┤
 *   │ Input line                           │
 *   └──────────────────────────────────────┘
 *   │ model:llama3.1 │ plugins:5 │ ctx:12% │
 *   └──────────────────────────────────────┘
 *
 * The base theme is grayscale. Plugins (and personas) can push color
 * overrides onto a stack via the TUI capability; the TUI cycles through
 * active overrides on a timer. See `tui/theme.ts` for the palette model.
 */

import blessed from 'blessed';
import type { DroneTuiOptions } from './types.js';
import {
  applyTint,
  colorTag,
  DEFAULT_GRAYSCALE_SCHEME,
  type DroneColorOverride,
  type DroneColorScheme,
} from './theme.js';

/** How long each override gets to be the active tint. */
const COLOR_CYCLE_INTERVAL_MS = 5_000;

function parseJsonInput(raw: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export function createTui(opts: DroneTuiOptions): void {
  const screen = blessed.screen({
    smartCSR: true,
    title: 'drone-agent',
    autoPadding: true,
  });

  // ── Theme + override stack ──────────────────────────────────────────
  // The base scheme is grayscale. Plugins (and the persona plugin, when
  // a persona with uiColor is active) push overrides onto this stack;
  // the TUI cycles through them on a timer. See tui/theme.ts.
  let scheme: DroneColorScheme = { ...DEFAULT_GRAYSCALE_SCHEME };
  const colorOverrides: DroneColorOverride[] = [];
  let activeOverrideIndex = 0;
  let cycleTimer: NodeJS.Timeout | null = null;

  function activeOverride(): DroneColorOverride | null {
    if (colorOverrides.length === 0) return null;
    return colorOverrides[activeOverrideIndex] ?? null;
  }

  function computeScheme(): DroneColorScheme {
    const override = activeOverride();
    if (!override) return DEFAULT_GRAYSCALE_SCHEME;
    return applyTint(DEFAULT_GRAYSCALE_SCHEME, override.tint);
  }

  function restartCycleTimer(): void {
    if (cycleTimer !== null) {
      clearInterval(cycleTimer);
      cycleTimer = null;
    }
    if (colorOverrides.length === 0) return;
    cycleTimer = setInterval(() => {
      if (colorOverrides.length === 0) return;
      activeOverrideIndex =
        (activeOverrideIndex + 1) % colorOverrides.length;
      reapplyTheme();
    }, COLOR_CYCLE_INTERVAL_MS);
  }

  // ── Chat log ──────────────────────────────────────────────────────────
  const chatLog = blessed.log({
    parent: screen,
    top: 0,
    left: 0,
    right: 0,
    bottom: 3,
    scrollable: true,
    alwaysScroll: true,
    scrollbar: {
      ch: ' ',
    },
    tags: true,
    keys: true,
    vi: true,
    mouse: true,
    border: {
      type: 'line',
    },
    style: {
      border: { fg: scheme.border },
    },
  });

  // ── Input box ─────────────────────────────────────────────────────────
  const inputBox = blessed.textbox({
    parent: screen,
    bottom: 1,
    left: 0,
    right: 0,
    height: 1,
    inputOnFocus: true,
    style: {
      bg: scheme.inputBg,
      fg: scheme.inputFg,
    },
  });

  // ── Status bar ───────────────────────────────────────────────────────
  const statusBar = blessed.text({
    parent: screen,
    bottom: 0,
    left: 0,
    right: 0,
    height: 1,
    style: {
      bg: scheme.statusBg,
      fg: scheme.statusFg,
    },
    content: ' loading... ',
  });

  // ── Help overlay ──────────────────────────────────────────────────────
  let helpBoxActive = false;

  function showHelp(): void {
    if (helpBoxActive) return;
    helpBoxActive = true;

    const pluginHelp = opts.engine.getHelpSnippets();
    const personaEnabled = opts.engine
      .listPlugins()
      .some(p => p.id === 'persona' && p.enabled);

    const helpLines: string[] = [
      ' Keybindings:',
      '',
      '  Ctrl+C / Escape   Quit',
      '  F1 / ?            Toggle this help',
      '  PageUp/PageDown   Scroll chat log',
      '',
      ' Slash commands:',
      '',
      '  /help              Show this help',
      '  /clear             Clear session',
      '  /plugins           List enabled plugins',
      '  /model [name]      List models or switch model',
    ];

    if (personaEnabled) {
      helpLines.push(
        '  /persona list      List personas',
        '  /persona select    Switch persona',
        '  /persona current   Show current'
      );
    }

    helpLines.push(
      '  /tool <name>       Run a tool',
      '  /exec <cmd>        Run a command'
    );

    if (pluginHelp.length > 0) {
      helpLines.push('', ' Plugin commands:');
      for (const snippet of pluginHelp) {
        helpLines.push(`  ${snippet}`);
      }
    }

    helpLines.push('', ' Press any key to close.');

    const helpBox = blessed.box({
      parent: screen,
      top: 'center',
      left: 'center',
      width: '60%',
      height: '60%',
      keys: true,
      border: { type: 'line' },
      style: {
        border: { fg: scheme.helpBorder },
        bg: 'black',
        fg: 'white',
      },
      content: helpLines.join('\n'),
    });

    // Use screen.key() to catch close keys.  blessed fires screen.key()
    // handlers *before* the focused element and consumes the event, so
    // the keystroke won't reach the input box (no doubling).
    const closeHelp = () => {
      helpBox.destroy();
      helpBoxActive = false;
      screen.render();
    };
    screen.key(['escape', 'space', 'enter', 'q', 'C-c'], closeHelp);
  }

  // ── Theme application ────────────────────────────────────────────────
  // blessed widgets read style values at render time, so we update the
  // relevant style slots and call screen.render(). Re-styling borders on
  // existing widgets works as expected for fg/bg, but we also need to
  // re-apply `content` for any widget whose content embeds color tags.
  function reapplyTheme(): void {
    scheme = computeScheme();
    chatLog.style.border.fg = scheme.border;
    inputBox.style.bg = scheme.inputBg;
    inputBox.style.fg = scheme.inputFg;
    statusBar.style.bg = scheme.statusBg;
    statusBar.style.fg = scheme.statusFg;
    screen.render();
  }

  function pushColorOverride(override: DroneColorOverride): void {
    // If an override with this id already exists, replace it in place so
    // the order (and therefore the cycle position) is preserved.
    const existingIdx = colorOverrides.findIndex(o => o.id === override.id);
    if (existingIdx !== -1) {
      colorOverrides[existingIdx] = override;
    } else {
      colorOverrides.push(override);
    }
    restartCycleTimer();
    reapplyTheme();
  }

  function popColorOverride(overrideId: string): void {
    const idx = colorOverrides.findIndex(o => o.id === overrideId);
    if (idx === -1) return;
    colorOverrides.splice(idx, 1);
    if (colorOverrides.length === 0) {
      activeOverrideIndex = 0;
    } else if (activeOverrideIndex >= colorOverrides.length) {
      activeOverrideIndex = 0;
    }
    restartCycleTimer();
    reapplyTheme();
  }

  // ── Helpers ───────────────────────────────────────────────────────────
  function log(message: string): void {
    chatLog.log(message);
    screen.render();
  }

  function updateStatusBar(): void {
    const personaCap = opts.engine.getCapability<{
      getActivePersona: () => { name: string } | null;
    }>('persona');
    const persona = personaCap?.getActivePersona();
    const personaLabel = persona ? ` persona:${persona.name}` : '';
    const pluginCount = opts.engine.getRegisteredPluginCount();
    const toolCount = opts.engine.getRegisteredToolCount();
    const currentModel = opts.conversation.getModel();

    opts.conversation
      .getEstimatedContextUsagePercent()
      .then(pct => {
        statusBar.setContent(
          ` model:${currentModel} │ plugins:${pluginCount} │ tools:${toolCount} │ ctx:${pct}%${personaLabel} `
        );
        screen.render();
      })
      .catch(() => {
        statusBar.setContent(
          ` model:${currentModel} │ plugins:${pluginCount} │ tools:${toolCount}${personaLabel} `
        );
        screen.render();
      });
  }

  // ── Handle input ─────────────────────────────────────────────────────
  inputBox.on('submit', async (value: string) => {
    const line = value.trim();
    inputBox.clearValue();
    inputBox.focus();

    if (line.length === 0) return;

    // Log the input
    log(`${colorTag('> ', scheme.userInput)}${line}`);

    if (line === '/exit' || line === '/quit') {
      process.exit(0);
      return;
    }

    if (line === '/help' || line === '?') {
      showHelp();
      return;
    }

    if (line === '/clear') {
      opts.conversation.clearSession();
      chatLog.setContent('');
      log(colorTag('Session cleared.', scheme.info));
      updateStatusBar();
      return;
    }

    if (line === '/plugins') {
      const plugins = opts.engine
        .listPlugins()
        .map(p => {
          const state = p.enabled ? '[enabled]' : '[disabled]';
          return `  - ${p.id} (${p.name}) ${state}`;
        })
        .join('\n');
      log(`${colorTag('Plugins:', scheme.success)}\n${plugins}`);
      updateStatusBar();
      return;
    }

    if (line.startsWith('/model')) {
      const rest = line.slice('/model'.length).trim();
      const ollama = opts.engine.getCapability<{
        listModels: () => Promise<string[]>;
      }>('ollama');

      if (!ollama) {
        log(colorTag('Ollama capability not available.', scheme.error));
        updateStatusBar();
        return;
      }

      if (rest.length === 0) {
        // List models
        try {
          const models = await ollama.listModels();
          const current = opts.conversation.getModel();
          const lines = models.map(m =>
            m === current ? `  * ${m} (current)` : `    ${m}`
          );
          log(`${colorTag('Available models:', scheme.info)}\n${lines.join('\n')}`);
          log(colorTag('Use /model <name> to switch.', scheme.info));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log(colorTag(`Failed to list models: ${msg}`, scheme.error));
        }
      } else {
        // Switch model
        opts.conversation.setModel(rest);
        log(colorTag(`Switched to model: ${rest}`, scheme.success));
        updateStatusBar();
      }
      return;
    }

    if (line.startsWith('/persona ')) {
      try {
        const parts = line.slice('/persona '.length).trim().split(/\s+/);
        const sub = parts[0];
        if (sub === 'list') {
          const result = await opts.engine.executeTool('persona.list', {});
          log(result);
        } else if (sub === 'current') {
          const result = await opts.engine.executeTool('persona.current', {});
          log(result);
        } else if (sub === 'select') {
          const id = parts.slice(1).join(' ');
          if (id) {
            const result = await opts.engine.executeTool('persona.select', {
              id,
            });
            log(result);
          } else {
            log(colorTag('Usage: /persona select <id> (or "none")', scheme.error));
          }
        } else {
          log(colorTag('Unknown persona command.', scheme.error));
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(colorTag(`Error: ${msg}`, scheme.error));
      }
      updateStatusBar();
      return;
    }

    if (line.startsWith('/tool ')) {
      const rest = line.slice('/tool '.length).trim();
      const firstSpace = rest.indexOf(' ');
      const toolName = firstSpace === -1 ? rest : rest.slice(0, firstSpace);
      const rawJson = firstSpace === -1 ? '{}' : rest.slice(firstSpace + 1);
      const parsedInput = parseJsonInput(rawJson);
      if (parsedInput === undefined) {
        log(colorTag(`Invalid JSON: ${rawJson}`, scheme.error));
        return;
      }
      try {
        await opts.engine.runHooks('onBeforePrompt');
        const result = await opts.engine.executeTool(toolName, parsedInput);
        log(result);
        await opts.engine.runHooks('onAfterToolCall');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(colorTag(`Error: ${msg}`, scheme.error));
      }
      updateStatusBar();
      return;
    }

    if (line.startsWith('/exec ')) {
      const command = line.slice('/exec '.length).trim();
      if (!command) {
        log(colorTag('Usage: /exec <command>', scheme.error));
        return;
      }
      try {
        await opts.engine.runHooks('onBeforePrompt');
        const result = await opts.engine.executeTool('exec.run', {
          command,
          cwd: process.cwd(),
        });
        log(result);
        await opts.engine.runHooks('onAfterToolCall');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(colorTag(`Error: ${msg}`, scheme.error));
      }
      updateStatusBar();
      return;
    }

    // Default: send to chat
    try {
      await opts.engine.runHooks('onBeforePrompt');
      let assistantMessageRendered = false;
      const response = await opts.conversation.sendUserMessage(line, event => {
        switch (event.kind) {
          case 'reasoning': {
            const trimmed = event.content.trim();
            if (trimmed.length > 0) {
              log(colorTag(`💭 ${trimmed}`, scheme.reasoning));
            }
            break;
          }
          case 'toolCall': {
            const argsPreview = JSON.stringify(event.arguments);
            const trimmedArgs =
              argsPreview.length > 200
                ? `${argsPreview.slice(0, 200)}…`
                : argsPreview;
            log(colorTag(`→ tool: ${event.name} ${trimmedArgs}`, scheme.toolCall));
            break;
          }
          case 'toolResult': {
            const preview = event.content.replace(/\s+/g, ' ').trim();
            const trimmed =
              preview.length > 200 ? `${preview.slice(0, 200)}…` : preview;
            log(colorTag(`← ${event.name}: ${trimmed}`, scheme.toolResult));
            break;
          }
          case 'assistantMessage': {
            assistantMessageRendered = true;
            log(event.content);
            break;
          }
          case 'error': {
            log(colorTag(`Error: ${event.message}`, scheme.error));
            break;
          }
        }
      });
      // If the loop ended without an assistantMessage event (e.g. an empty
      // response), still surface whatever sendUserMessage returned so the
      // user gets feedback.
      if (!assistantMessageRendered && response.length > 0) {
        log(response);
      }
      await opts.engine.runHooks('onAfterToolCall');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(colorTag(`Error: ${msg}`, scheme.error));
    }
    updateStatusBar();
  });

  // ── Keybindings ───────────────────────────────────────────────────────
  screen.key(['C-c', 'escape'], () => {
    process.exit(0);
  });

  screen.key(['f1', '?'], () => {
    showHelp();
  });

  // ── Persona-driven color override ─────────────────────────────────────
  // When the persona plugin is loaded, push its uiColor (if any) onto the
  // override stack so the active persona tints the base scheme. Pop on
  // switch / clear. Only one persona is active at a time, so we track
  // exactly which override id we last pushed.
  const PERSONA_OVERRIDE_PREFIX = 'persona:';
  let activePersonaOverrideId: string | null = null;

  const personaCap = opts.engine.getCapability<{
    getActivePersona: () => { id: string; uiColor?: string } | null;
    onPersonaChange: (
      callback: (persona: { id: string; uiColor?: string } | null) => void
    ) => void;
  }>('persona');

  if (personaCap) {
    personaCap.onPersonaChange(persona => {
      // Pop the override placed by the previously active persona (if any).
      if (activePersonaOverrideId !== null) {
        popColorOverride(activePersonaOverrideId);
        activePersonaOverrideId = null;
      }

      // Push an override for the newly active persona, when it specifies
      // a tint. Persona uiColor is optional — a persona without one just
      // shows the default grayscale theme (or whatever other plugins push).
      if (persona?.uiColor) {
        activePersonaOverrideId = `${PERSONA_OVERRIDE_PREFIX}${persona.id}`;
        pushColorOverride({
          id: activePersonaOverrideId,
          label: persona.id,
          tint: persona.uiColor,
        });
      }
    });
  }

  // ── Start ─────────────────────────────────────────────────────────────
  log(colorTag(
    'drone-agent TUI ready. Type /help or press F1 for commands.',
    scheme.info
  ));
  updateStatusBar();
  inputBox.focus();
  screen.render();
}
