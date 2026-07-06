import type React from 'react';
/**
 * Root TUI component for drone-agent.
 *
 * Four regions stacked vertically:
 *
 *   ┌──────────────────────────────────────┐
 *   │ Chat log (scrollable via <Static>)   │
 *   │                                      │
 *   ├──────────────────────────────────────┤
 *   │ Mid panel (widgets)                  │
 *   ├──────────────────────────────────────┤
 *   │ Input line                           │
 *   ├──────────────────────────────────────┤
 *   │ Status bar (model | plugins | pwd)   │
 *   └──────────────────────────────────────┘
 *
 * The TUI manages a stack of color overrides (one per plugin) and
 * cycles through them on a 5s timer. Pushed overrides are not
 * auto-cleaned up — plugins pop when they're done (see
 * `DroneTuiCapability.popColorOverride`).
 *
 * The default base scheme is grayscale; only the three accent slots
 * (border, primary, userInput) get swapped out by an active override,
 * keeping the rest legible regardless of the tint.
 */

import { Box, useApp, useInput } from 'ink';
import os from 'node:os';
import path from 'node:path';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChatLog } from './components/ChatLog.js';
import { ElicitationPrompt } from './components/ElicitationPrompt.js';
import { InputLine } from './components/InputLine.js';
import { MidPanel } from './components/MidPanel.js';
import { StatusBar } from './components/StatusBar.js';
import { useChatLog } from './hooks/useChatLog.js';
import { useColorOverrides } from './hooks/useColorOverrides.js';
import { useDebouncedWindowSize } from './hooks/useDebouncedWindowSize.js';
import { useElicitation } from './hooks/useElicitation.js';
import { useLlmIndicator } from './hooks/useLlmIndicator.js';
import { useStatusBar } from './hooks/useStatusBar.js';
import type { DroneTuiOptions, MidPanelWidget } from './types.js';
import type { DroneToolDescriptor } from 'drone-core';
import { CANCEL_SENTINEL } from '../runtime/conversation-service.js';

/** Maximum chars rendered in a tool argument or result preview. */
const PREVIEW_MAX = 200;

/** ANSI color codes for diff output */
const ANSI = {
  red: '\x1b[31m',
  green: '\x1b[32m',
  reset: '\x1b[0m',
};

/** Build a prompt label like `drone> ` or `unix-beard> `. */
function buildPromptLabel(opts: DroneTuiOptions): string {
  const persona = opts.engine
    .getCapability<{
      getActivePersona: () => { name: string } | null;
    }>('persona')
    ?.getActivePersona();
  if (persona) {
    return `${persona.name.toLowerCase().replace(/\s+/g, '-')}> `;
  }
  return 'drone> ';
}

function shortHomePath(cwd: string): string {
  const home = os.homedir();
  if (cwd === home) return '~';
  if (cwd.startsWith(home + path.sep)) {
    return '~' + cwd.slice(home.length);
  }
  return cwd;
}

function preview(text: string, max = PREVIEW_MAX): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function tryParseJson(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      return parsed as Record<string, unknown>;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Format a diff result for display with colored +/- indicators and line numbers.
 * Expected format: JSON with { path, written } or similar success marker,
 * or the raw diff content from git diff.
 */
function formatDiffResult(content: string): string {
  // Try to parse as JSON first to detect apply_diff results
  const parsed = tryParseJson(content);
  if (parsed && typeof parsed === 'object') {
    // Check if it's a file.apply_diff result
    const obj = parsed as Record<string, unknown>;
    if (
      obj.path !== undefined &&
      (obj.written === true || obj.patched === true)
    ) {
      return `✓ Applied diff to ${obj.path}`;
    }
    // If it's a git diff result, it might have a 'diff' field
    if (obj.diff && typeof obj.diff === 'string') {
      return formatDiffOutput(obj.diff);
    }
  }

  // If content looks like a diff, format it
  if (content.includes('---') || content.includes('@@')) {
    return formatDiffOutput(content);
  }

  // Fall back to showing raw content
  return content;
}

/**
 * Format diff output with colored +/- prefixes and line numbers.
 * Uses ANSI escape codes for red (deletions) and green (additions).
 */
function formatDiffOutput(diff: string): string {
  const lines = diff.split('\n');
  const output: string[] = [];
  let lineNum = 0;

  for (const line of lines) {
    lineNum++;
    if (line.startsWith('+')) {
      // Green for additions
      output.push(
        `${ANSI.green}+${ANSI.reset}${String(lineNum).padStart(4)} │ ${ANSI.green}${line}${ANSI.reset}`
      );
    } else if (line.startsWith('-')) {
      // Red for deletions
      output.push(
        `${ANSI.red}-${ANSI.reset}${String(lineNum).padStart(4)} │ ${ANSI.red}${line}${ANSI.reset}`
      );
    } else if (line.startsWith('@@')) {
      // Hunk header - keep as is with line number
      output.push(` ${String(lineNum).padStart(4)} │ ${line}`);
    } else if (
      line.startsWith('diff ') ||
      line.startsWith('index ') ||
      line.startsWith('---') ||
      line.startsWith('+++')
    ) {
      // Metadata lines - neutral
      output.push(` ${String(lineNum).padStart(4)} │ ${line}`);
    } else {
      // Context lines
      output.push(` ${String(lineNum).padStart(4)} │ ${line}`);
    }
  }

  return output.join('\n');
}

/**
 * Format an exec.run result to show full command and full output without truncation.
 */
function formatExecResult(
  arguments_: Record<string, unknown>,
  content: string
): string {
  const command = arguments_.command as string | undefined;
  const cwd = arguments_.cwd as string | undefined;

  // Build output with full command
  const lines: string[] = [];

  if (cwd) {
    lines.push(`$ cd ${cwd} && ${command}`);
  } else {
    lines.push(`$ ${command}`);
  }

  lines.push('');

  // Add full output without truncation
  lines.push(content);

  return lines.join('\n');
}

export function App(opts: DroneTuiOptions): React.JSX.Element {
  const { exit } = useApp();

  // ── Hooks ────────────────────────────────────────────────────────────
  const { scheme, pushColorOverride, popColorOverride } = useColorOverrides();
  const { isLlmActive, llmFrame, setIsLlmActive } = useLlmIndicator();
  const { entries, log } = useChatLog();
  const {
    activeQuestion,
    pickerIndex,
    setPickerIndex,
    commitAnswer,
    cancelQuestion,
  } = useElicitation(opts.engine);
  const { ctxPct, cwd } = useStatusBar(
    opts.conversation.getEstimatedContextUsagePercent,
    entries.length
  );
  // Debounce resize events to reduce flicker during window-drag gestures.
  const _debounced = useDebouncedWindowSize(120);

  // ── Mid-panel widget state ────────────────────────────────────────────
  const midPanelWidgetsRef = useRef<MidPanelWidget[]>([]);

  // Discover mid-panel widgets from plugin capabilities on mount.
  useEffect(() => {
    const knownWidgetPluginIds = ['todo', 'focus'];
    for (const pluginId of knownWidgetPluginIds) {
      const widget = opts.engine.getCapability<MidPanelWidget>(pluginId);
      if (widget) {
        const existingIdx = midPanelWidgetsRef.current.findIndex(
          w => w.id === widget.id
        );
        if (existingIdx !== -1) {
          midPanelWidgetsRef.current[existingIdx] = widget;
        } else {
          midPanelWidgetsRef.current.push(widget);
        }
      }
    }
  }, [opts.engine]);

  // ── Input line state ────────────────────────────────────────────────
  const [input, setInput] = useState<string>('');
  const inputValueRef = useRef<string>('');
  inputValueRef.current = input;

  // ── Conversation event listener ─────────────────────────────────────
  // Register a single listener that logs all conversation events with
  // proper ChatEntry kinds. This handles events from any source (regular
  // messages, macro chatPrompt steps, etc.) with correct color-coding.
  useEffect(() => {
    const unregister = opts.engine.onConversationEvent?.(event => {
      switch (event.kind) {
        case 'reasoning': {
          const trimmed = event.content.trim();
          if (trimmed.length > 0) {
            log(`💭 ${trimmed}`, 'reasoning');
          }
          break;
        }
        case 'toolCall': {
          const argsPreview = preview(
            JSON.stringify(event.arguments),
            PREVIEW_MAX
          );
          log(`→ tool: ${event.name} ${argsPreview}`, 'toolCall');
          break;
        }
        case 'toolResult': {
          let resultContent: string;

          // Special handling for exec.run - full output, no truncation
          if (event.name === 'exec__run') {
            resultContent = formatExecResult(
              event.arguments,
              event.content
            );
            log(`← ${event.name}:\n${resultContent}`, 'toolResult');
          }
          // Special handling for file.apply_diff - formatted diff display
          else if (
            event.name === 'file__apply_diff' ||
            event.name === 'git__diff'
          ) {
            resultContent = formatDiffResult(event.content);
            log(`← ${event.name}:\n${resultContent}`, 'toolResult');
          }
          // Default: truncated preview
          else {
            resultContent = preview(event.content, PREVIEW_MAX);
            log(`← ${event.name}: ${resultContent}`, 'toolResult');
          }
          break;
        }
        case 'assistantMessage': {
          log(event.content, 'plain');
          break;
        }
        case 'error': {
          log(`Error: ${event.message}`, 'error');
          break;
        }
      }
    });
    return () => unregister?.();
  }, [opts.engine, log]);

  // ── Slash command handlers ──────────────────────────────────────────
  const runSlashCommand = useCallback(
    async (line: string) => {
      const trimmed = line.trim();
      if (trimmed.length === 0) return;

      log(`> ${trimmed}`, 'user');

      if (trimmed.startsWith('/')) {
        // Dispatch through engine (checks plugin commands, then built-ins).
        // Wrap in setIsLlmActive so the thinking indicator activates during
        // macro execution and other slash commands that call sendUserMessage.
        setIsLlmActive(true);
        try {
          const handled = await opts.engine.dispatchSlashCommand(trimmed, {
            logger: {
              info: msg => log(msg, 'user'),
              warn: msg => log(msg, 'error'),
              error: msg => log(msg, 'error'),
            },
            engine: opts.engine,
            conversation: opts.conversation,
            sessionManager: undefined,
            exit: () => exit(),
            printHelp: () => printHelp(opts, log),
          });
          if (handled) return;
          // Unrecognized slash command.
          log(
            `Unknown command: ${trimmed}. Type /help for available commands.`,
            'error'
          );
          return;
        } finally {
          setIsLlmActive(false);
        }
      }

      // Regular chat message
      setIsLlmActive(true);
      try {
        await opts.engine.runHooks('onBeforePrompt');
        // No onEvent callback needed — the conversation event listener
        // registered above handles all event types with proper color-coding.
        const response = await opts.conversation.sendUserMessage(trimmed);

        // Handle cancellation sentinel
        if (response === CANCEL_SENTINEL) {
          // Cancelled — hooks already ran after the last tool round.
          // Don't log anything extra; don't run onAfterToolCall again.
          return;
        }

        if (response.length > 0) {
          log(response, 'plain');
        }
        await opts.engine.runHooks('onAfterToolCall');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`Error: ${msg}`, 'error');
      } finally {
        setIsLlmActive(false);
      }
    },
    [opts, log, exit, setIsLlmActive]
  );

  // ── Global keybindings ──────────────────────────────────────────────
  useInput((input, key) => {
    if (key.escape) {
      // ESC when LLM is active → soft cancel
      if (isLlmActive) {
        opts.conversation.cancelCurrentRequest?.();
        log('Cancelled current request.', 'info');
      }
      // ESC when idle is a no-op — Ctrl-C is the only exit route
      return;
    }
    if (key.ctrl && input === 'c') {
      exit();
      return;
    }
    if (input === '?' && inputValueRef.current === '') {
      printHelp(opts, log);
    }
  });

  // ── Persona-driven color override ─────────────────────────────────
  useEffect(() => {
    const personaCap = opts.engine.getCapability<{
      getActivePersona: () => { id: string; uiColor?: string } | null;
      onPersonaChange: (
        callback: (persona: { id: string; uiColor?: string } | null) => void
      ) => void;
    }>('persona');
    if (!personaCap) return;
    const PERSONA_OVERRIDE_PREFIX = 'persona:';
    let activePersonaOverrideId: string | null = null;
    personaCap.onPersonaChange(persona => {
      if (activePersonaOverrideId !== null) {
        popColorOverride(activePersonaOverrideId);
        activePersonaOverrideId = null;
      }
      if (persona?.uiColor) {
        activePersonaOverrideId = `${PERSONA_OVERRIDE_PREFIX}${persona.id}`;
        pushColorOverride({
          id: activePersonaOverrideId,
          label: persona.id,
          tint: persona.uiColor,
        });
      }
    });
  }, [opts.engine, pushColorOverride, popColorOverride]);

  // ── Status bar content ─────────────────────────────────────────────
  const model = opts.conversation.getModel();
  const pluginCount = opts.engine.getRegisteredPluginCount();
  const totalTools = opts.engine.getRegisteredToolCount();
  const allToolsDescs = opts.engine.listTools();
  const personaCapForTools = opts.engine.getCapability<{
    getFilteredTools?: (tools: DroneToolDescriptor[]) => DroneToolDescriptor[];
  }>('persona');
  const availableTools = personaCapForTools?.getFilteredTools
    ? personaCapForTools.getFilteredTools(allToolsDescs).length
    : allToolsDescs.filter(t => !t.defaultHidden).length;
  const personaLabel = useMemo(() => {
    const persona = opts.engine
      .getCapability<{
        getActivePersona: () => { name: string } | null;
      }>('persona')
      ?.getActivePersona();
    return persona ? ` persona:${persona.name}` : '';
  }, [opts.engine]);
  const statusLeft = ` model:${model} │ plugins:${pluginCount} │ tools:${availableTools}/${totalTools} │ ctx:${
    ctxPct ?? '?'
  }%${personaLabel} `;

  // ── Elicitation useInput ──────────────────────────────────────────
  useInput((inputChar, key) => {
    if (!activeQuestion) return;
    if (key.ctrl && inputChar === 'c') {
      cancelQuestion();
      return;
    }
    if (activeQuestion.freeform) {
      if (key.escape) {
        cancelQuestion();
      }
      return;
    }
    const choices = activeQuestion.choices ?? [];
    if (key.upArrow) {
      setPickerIndex(prev => (prev - 1 + choices.length) % choices.length);
      return;
    }
    if (key.downArrow) {
      setPickerIndex(prev => (prev + 1) % choices.length);
      return;
    }
    if (key.return) {
      const choice = choices[pickerIndex];
      if (choice) commitAnswer(choice.value);
      return;
    }
    if (/^[1-9]$/.test(inputChar)) {
      const idx = Number.parseInt(inputChar, 10) - 1;
      if (idx >= 0 && idx < choices.length) {
        commitAnswer(choices[idx].value);
      }
    }
  });

  // ── LLM working indicator: compute current frame and color ────────
  const llmColor = isLlmActive ? scheme.border : 'gray';

  // ── Render ─────────────────────────────────────────────────────────
  return (
    <Box flexDirection="column" width="100%" height="100%">
      <ChatLog entries={entries} scheme={scheme} />
      <MidPanel widgets={midPanelWidgetsRef.current} scheme={scheme} />
      <InputLine
        value={input}
        onChange={setInput}
        onSubmit={value => {
          setInput('');
          const trimmed = value.trim();
          if (trimmed.length === 0) return;

          // When the LLM is active, route differently:
          //   - /cancel fires immediately
          //   - all other input is queued for the next loop boundary
          if (isLlmActive) {
            if (trimmed === '/cancel') {
              opts.conversation.cancelCurrentRequest?.();
              log('Cancelled current request.', 'info');
              return;
            }
            opts.conversation.enqueueUserMessage?.(trimmed);
            log(`> ${trimmed}`, 'user');
            return;
          }

          // Normal path: fire runSlashCommand (when LLM is idle)
          void runSlashCommand(value);
        }}
        scheme={scheme}
        promptLabel={buildPromptLabel(opts)}
        llmFrame={llmFrame}
        llmColor={llmColor}
        disabled={activeQuestion !== null}
      />
      {activeQuestion ? (
        <ElicitationPrompt
          question={activeQuestion}
          pickerIndex={pickerIndex}
          scheme={scheme}
          onSubmit={commitAnswer}
        />
      ) : null}
      <StatusBar
        left={statusLeft}
        cwd={` ${shortHomePath(cwd)} `}
        scheme={scheme}
      />
    </Box>
  );
}

function printHelp(
  opts: DroneTuiOptions,
  log: (text: string, kind?: import('./types.js').ChatEntry['kind']) => void
): void {
  const helpLines: string[] = [
    'Keybindings:',
    '',
    '  Ctrl+C            Quit',
    '  Escape            Cancel current request (when LLM is active)',
    '  F1 / ?            Show this help',
    '  Ctrl+J            Insert newline in multi-line input',
    '',
    'Text selection:',
    '',
    "  Use your terminal's native selection (Shift-drag in GNOME Terminal",
    '  and WezTerm, mouse drag in iTerm2 / kitty). Ink does not use the',
    '  alternate screen buffer, so chat history stays in scrollback.',
    '',
    'Slash commands:',
    '',
  ];

  // Dynamically list all slash commands from the engine (built-in + plugin).
  const commands = opts.engine.getSlashCommands();
  for (const cmd of commands) {
    helpLines.push(`  ${cmd.command.padEnd(20)} ${cmd.description}`);
  }

  log('Help', 'info');
  log(helpLines.join('\n'));
}
/**
 * @internal Exposed for unit tests. Not part of the public API.
 */
export const __testing = {
  formatDiffResult,
};
