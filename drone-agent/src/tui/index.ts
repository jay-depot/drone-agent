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
 */

import blessed from 'blessed';
import type { DroneTuiOptions } from './types.js';

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
      border: { fg: 'cyan' },
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
      bg: 'black',
      fg: 'white',
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
      bg: 'blue',
      fg: 'white',
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
        border: { fg: 'yellow' },
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
    log(`{yellow-fg}> {/yellow-fg}${line}`);

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
      log('{cyan-fg}Session cleared.{/cyan-fg}');
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
      log(`{green-fg}Plugins:{/green-fg}\n${plugins}`);
      updateStatusBar();
      return;
    }

    if (line.startsWith('/model')) {
      const rest = line.slice('/model'.length).trim();
      const ollama = opts.engine.getCapability<{
        listModels: () => Promise<string[]>;
      }>('ollama');

      if (!ollama) {
        log('{red-fg}Ollama capability not available.{/red-fg}');
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
          log(`{cyan-fg}Available models:{/cyan-fg}\n${lines.join('\n')}`);
          log('{cyan-fg}Use /model <name> to switch.{/cyan-fg}');
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log(`{red-fg}Failed to list models: ${msg}{/red-fg}`);
        }
      } else {
        // Switch model
        opts.conversation.setModel(rest);
        log(`{green-fg}Switched to model: ${rest}{/green-fg}`);
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
            log('{red-fg}Usage: /persona select <id> (or "none"){/red-fg}');
          }
        } else {
          log('{red-fg}Unknown persona command.{/red-fg}');
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`{red-fg}Error: ${msg}{/red-fg}`);
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
        log(`{red-fg}Invalid JSON: ${rawJson}{/red-fg}`);
        return;
      }
      try {
        await opts.engine.runHooks('onBeforePrompt');
        const result = await opts.engine.executeTool(toolName, parsedInput);
        log(result);
        await opts.engine.runHooks('onAfterToolCall');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`{red-fg}Error: ${msg}{/red-fg}`);
      }
      updateStatusBar();
      return;
    }

    if (line.startsWith('/exec ')) {
      const command = line.slice('/exec '.length).trim();
      if (!command) {
        log('{red-fg}Usage: /exec <command>{/red-fg}');
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
        log(`{red-fg}Error: ${msg}{/red-fg}`);
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
              log(`{magenta-fg}💭 ${trimmed}{/magenta-fg}`);
            }
            break;
          }
          case 'toolCall': {
            const argsPreview = JSON.stringify(event.arguments);
            const trimmedArgs =
              argsPreview.length > 200
                ? `${argsPreview.slice(0, 200)}…`
                : argsPreview;
            log(`{cyan-fg}→ tool: ${event.name} ${trimmedArgs}{/cyan-fg}`);
            break;
          }
          case 'toolResult': {
            const preview = event.content.replace(/\s+/g, ' ').trim();
            const trimmed =
              preview.length > 200 ? `${preview.slice(0, 200)}…` : preview;
            log(`{gray-fg}← ${event.name}: ${trimmed}{/gray-fg}`);
            break;
          }
          case 'assistantMessage': {
            assistantMessageRendered = true;
            log(event.content);
            break;
          }
          case 'error': {
            log(`{red-fg}Error: ${event.message}{/red-fg}`);
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
      log(`{red-fg}Error: ${msg}{/red-fg}`);
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

  // ── Start ─────────────────────────────────────────────────────────────
  log(
    '{cyan-fg}drone-agent TUI ready. Type /help or press F1 for commands.{/cyan-fg}'
  );
  updateStatusBar();
  inputBox.focus();
  screen.render();
}
