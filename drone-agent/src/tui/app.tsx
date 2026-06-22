/**
 * Root TUI component for drone-agent.
 *
 * Mirrors the layout of the old blessed-based TUI (chat log / input /
 * status bar) using Ink. Three regions stacked vertically:
 *
 *   ┌──────────────────────────────────────┐
 *   │ Chat log (scrollable via <Static>)   │
 *   │                                      │
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

import { Box, Text, useApp, useInput } from 'ink';
import os from 'node:os';
import path from 'node:path';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DroneElicitationQuestion } from 'drone-core';
import { ChatLog, type ChatEntry } from './components/ChatLog.js';
import { InputLine } from './components/InputLine.js';
import { Sidebar } from './components/Sidebar.js';
import { StatusBar } from './components/StatusBar.js';
import {
  ColorTag,
  DEFAULT_GRAYSCALE_SCHEME,
  applyTint,
  type DroneColorOverride,
  type DroneColorScheme,
} from './theme.js';
import { createTuiElicitation } from './elicitation.js';
import type { DroneTuiOptions, SidebarWidget } from './types.js';

/** How long each override gets to be the active tint. */
const COLOR_CYCLE_INTERVAL_MS = 5_000;

/** Maximum chars rendered in a tool argument or result preview. */
const PREVIEW_MAX = 200;

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

export function App(opts: DroneTuiOptions): JSX.Element {
  const { exit } = useApp();

  // ── Theme + override stack ──────────────────────────────────────────
  // The base scheme is grayscale. Plugins (and the persona plugin, when
  // a persona with uiColor is active) push overrides onto this stack;
  // the TUI cycles through them on a timer.
  const [overrides, setOverrides] = useState<DroneColorOverride[]>([]);
  const [activeIndex, setActiveIndex] = useState<number>(0);
  const activeOverride = overrides[activeIndex];
  const scheme: DroneColorScheme = useMemo(() => {
    if (!activeOverride) return DEFAULT_GRAYSCALE_SCHEME;
    return applyTint(DEFAULT_GRAYSCALE_SCHEME, activeOverride.tint);
  }, [activeOverride]);

  // Cycle timer: bump the active index every COLOR_CYCLE_INTERVAL_MS.
  // The original blessed TUI did exactly this; we preserve behavior.
  useEffect(() => {
    if (overrides.length === 0) return;
    const id = setInterval(() => {
      setActiveIndex(prev => (prev + 1) % overrides.length);
    }, COLOR_CYCLE_INTERVAL_MS);
    return () => clearInterval(id);
  }, [overrides.length]);

  // If overrides get popped and the active index is now out of range,
  // wrap it back to 0. Without this, the cycle would index past the
  // end and crash on `overrides[activeIndex]`.
  useEffect(() => {
    if (overrides.length === 0) {
      if (activeIndex !== 0) setActiveIndex(0);
    } else if (activeIndex >= overrides.length) {
      setActiveIndex(0);
    }
  }, [overrides.length, activeIndex]);

  const pushColorOverride = useCallback((override: DroneColorOverride) => {
    setOverrides(prev => {
      const existingIdx = prev.findIndex(o => o.id === override.id);
      if (existingIdx !== -1) {
        // Replace in place so the order (and therefore the cycle
        // position) is preserved.
        const next = prev.slice();
        next[existingIdx] = override;
        return next;
      }
      return [...prev, override];
    });
  }, []);

  const popColorOverride = useCallback((overrideId: string) => {
    setOverrides(prev => {
      const idx = prev.findIndex(o => o.id === overrideId);
      if (idx === -1) return prev;
      const next = prev.slice();
      next.splice(idx, 1);
      return next;
    });
    // If the active index is now beyond the new stack, wrap to 0.
    // The dependency on `overrides.length` is fine because we're
    // recomputing based on the current value; setState is a no-op if
    // the new index equals the previous one.
  }, []);

  // ── Sidebar widget state ──────────────────────────────────────────
  const [sidebarWidgets, setSidebarWidgets] = useState<SidebarWidget[]>([]);
  const registerSidebarWidget = useCallback((widget: SidebarWidget) => {
    setSidebarWidgets(prev => {
      const existingIdx = prev.findIndex(w => w.id === widget.id);
      if (existingIdx !== -1) {
        const next = prev.slice();
        next[existingIdx] = widget;
        return next;
      }
      return [...prev, widget];
    });
  }, []);

  // Discover sidebar widgets from plugin capabilities on mount.
  useEffect(() => {
    const knownWidgetPluginIds = ['todo'];
    for (const pluginId of knownWidgetPluginIds) {
      const widget = opts.engine.getCapability<SidebarWidget>(pluginId);
      if (widget) {
        registerSidebarWidget(widget);
      }
    }
  }, [opts.engine, registerSidebarWidget]);
  // ── Chat log state ──────────────────────────────────────────────────
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  // Monotonic id counter, kept in a ref so it survives across renders
  // without triggering re-renders itself.
  const entryIdCounter = useRef<number>(0);
  const appendEntry = useCallback(
    (entry: Omit<ChatEntry, 'id'>) => {
      entryIdCounter.current += 1;
      const id = `e${Date.now()}-${entryIdCounter.current}`;
      setEntries(prev => [...prev, { ...entry, id }]);
    },
    [entryIdCounter]
  );

  // Helper for the slash-command handlers so they share one logging path.
  const log = useCallback(
    (text: string, kind: ChatEntry['kind'] = 'plain') => {
      // Multi-line strings become one entry; the renderer doesn't
      // split on \n, so callers can use a single entry with literal
      // newlines and Ink wraps naturally.
      appendEntry({ text, kind });
    },
    [appendEntry]
  );

  // ── Input line state ───────────────────────────────────────────────
  const [input, setInput] = useState<string>('');
  // Mirror `input` into a ref so the global useInput handler can read
  // the current value without having to close over it (which would
  // re-bind the handler on every keystroke).
  const inputValueRef = useRef<string>('');
  inputValueRef.current = input;

  // ── Elicitation state ──────────────────────────────────────────────
  // When a workflow / plugin asks the user a question, we render an
  // inline picker or text input just above the status bar. The active
  // question lives in state; its pending promise lives in a ref so the
  // `askQuestion` callback can resolve it once the user picks/submits.
  const [activeQuestion, setActiveQuestion] = useState<
    (DroneElicitationQuestion & { uiKey: string }) | null
  >(null);
  const [pickerIndex, setPickerIndex] = useState<number>(0);
  const questionResolveRef = useRef<((value: string) => void) | null>(null);
  const questionRejectRef = useRef<((reason: Error) => void) | null>(null);

  // Wire the elicitation capability exactly once on mount. The
  // `askQuestion` callback updates React state and returns a Promise
  // that resolves when the user commits an answer (or rejects on
  // unmount so in-flight workflows don't hang).
  useEffect(() => {
    if (!opts.engine.setElicitation) return;
    const askQuestion = (
      question: DroneElicitationQuestion
    ): Promise<string> => {
      // If a question is already active, reject the previous one to
      // avoid hangs. The wizard only asks one question at a time, so
      // this is a defensive guard.
      if (questionResolveRef.current) {
        const prev = questionRejectRef.current;
        questionResolveRef.current = null;
        questionRejectRef.current = null;
        if (prev) prev(new Error('Superseded by a new elicitation question.'));
      }
      const uiKey = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      setPickerIndex(0);
      setActiveQuestion({ ...question, uiKey });
      return new Promise<string>((resolve, reject) => {
        questionResolveRef.current = resolve;
        questionRejectRef.current = reject;
      });
    };
    opts.engine.setElicitation(createTuiElicitation({ askQuestion }));
    return () => {
      // Reject any in-flight question on unmount so the wizard's
      // promise chain unwinds cleanly instead of hanging.
      if (questionResolveRef.current) {
        const reject = questionRejectRef.current;
        questionResolveRef.current = null;
        questionRejectRef.current = null;
        if (reject)
          reject(new Error('TUI unmounted before question was answered.'));
      }
      opts.engine.setElicitation?.(undefined);
    };
  }, [opts.engine]);

  const commitAnswer = useCallback((answer: string) => {
    const resolve = questionResolveRef.current;
    questionResolveRef.current = null;
    questionRejectRef.current = null;
    setActiveQuestion(null);
    setPickerIndex(0);
    if (resolve) resolve(answer);
  }, []);

  const cancelQuestion = useCallback(() => {
    const reject = questionRejectRef.current;
    questionResolveRef.current = null;
    questionRejectRef.current = null;
    setActiveQuestion(null);
    setPickerIndex(0);
    if (reject) reject(new Error('Elicitation cancelled.'));
  }, []);

  // ── Status bar state ───────────────────────────────────────────────
  const [ctxPct, setCtxPct] = useState<number | null>(null);
  const [cwd, setCwd] = useState<string>(process.cwd());
  const promptLabel = buildPromptLabel(opts);

  // Refresh ctx% and cwd on a soft interval (and after every message
  // submit). cwd is cheap to read but we still coalesce to one timer
  // so we don't pile up microtasks.
  useEffect(() => {
    let cancelled = false;
    const refresh = (): void => {
      setCwd(process.cwd());
      opts.conversation
        .getEstimatedContextUsagePercent()
        .then(pct => {
          if (!cancelled) setCtxPct(pct);
        })
        .catch(() => {
          if (!cancelled) setCtxPct(null);
        });
    };
    refresh();
    const id = setInterval(refresh, 5_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [opts.conversation, entries.length]);

  // ── Slash command handlers ──────────────────────────────────────────
  // The blessed version had these inline; we extract them to keep App
  // readable. Each handler appends to the chat log via `log` and
  // returns when done. Errors are surfaced as `error` entries.
  const runSlashCommand = useCallback(
    async (line: string) => {
      const trimmed = line.trim();
      if (trimmed.length === 0) return;

      log(`> ${trimmed}`, 'user');

      if (trimmed === '/exit' || trimmed === '/quit') {
        exit();
        return;
      }

      if (trimmed === '/help' || trimmed === '?') {
        printHelp(opts, log);
        return;
      }

      if (trimmed === '/clear') {
        await opts.engine.runHooks('onSessionClear');
        opts.conversation.clearSession();
        log('Session cleared.', 'info');
        return;
      }

      if (trimmed === '/plugins') {
        const plugins = opts.engine
          .listPlugins()
          .map(p => {
            const state = p.enabled ? '[enabled]' : '[disabled]';
            return `  - ${p.id} (${p.name}) ${state}`;
          })
          .join('\n');
        log(`Plugins:\n${plugins}`, 'success');
        return;
      }

      if (
        await opts.engine.dispatchSlashCommand?.(trimmed, {
          logger: {
            info: msg => log(msg, 'plain'),
            warn: msg => log(msg, 'error'),
            error: msg => log(msg, 'error'),
          },
          engine: opts.engine,
          conversation: opts.conversation,
          sessionManager: undefined,
        })
      ) {
        return;
      }

      if (trimmed.startsWith('/tool ')) {
        const rest = trimmed.slice('/tool '.length).trim();
        const firstSpace = rest.indexOf(' ');
        const toolName = firstSpace === -1 ? rest : rest.slice(0, firstSpace);
        const rawJson = firstSpace === -1 ? '{}' : rest.slice(firstSpace + 1);
        const parsed = tryParseJson(rawJson);
        if (parsed === undefined) {
          log(`Invalid JSON: ${rawJson}`, 'error');
          return;
        }
        try {
          await opts.engine.runHooks('onBeforePrompt');
          log(await opts.engine.executeTool(toolName, parsed));
          await opts.engine.runHooks('onAfterToolCall');
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log(`Error: ${msg}`, 'error');
        }
        return;
      }

      if (trimmed.startsWith('/exec ')) {
        const command = trimmed.slice('/exec '.length).trim();
        if (!command) {
          log('Usage: /exec <command>', 'error');
          return;
        }
        try {
          await opts.engine.runHooks('onBeforePrompt');
          log(
            await opts.engine.executeTool('exec.run', {
              command,
              cwd: process.cwd(),
            })
          );
          await opts.engine.runHooks('onAfterToolCall');
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log(`Error: ${msg}`, 'error');
        }
        return;
      }

      // Default: send to chat.
      try {
        await opts.engine.runHooks('onBeforePrompt');
        let assistantRendered = false;
        const response = await opts.conversation.sendUserMessage(
          trimmed,
          event => {
            switch (event.kind) {
              case 'reasoning': {
                const trimmedReasoning = event.content.trim();
                if (trimmedReasoning.length > 0) {
                  log(`💭 ${trimmedReasoning}`, 'reasoning');
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
                const resultPreview = preview(event.content, PREVIEW_MAX);
                log(`← ${event.name}: ${resultPreview}`, 'toolResult');
                break;
              }
              case 'assistantMessage': {
                assistantRendered = true;
                log(event.content, 'plain');
                break;
              }
              case 'error': {
                log(`Error: ${event.message}`, 'error');
                break;
              }
            }
          }
        );
        // If the loop ended without an assistantMessage event, surface
        // the return value so the user gets feedback.
        if (!assistantRendered && response.length > 0) {
          log(response, 'plain');
        }
        await opts.engine.runHooks('onAfterToolCall');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`Error: ${msg}`, 'error');
      }
    },
    [opts, log, exit]
  );

  // ── Global keybindings ──────────────────────────────────────────────
  // Esc quits, mirroring the blessed TUI. `?` prints help. We also
  // forward Ctrl+C to exit() in case exitOnCtrlC isn't enabled for
  // some environment.
  //
  // Note: ink-text-input absorbs most printable characters, but ALL
  // useInput hooks in the tree fire for every keystroke. We restrict
  // `?` to the empty-input case so users can still type the literal
  // character into a message.
  useInput((input, key) => {
    if (key.escape) {
      exit();
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
  // Subscribe to the persona capability's change events. When the
  // active persona has a uiColor, push an override; when the persona
  // clears, pop it. We track the most-recently-pushed id so the pop
  // on a switch targets the right slot.
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
  const toolCount = opts.engine.getRegisteredToolCount();
  const personaLabel = useMemo(() => {
    const persona = opts.engine
      .getCapability<{
        getActivePersona: () => { name: string } | null;
      }>('persona')
      ?.getActivePersona();
    return persona ? ` persona:${persona.name}` : '';
  }, [opts.engine, overrides]);
  const statusLeft = ` model:${model} │ plugins:${pluginCount} │ tools:${toolCount} │ ctx:${
    ctxPct ?? '?'
  }%${personaLabel} `;

  // ── Elicitation useInput ──────────────────────────────────────────
  // When a question is active, hijack arrow keys + Enter / Ctrl+C to
  // drive the picker. We do this in a separate useInput (not the
  // global one) so the chat input line keeps receiving typed text
  // for freeform questions.
  useInput((inputChar, key) => {
    if (!activeQuestion) return;
    if (key.ctrl && inputChar === 'c') {
      cancelQuestion();
      return;
    }
    if (activeQuestion.freeform) {
      // Freeform questions are handled by their own TextInput, which
      // commits via Enter. We only intercept Esc as a cancel.
      if (key.escape) {
        cancelQuestion();
      }
      return;
    }
    // Closed-set picker: arrow up/down to move selection, Enter to commit.
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
    // Number shortcuts: 1..9.
    if (/^[1-9]$/.test(inputChar)) {
      const idx = Number.parseInt(inputChar, 10) - 1;
      if (idx >= 0 && idx < choices.length) {
        commitAnswer(choices[idx].value);
      }
    }
  });

  // ── Render ─────────────────────────────────────────────────────────
  return (
    <Box flexDirection="column" width="100%" height="100%">
      <Box flexDirection="row" flexGrow={1}>
        <ChatLog entries={entries} scheme={scheme} />
        <Sidebar widgets={sidebarWidgets} scheme={scheme} />
      </Box>
      <InputLine
        value={input}
        onChange={setInput}
        onSubmit={value => {
          setInput('');
          void runSlashCommand(value);
        }}
        scheme={scheme}
        promptLabel={promptLabel}
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

/**
 * Inline UI for an active elicitation question. Closed-set questions
 * show a numbered list with the current picker index highlighted;
 * freeform questions reuse the standard text input but commit on
 * Enter.
 */
function ElicitationPrompt({
  question,
  pickerIndex,
  scheme,
  onSubmit,
}: {
  question: DroneElicitationQuestion & { uiKey: string };
  pickerIndex: number;
  scheme: DroneColorScheme;
  onSubmit: (answer: string) => void;
}): JSX.Element {
  return (
    <Box
      borderStyle="single"
      borderColor={scheme.border}
      flexDirection="column"
      paddingX={1}
    >
      <Text>
        <ColorTag color={scheme.primary}>{question.prompt}</ColorTag>
      </Text>
      {question.freeform ? (
        <FreeformPrompt
          inputLabel={question.inputLabel ?? question.prompt}
          placeholder={question.placeholder}
          defaultValue={question.defaultValue}
          onSubmit={onSubmit}
          scheme={scheme}
        />
      ) : (
        <Box flexDirection="column">
          {(question.choices ?? []).map((choice, idx) => {
            const marker = idx === pickerIndex ? '▶' : ' ';
            const def =
              question.defaultValue === choice.value ? ' (default)' : '';
            return (
              <Text key={choice.value}>
                <ColorTag
                  color={scheme.userInput}
                >{`  ${marker} ${idx + 1}. ${choice.label}${def}`}</ColorTag>
              </Text>
            );
          })}
          <Text dimColor>
            ↑/↓ to move, Enter to confirm, 1-9 to jump, Esc to cancel
          </Text>
        </Box>
      )}
    </Box>
  );
}

function FreeformPrompt({
  inputLabel,
  placeholder,
  defaultValue,
  onSubmit,
  scheme,
}: {
  inputLabel: string;
  placeholder?: string;
  defaultValue?: string;
  onSubmit: (answer: string) => void;
  scheme: DroneColorScheme;
}): JSX.Element {
  const [value, setValue] = useState<string>(defaultValue ?? '');
  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text color={scheme.userInput}>{inputLabel} </Text>
        <FreeformInput value={value} onChange={setValue} onSubmit={onSubmit} />
      </Box>
      {placeholder ? <Text dimColor>{`(e.g. ${placeholder})`}</Text> : null}
      <Text dimColor>Enter to submit, Esc to cancel</Text>
    </Box>
  );
}

/**
 * Minimal inline text input that doesn't conflict with the main
 * chat input. We can't use ink-text-input here because the main
 * InputLine already owns the global focus for the chat composer;
 * nesting two TextInputs is unreliable. Instead we listen for the
 * 'input' keystroke via the parent's useInput and append to a
 * local string. Enter commits, Esc cancels.
 *
 * To avoid stepping on the parent's useInput, the parent only
 * intercepts arrow/return/esc while a freeform question is active,
 * letting printable characters fall through to this component via
 * a separate useInput mounted here.
 */
function FreeformInput({
  value,
  onChange,
  onSubmit,
}: {
  value: string;
  onChange: (next: string) => void;
  onSubmit: (answer: string) => void;
}): JSX.Element {
  useInput((inputChar, key) => {
    // Enter alone → submit
    if (key.return && !key.shift) {
      if (value.trim().length === 0) return; // ignore empty submit
      onSubmit(value.trim());
      return;
    }
    // Ctrl+J (inputChar === '\n' with !key.return) → insert newline at end
    if (inputChar === '\n' && !key.return) {
      onChange(value + '\n');
      return;
    }
    if (key.backspace || key.delete) {
      onChange(value.slice(0, -1));
      return;
    }
    if (key.ctrl && inputChar === 'u') {
      onChange('');
      return;
    }
    // Filter out control characters that would render as garbage.
    if (inputChar && !key.ctrl && !key.meta && inputChar.length > 0) {
      onChange(value + inputChar);
    }
  });
  return <Text>{value.length > 0 ? value : ' '}</Text>;
}

function printHelp(
  opts: DroneTuiOptions,
  log: (text: string, kind?: ChatEntry['kind']) => void
): void {
  const pluginHelp = opts.engine.getHelpSnippets();

  const helpLines: string[] = [
    'Keybindings:',
    '',
    '  Ctrl+C / Escape   Quit',
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
    '  /help              Show this help',
    '  /clear             Clear session',
    '  /plugins           List enabled plugins',
  ];

  helpLines.push(
    '  /tool <name>       Run a tool',
    '  /exec <cmd>        Run a command'
  );

  if (pluginHelp.length > 0) {
    helpLines.push('', 'Plugin commands:');
    for (const snippet of pluginHelp) {
      helpLines.push(`  ${snippet}`);
    }
  }

  log('Help', 'info');
  log(helpLines.join('\n'));
}
