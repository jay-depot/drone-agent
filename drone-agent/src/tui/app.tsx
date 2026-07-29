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
 *   │ Tail region (live-updating items)    │
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
 * auto-cleaned up — plugins pop when they're done.
 *
 * Tail region: all in-flight content (reasoning, tool calls, assistant
 * messages) is rendered as live React components in the tail. When the
 * content completes, it is atomically committed to the <Static> scrollback.
 * This enables parallel tool execution and fixes the soft-wrap color bug.
 *
 * Tool render components: plugins can optionally register a custom JSX
 * component for rendering their tool call state via DroneToolDefinition's
 * `renderComponent` field. When not provided, the default ToolCallProgress
 * (JSON with arrows) is used as fallback.
 */

import { Box, Text, useApp, useInput } from 'ink';
import os from 'node:os';
import path from 'node:path';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AssistantMessageBlock } from './components/AssistantMessageBlock.js';
import { ChatLog } from './components/ChatLog.js';
import { ElicitationPrompt } from './components/ElicitationPrompt.js';
import { InputLine } from './components/InputLine.js';
import { MidPanel } from './components/MidPanel.js';
import { ReasoningBlock } from './components/ReasoningBlock.js';
import { StatusBar } from './components/StatusBar.js';
import { ToolCallProgress } from './components/ToolCallProgress.js';
import { useChatLog } from './hooks/useChatLog.js';
import { useColorOverrides } from './hooks/useColorOverrides.js';
import { useDebouncedWindowSize } from './hooks/useDebouncedWindowSize.js';
import { useElicitation } from './hooks/useElicitation.js';
import { useLlmIndicator } from './hooks/useLlmIndicator.js';
import { useStatusBar } from './hooks/useStatusBar.js';
import { useTailRegion } from './hooks/useTailRegion.js';
import type { DroneTuiOptions, MidPanelWidget } from './types.js';
import type { DroneColorScheme } from './theme.js';
import type { DroneToolDescriptor } from 'drone-core';
import { CANCEL_SENTINEL } from '../runtime/conversation-service.js';
import { preview, PREVIEW_MAX } from './shared/format.js';

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

export function App(opts: DroneTuiOptions): React.JSX.Element {
  const { exit } = useApp();

  // ── Hooks ────────────────────────────────────────────────────────────
  const { scheme, pushColorOverride, popColorOverride } = useColorOverrides();
  const { isLlmActive, llmFrame, setIsLlmActive } = useLlmIndicator();
  const { entries, appendEntry, log } = useChatLog();
  const {
    items: tailItems,
    addItem,
    updateItem,
    commitItem,
    clear: clearTail,
  } = useTailRegion();
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
  useDebouncedWindowSize(120);

  // ── Scheme ref for event listener (avoids stale closure) ────────────
  const schemeRef = useRef<DroneColorScheme>(scheme);
  schemeRef.current = scheme;

  // ── TUI config: syntax highlighting colors and code background ─────
  const tuiConfig = useMemo(() => {
    try {
      return opts.engine.getConfig().tui;
    } catch {
      return undefined;
    }
  }, [opts.engine]);
  const syntaxColors = tuiConfig?.syntaxHighlighting?.colors;
  const codeBackground = tuiConfig?.syntaxHighlighting?.codeBackground;

  // Refs for event listener (avoids stale closure)
  const syntaxColorsRef = useRef<Record<string, string> | undefined>(
    syntaxColors
  );
  syntaxColorsRef.current = syntaxColors;
  const codeBackgroundRef = useRef<string | undefined>(codeBackground);
  codeBackgroundRef.current = codeBackground;

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

  // ── Tail item tracking refs (for event listener) ────────────────────
  const currentReasoningId = useRef<string | null>(null);
  const currentReasoningText = useRef<string>('');
  const currentToolCallIds = useRef<string[]>([]);
  const currentMessageId = useRef<string | null>(null);
  const currentMessageText = useRef<string>('');
  const currentCompactionId = useRef<string | null>(null);

  // Accumulates streaming output lines per in-flight tool call.
  // Keyed by tool canonical name; value holds the tail item id and
  // accumulated lines so the render component can show streaming output.
  const toolProgressRef = useRef<
    Map<string, { id: string; lines: string[]; args: Record<string, unknown> }>
  >(new Map());

  // ── Conversation event listener ─────────────────────────────────────
  // Store callbacks in refs to avoid re-subscribing on every render.
  const logRef = useRef(log);
  logRef.current = log;
  const appendEntryRef = useRef(appendEntry);
  appendEntryRef.current = appendEntry;
  const addItemRef = useRef(addItem);
  addItemRef.current = addItem;
  const updateItemRef = useRef(updateItem);
  updateItemRef.current = updateItem;
  const commitItemRef = useRef(commitItem);
  commitItemRef.current = commitItem;
  const clearTailRef = useRef(clearTail);
  clearTailRef.current = clearTail;

  // Uses the tail region to buffer all in-flight content as live components,
  // then commits them atomically when the content completes. The live
  // component is carried into the <Static> scrollback (as ChatEntry.node),
  // preserving its formatting; toEntry() only supplies a plain-text fallback.
  useEffect(() => {
    const unregister = opts.engine.onConversationEvent?.(event => {
      const s = schemeRef.current;
      const {
        log: logFn,
        appendEntry: appendFn,
        addItem: addFn,
        updateItem: updateFn,
        commitItem: commitFn,
        clearTail: clearFn,
      } = {
        log: logRef.current,
        appendEntry: appendEntryRef.current,
        addItem: addItemRef.current,
        updateItem: updateItemRef.current,
        commitItem: commitItemRef.current,
        clearTail: clearTailRef.current,
      };

      switch (event.kind) {
        case 'reasoning': {
          const trimmed = event.content.trim();
          if (trimmed.length === 0) break;
          currentReasoningText.current = trimmed;
          if (!currentReasoningId.current) {
            const id = addFn(
              'reasoning',
              <ReasoningBlock content={trimmed} scheme={s} />,
              () => ({
                text: `💭 ${currentReasoningText.current}`,
                kind: 'reasoning',
              })
            );
            currentReasoningId.current = id;
          } else {
            updateFn(
              currentReasoningId.current,
              <ReasoningBlock content={trimmed} scheme={s} />,
              () => ({
                text: `💭 ${currentReasoningText.current}`,
                kind: 'reasoning',
              })
            );
          }
          break;
        }
        case 'toolProgress': {
          const entry = toolProgressRef.current.get(event.name);
          if (!entry || !entry.id) break;
          entry.lines.push(event.content);
          const toolDef = opts.engine.getTool(event.name);
          const customRender = toolDef?.renderComponent;
          if (!customRender) break;
          const component = customRender({
            name: event.name,
            arguments: entry.args,
            status: 'running' as const,
            scheme: s as unknown,
            outputLines: [...entry.lines],
            syntaxColors: syntaxColorsRef.current,
            codeBackground: codeBackgroundRef.current,
          }) as React.ReactNode;
          updateItem(entry.id, component, () => ({
            text: `→ ${event.name}`,
            kind: 'toolCall' as const,
          }));
          break;
        }
        case 'reasoningComplete': {
          if (currentReasoningId.current) {
            const entry = commitFn(currentReasoningId.current);
            appendFn(entry);
            currentReasoningId.current = null;
            currentReasoningText.current = '';
          }
          break;
        }
        case 'toolCallBatch': {
          currentToolCallIds.current = event.toolCalls.map(tc => {
            toolProgressRef.current.set(tc.name, {
              id: '',
              lines: [],
              args: tc.arguments,
            });
            // Look up custom render component if registered
            const toolDef = opts.engine.getTool(tc.name);
            const customRender = toolDef?.renderComponent;
            const component = customRender ? (
              (customRender({
                name: tc.name,
                arguments: tc.arguments,
                status: 'running' as const,
                scheme: s as unknown,
                syntaxColors: syntaxColorsRef.current,
                codeBackground: codeBackgroundRef.current,
              }) as React.ReactNode)
            ) : (
              <ToolCallProgress
                name={tc.name}
                args={tc.arguments}
                status="running"
                scheme={s}
              />
            );

            const id = addFn('toolCall', component, () => ({
              text: `→ ${tc.name}(${preview(JSON.stringify(tc.arguments), PREVIEW_MAX)})`,
              kind: 'toolCall',
            }));
            const entry = toolProgressRef.current.get(tc.name);
            if (entry) entry.id = id;
            return id;
          });
          break;
        }
        case 'toolResultBatch': {
          const ids = currentToolCallIds.current;
          // Update each tool call with its result
          for (let i = 0; i < event.results.length; i++) {
            const result = event.results[i];
            const id = ids[i];
            if (id) {
              const isError = result.content.startsWith(
                result.name + ' failed'
              );
              const toolDef = opts.engine.getTool(result.name);
              const customRender = toolDef?.renderComponent;

              const outputLines =
                toolProgressRef.current.get(result.name)?.lines ?? [];

              // Build the live component (custom or default)
              const component = customRender ? (
                (customRender({
                  name: result.name,
                  arguments: result.arguments,
                  result: result.content,
                  status: isError ? ('error' as const) : ('done' as const),
                  scheme: s as unknown,
                  outputLines,
                  syntaxColors: syntaxColorsRef.current,
                  codeBackground: codeBackgroundRef.current,
                }) as React.ReactNode)
              ) : (
                <ToolCallProgress
                  name={result.name}
                  args={result.arguments}
                  result={result.content}
                  status={isError ? 'error' : 'done'}
                  scheme={s}
                />
              );

              // Build a plain-text fallback for the entry (used only if the
              // node fails to render). Truncation is preserved for scrollback.
              const scrollbackText = isError
                ? result.content
                : preview(result.content, PREVIEW_MAX);

              updateFn(id, component, () => ({
                text: isError
                  ? `✗ ${result.name}: ${result.content}`
                  : `← ${result.name}: ${scrollbackText}`,
                kind: isError ? 'error' : 'toolResult',
              }));
            }
          }
          // Commit all tool calls in order
          for (const id of ids) {
            try {
              const entry = commitFn(id);
              appendFn(entry);
            } catch {
              // Item may have been already committed; skip
            }
          }
          currentToolCallIds.current = [];
          toolProgressRef.current.clear();
          break;
        }
        case 'assistantMessage': {
          currentMessageText.current = event.content;
          if (!currentMessageId.current) {
            const id = addFn(
              'assistantMessage',
              <AssistantMessageBlock
                content={event.content}
                scheme={s}
                syntaxColors={syntaxColorsRef.current}
                codeBackground={codeBackgroundRef.current}
              />,
              () => ({
                text: currentMessageText.current,
                kind: 'markdown',
              })
            );
            currentMessageId.current = id;
          } else {
            updateFn(
              currentMessageId.current,
              <AssistantMessageBlock
                content={event.content}
                scheme={s}
                syntaxColors={syntaxColorsRef.current}
                codeBackground={codeBackgroundRef.current}
              />,
              () => ({
                text: currentMessageText.current,
                kind: 'markdown',
              })
            );
          }
          break;
        }
        case 'assistantMessageComplete': {
          if (currentMessageId.current) {
            const entry = commitFn(currentMessageId.current);
            appendFn(entry);
            currentMessageId.current = null;
            currentMessageText.current = '';
          }
          break;
        }
        case 'compaction': {
          if (event.status === 'started') {
            // Clear any previous compaction item that wasn't committed
            if (currentCompactionId.current) {
              try {
                const entry = commitItem(currentCompactionId.current);
                appendEntry(entry);
              } catch {
                // Already committed or removed
              }
            }
            const id = addItem(
              'compaction',
              <Text color={s.compaction}>📦 {event.message}</Text>,
              () => ({
                text: `📦 ${event.message}`,
                kind: 'compaction',
              })
            );
            currentCompactionId.current = id;
          } else {
            // 'completed' or 'failed' — update and commit
            if (currentCompactionId.current) {
              updateItem(
                currentCompactionId.current,
                <Text color={s.compaction}>📦 {event.message}</Text>,
                () => ({
                  text: `📦 ${event.message}`,
                  kind: 'compaction',
                })
              );
              try {
                const entry = commitItem(currentCompactionId.current);
                appendEntry(entry);
              } catch {
                // Already committed or removed
              }
              currentCompactionId.current = null;
            } else {
              // No tail item to update — just log directly
              log(`📦 ${event.message}`, 'compaction');
            }
          }
          break;
        }
        case 'error': {
          // Clear any in-flight tail items on error
          clearFn();
          currentReasoningId.current = null;
          currentReasoningText.current = '';
          currentToolCallIds.current = [];
          toolProgressRef.current.clear();
          currentMessageId.current = null;
          currentMessageText.current = '';
          currentCompactionId.current = null;
          logFn(`Error: ${event.message}`, 'error');
          break;
        }
      }
    });
    return () => unregister?.();
  }, [opts.engine]);

  // ── Slash command handlers ──────────────────────────────────────────
  const runSlashCommand = useCallback(
    async (line: string) => {
      const trimmed = line.trim();
      if (trimmed.length === 0) return;

      log(`> ${trimmed}`, 'user');

      if (trimmed.startsWith('/')) {
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
        const response = await opts.conversation.sendUserMessage(trimmed);

        if (response === CANCEL_SENTINEL) return;
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

  // ── Unified keybindings ──────────────────────────────────────────────
  // Elicitation questions take priority; if none active, fall through to
  // global bindings.
  useInput((inputChar, key) => {
    // ── Elicitation handling (highest priority) ────────────────────────
    if (activeQuestion) {
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
      return;
    }

    // ── Global keybindings (fall through) ─────────────────────────────
    if (key.escape) {
      if (isLlmActive) {
        opts.conversation.cancelCurrentRequest?.();
        log('Cancelled current request.', 'info');
      }
      return;
    }
    if (key.ctrl && inputChar === 'c') {
      exit();
      return;
    }
    if (inputChar === '?' && inputValueRef.current === '') {
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

  // ── LLM working indicator: compute current frame and color ────────
  const llmColor = isLlmActive ? scheme.border : 'gray';

  // ── Render ─────────────────────────────────────────────────────────
  return (
    <Box flexDirection="column" width="100%" height="100%">
      <ChatLog
        entries={entries}
        tailItems={tailItems}
        scheme={scheme}
        syntaxColors={syntaxColors}
        codeBackground={codeBackground}
      />
      <MidPanel widgets={midPanelWidgetsRef.current} scheme={scheme} />
      <InputLine
        value={input}
        onChange={setInput}
        onSubmit={value => {
          setInput('');
          const trimmed = value.trim();
          if (trimmed.length === 0) return;

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

  const commands = opts.engine.getSlashCommands();
  for (const cmd of commands) {
    helpLines.push(`  ${cmd.command.padEnd(20)} ${cmd.description}`);
  }

  log('Help', 'info');
  log(helpLines.join('\n'));
}
