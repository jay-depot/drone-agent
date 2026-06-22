import {
  createConsoleLogger,
  type DroneElicitation,
  type DroneElicitationAnswers,
  type DroneElicitationQuestion,
  type DroneLlmProvider,
} from 'drone-core';
import { createInterface, type Interface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { render } from 'ink';
import { builtInPlugins, createBuiltInPlugins } from './plugins/index.js';
import type { DronePersonaCapability } from './plugins/persona/index.js';
import { createTui } from './tui/index.js';
import { ModelPicker } from './tui/components/ModelPicker.js';
import { createConversationService } from './runtime/conversation-service.js';
import { createContextBudgetService } from './runtime/context-budget-service.js';
import { loadAgentConfig } from './runtime/config.js';
import { createDronePluginEngine } from './runtime/plugin-engine.js';
import { createSessionManager } from './runtime/session-manager.js';

type CliOptions = {
  once: boolean;
  plainOutput: boolean;
  modelOverride?: string;
  pluginOverrides: string[];
  workflow?: {
    pluginId: string;
    workflowName: string;
    args: Record<string, string>;
  };
};

type CliInvocation =
  | {
      kind: 'tool';
      toolName: string;
      input: Record<string, unknown>;
      options: CliOptions;
    }
  | {
      kind: 'chat';
      prompt: string;
      options: CliOptions;
    }
  | {
      kind: 'workflow';
      options: CliOptions & {
        workflow: NonNullable<CliOptions['workflow']>;
      };
    }
  | {
      kind: 'default';
      options: CliOptions;
    };

/**
 * Build a `DroneElicitation` implementation backed by `node:readline`.
 * Used by the plain-output (`--plain-output`) host. The TUI App
 * constructs its own implementation; in non-interactive modes (e.g.
 * `--once`) the host simply doesn't call `setElicitation` and the
 * engine returns `undefined` to plugins that try to elicit.
 *
 * Closed-set questions render as a numbered list and accept either the
 * digit or the typed `value`. Freeform questions prompt with a label
 * and return the trimmed line. `defaultValue` is used for empty input.
 */
export function createReadlineElicitation(): DroneElicitation & {
  close: () => void;
} {
  // Each `ask()` call gets its own readline instance so the wizard can
  // do multi-step prompts without leaving a dangling interface. We
  // expose `close()` for tests; production code uses one ask per
  // workflow and lets the GC reclaim the interface.
  let activeInterface: Interface | undefined;

  function openInterface(): Interface {
    const iface = createInterface({ input, output });
    activeInterface = iface;
    return iface;
  }

  async function askClosedSet(
    question: DroneElicitationQuestion
  ): Promise<string> {
    const choices = question.choices ?? [];
    if (choices.length === 0) {
      throw new Error(
        `Elicitation question "${question.id}" has no choices and is not freeform.`
      );
    }
    const iface = openInterface();
    output.write(`${question.prompt}\n`);
    choices.forEach((choice, idx) => {
      const marker = choice.value === question.defaultValue ? '*' : ' ';
      output.write(`  ${marker} ${idx + 1}. ${choice.label}\n`);
    });
    if (question.defaultValue) {
      const def = choices.find(c => c.value === question.defaultValue);
      if (def) output.write(`(default: ${def.label})\n`);
    }
    const label = question.inputLabel ?? question.prompt;
    while (true) {
      const raw = (await iface.question(`${label} `)).trim();
      if (raw.length === 0) {
        if (question.defaultValue !== undefined) return question.defaultValue;
        output.write('Please choose one of the options above.\n');
        continue;
      }
      // Digit selection (1-based).
      if (/^\d+$/.test(raw)) {
        const idx = Number.parseInt(raw, 10) - 1;
        if (idx >= 0 && idx < choices.length) {
          return choices[idx].value;
        }
        output.write('Please choose one of the options above.\n');
        continue;
      }
      // Typed value (case-insensitive match).
      const lower = raw.toLowerCase();
      const match = choices.find(c => c.value.toLowerCase() === lower);
      if (match) return match.value;
      output.write('Please choose one of the options above.\n');
    }
  }

  async function askFreeform(
    question: DroneElicitationQuestion
  ): Promise<string> {
    const iface = openInterface();
    const label = question.inputLabel ?? question.prompt;
    while (true) {
      const raw = (await iface.question(`${label} `)).trim();
      if (raw.length > 0) return raw;
      if (question.defaultValue !== undefined) return question.defaultValue;
      if (question.placeholder) {
        output.write(`(e.g. ${question.placeholder})\n`);
      }
    }
  }

  return {
    ask: async (questions): Promise<DroneElicitationAnswers> => {
      const answers: DroneElicitationAnswers = {};
      try {
        for (const question of questions) {
          validateQuestion(question);
          if (question.freeform) {
            answers[question.id] = await askFreeform(question);
          } else {
            answers[question.id] = await askClosedSet(question);
          }
        }
      } finally {
        if (activeInterface) {
          activeInterface.close();
          activeInterface = undefined;
        }
      }
      return answers;
    },
    close: () => {
      if (activeInterface) {
        activeInterface.close();
        activeInterface = undefined;
      }
    },
  };
}

function validateQuestion(question: DroneElicitationQuestion): void {
  const hasChoices =
    Array.isArray(question.choices) && question.choices.length > 0;
  if (hasChoices && question.freeform) {
    throw new Error(
      `Elicitation question "${question.id}" cannot set both "choices" and "freeform: true".`
    );
  }
  if (!hasChoices && !question.freeform) {
    throw new Error(
      `Elicitation question "${question.id}" must set either "choices" or "freeform: true".`
    );
  }
}

function parseJsonObject(raw: string): Record<string, unknown> {
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Tool input must be a JSON object.');
  }
  return parsed as Record<string, unknown>;
}

export function parseCliInvocation(argv: string[]): CliInvocation {
  const args = [...argv];
  const options: CliOptions = {
    once: false,
    plainOutput: false,
    pluginOverrides: [],
  };

  while (args.length > 0) {
    if (args[0] === '--once') {
      options.once = true;
      args.shift();
      continue;
    }

    if (args[0] === '--plain-output') {
      options.plainOutput = true;
      args.shift();
      continue;
    }

    if (args[0] === '--model') {
      if (args.length < 2) {
        throw new Error(
          'Usage: drone-agent [--once] [--plain-output] [--model <model>] [--plugin <id>] [--workflow <plugin>.<name> [--workflow-arg key=value]...] [chat <prompt>|tool <plugin.tool> [jsonInput]|exec <command>]'
        );
      }
      options.modelOverride = args[1];
      args.splice(0, 2);
      continue;
    }

    if (args[0] === '--plugin') {
      if (args.length < 2) {
        throw new Error(
          'Usage: drone-agent [--once] [--plain-output] [--model <model>] [--plugin <id>] [--workflow <plugin>.<name> [--workflow-arg key=value]...] [chat <prompt>|tool <plugin.tool> [jsonInput]|exec <command>]'
        );
      }
      options.pluginOverrides.push(args[1]);
      args.splice(0, 2);
      continue;
    }

    if (args[0] === '--workflow') {
      if (args.length < 2) {
        throw new Error(
          'Usage: drone-agent --workflow <plugin>.<name> [--workflow-arg key=value]...'
        );
      }
      const target = args[1];
      const dot = target.indexOf('.');
      if (dot <= 0 || dot === target.length - 1) {
        throw new Error(
          `--workflow target must be in the form <plugin>.<name>; got "${target}"`
        );
      }
      options.workflow = {
        pluginId: target.slice(0, dot),
        workflowName: target.slice(dot + 1),
        args: {},
      };
      args.splice(0, 2);
      continue;
    }

    if (args[0] === '--workflow-arg') {
      if (!options.workflow) {
        throw new Error(
          '--workflow-arg requires --workflow <plugin>.<name> to come first.'
        );
      }
      if (args.length < 2) {
        throw new Error('Usage: --workflow-arg key=value');
      }
      const raw = args[1];
      const eq = raw.indexOf('=');
      if (eq === -1) {
        throw new Error(
          `--workflow-arg must be in the form key=value; got "${raw}"`
        );
      }
      const key = raw.slice(0, eq).trim();
      const value = raw.slice(eq + 1);
      if (key.length === 0) {
        throw new Error(`--workflow-arg key cannot be empty: "${raw}"`);
      }
      options.workflow.args[key] = value;
      args.splice(0, 2);
      continue;
    }

    break;
  }

  // If --workflow is present and no command was given, the invocation is a
  // workflow run. We surface this as a separate `CliInvocation` kind so the
  // caller can route it correctly.
  if (options.workflow) {
    return {
      kind: 'workflow',
      options: options as CliOptions & {
        workflow: NonNullable<CliOptions['workflow']>;
      },
    };
  }

  const [command, ...rest] = args;

  if (command === 'tool') {
    if (rest.length === 0) {
      throw new Error('Usage: drone-agent tool <plugin.tool> [jsonInput]');
    }

    return {
      kind: 'tool',
      toolName: rest[0],
      input: rest[1] ? parseJsonObject(rest[1]) : {},
      options,
    };
  }

  if (command === 'exec') {
    if (rest.length === 0) {
      throw new Error('Usage: drone-agent exec <command>');
    }

    return {
      kind: 'tool',
      toolName: 'exec.run',
      input: {
        command: rest.join(' '),
        cwd: process.cwd(),
      },
      options,
    };
  }

  if (command === 'chat') {
    if (rest.length === 0) {
      throw new Error('Usage: drone-agent chat <prompt>');
    }

    return {
      kind: 'chat',
      prompt: rest.join(' '),
      options,
    };
  }

  return { kind: 'default', options };
}
function printInteractiveHelp(
  engine: ReturnType<typeof createDronePluginEngine>
): void {
  output.write('Interactive commands:\n');
  output.write('  /exit                 Quit the agent\n');
  output.write('  /clear                Clear the current session context\n');
  output.write('  /help                 Show this help\n');
  output.write(
    '  /plugins              List known plugins and enabled state\n'
  );
  output.write('  /tool <name> [json]   Run a registered tool directly\n');
  output.write(
    '  /exec <command>       Run a shell command through exec.run\n'
  );

  const pluginHelp = engine.getHelpSnippets();
  if (pluginHelp.length > 0) {
    output.write('Plugin commands:\n');
    for (const snippet of pluginHelp) {
      output.write(`  ${snippet}\n`);
    }
  }

  output.write('  Any other input is sent to the chat model\n');
}

function getPersonaCapability(
  engine: ReturnType<typeof createDronePluginEngine>
): DronePersonaCapability | undefined {
  return engine.getCapability<DronePersonaCapability>('persona');
}

type OllamaListCapability = {
  listModels: () => Promise<string[]>;
};

function getOllamaCapability(
  engine: ReturnType<typeof createDronePluginEngine>
): OllamaListCapability | undefined {
  return engine.getCapability<OllamaListCapability>('ollama');
}

/**
 * Show the Ink-based model picker and resolve with the chosen model id.
 *
 * Used during the first-run flow when no user-level config exists. The
 * picker renders into the normal scrollback (no alt screen) and exits
 * cleanly on Enter or Esc, leaving the terminal in a state where the
 * chat TUI can mount on top without raw-mode collisions.
 */
function pickModelInteractive(
  models: string[],
  current: string
): Promise<string> {
  return new Promise<string>(resolve => {
    let resolved = false;
    const finish = (model: string): void => {
      if (resolved) return;
      resolved = true;
      instance.unmount();
      resolve(model);
    };
    const instance = render(
      <ModelPicker models={models} current={current} onSelect={finish} />,
      { exitOnCtrlC: true }
    );
  });
}

function buildPromptLabel(
  _conversation: ReturnType<typeof createConversationService>,
  engine: ReturnType<typeof createDronePluginEngine>
): string {
  const persona = getPersonaCapability(engine)?.getActivePersona();
  return persona
    ? `${persona.name.toLowerCase().replace(/\s+/g, '-')}> `
    : 'drone> ';
}

/**
 * Builds a plain-text event handler for `sendUserMessage` that mirrors what
 * the TUI does, so `--plain-output` mode (and `chat` invocations) show tool
 * calls and errors as they happen instead of just the final assistant reply.
 */
function makePlainOutputEventHandler(): import('./runtime/conversation-service.js').ConversationEventHandler {
  const MAX_PREVIEW = 240;
  const preview = (text: string): string => {
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length > MAX_PREVIEW ? `${flat.slice(0, MAX_PREVIEW)}…` : flat;
  };
  return event => {
    switch (event.kind) {
      case 'reasoning':
        output.write(`💭 ${preview(event.content)}\n`);
        break;
      case 'toolCall':
        output.write(
          `→ tool: ${event.name} ${preview(JSON.stringify(event.arguments))}\n`
        );
        break;
      case 'toolResult':
        output.write(`← ${event.name}: ${preview(event.content)}\n`);
        break;
      case 'error':
        output.write(`! ${preview(event.message)}\n`);
        break;
      // assistantMessage is rendered by the caller via the return value;
      // emitting it here would cause double-printing.
      case 'assistantMessage':
        break;
    }
  };
}

async function runInteractiveLoop(
  conversation: ReturnType<typeof createConversationService>,
  engine: ReturnType<typeof createDronePluginEngine>,
  logger: ReturnType<typeof createConsoleLogger>,
  sessionManager: ReturnType<typeof createSessionManager>
): Promise<void> {
  const readline = createInterface({ input, output });
  output.write('Interactive chat ready. Type /help for commands.\n');

  try {
    while (true) {
      const promptLabel = buildPromptLabel(conversation, engine);

      const line = (await readline.question(promptLabel)).trim();
      if (line.length === 0) {
        continue;
      }

      if (line === '/exit' || line === '/quit') {
        break;
      }

      if (line === '/help') {
        printInteractiveHelp(engine);
        continue;
      }

      if (line === '/clear') {
        conversation.clearSession();
        logger.info('Session context cleared.');
        continue;
      }

      if (line === '/plugins') {
        const lines = engine.listPlugins().map(plugin => {
          const state = plugin.enabled ? '[enabled]' : '[disabled]';
          const requiredLabel = plugin.required ? ' required' : '';
          return `  - ${plugin.id} (${plugin.name}) ${state}${requiredLabel}`;
        });
        logger.info(`Plugins:\n${lines.join('\n')}`);
        continue;
      }

      if (
        await engine.dispatchSlashCommand(line, {
          logger,
          engine,
          conversation,
          sessionManager,
        })
      ) {
        continue;
      }

      if (line.startsWith('/tool ')) {
        const toolCommand = line.slice('/tool '.length).trim();
        const firstSpaceIndex = toolCommand.indexOf(' ');
        const toolName =
          firstSpaceIndex === -1
            ? toolCommand
            : toolCommand.slice(0, firstSpaceIndex);
        const rawJson =
          firstSpaceIndex === -1
            ? undefined
            : toolCommand.slice(firstSpaceIndex + 1).trim();
        const toolInput = rawJson ? parseJsonObject(rawJson) : {};

        await engine.runHooks('onBeforePrompt');
        logger.info(await engine.executeTool(toolName, toolInput));
        await engine.runHooks('onAfterToolCall');
        continue;
      }

      if (line.startsWith('/exec ')) {
        const command = line.slice('/exec '.length).trim();
        if (command.length === 0) {
          logger.warn('Usage: /exec <command>');
          continue;
        }

        await engine.runHooks('onBeforePrompt');
        logger.info(
          await engine.executeTool('exec.run', {
            command,
            cwd: process.cwd(),
          })
        );
        await engine.runHooks('onAfterToolCall');
        continue;
      }

      await engine.runHooks('onBeforePrompt');
      const plainHandler = makePlainOutputEventHandler();
      const reply = await conversation.sendUserMessage(line, plainHandler);
      // Handler suppresses assistantMessage; render the final reply here.
      output.write(`${reply}\n`);
      await engine.runHooks('onAfterToolCall');
    }
  } finally {
    readline.close();
  }
}

async function main(): Promise<void> {
  const logger = createConsoleLogger('drone-agent');
  const invocation = parseCliInvocation(process.argv.slice(2));
  const resolvedConfig = await loadAgentConfig(process.cwd());

  // Apply --plugin overrides: temporarily enable named plugins for this session.
  if (invocation.options.pluginOverrides.length > 0) {
    const defaultEnabled =
      resolvedConfig.config.enabledPlugins.length > 0
        ? resolvedConfig.config.enabledPlugins
        : builtInPlugins
            .filter(p => p.metadata.required || p.metadata.defaultEnabled)
            .map(p => p.metadata.id);
    const overrideSet = new Set([
      ...defaultEnabled,
      ...invocation.options.pluginOverrides,
    ]);
    resolvedConfig.config.enabledPlugins = [...overrideSet];
  }

  const model =
    invocation.options.modelOverride ?? resolvedConfig.config.ollama.model;
  const sessionManager = createSessionManager();

  // The budget service needs renderPromptFragments from the engine, but the
  // engine is only constructable once we have the full plugin list. Use a
  // deferred getter to break the cycle.
  const engineRef: {
    current: ReturnType<typeof createDronePluginEngine> | undefined;
  } = {
    current: undefined,
  };
  const getEngine = (): ReturnType<typeof createDronePluginEngine> => {
    if (!engineRef.current) {
      throw new Error('engine accessed before init.');
    }
    return engineRef.current;
  };

  // Create the budget service with a lazy renderPromptFragments getter.
  const budgetService = createContextBudgetService({
    config: resolvedConfig.config,
    renderPromptFragments: () => getEngine().renderPromptFragments(),
    getProvider: () => {
      const ollama = getEngine().getCapability<{ provider: DroneLlmProvider }>(
        'ollama'
      );
      if (!ollama) {
        throw new Error('Ollama provider is not available.');
      }
      return ollama.provider;
    },
    getModel: () => model,
  });

  const plugins = createBuiltInPlugins({
    budgetService,
    sessionManager,
    getModel: () => model,
    getProvider: () => {
      const ollama = getEngine().getCapability<{ provider: DroneLlmProvider }>(
        'ollama'
      );
      if (!ollama) {
        throw new Error('Ollama provider is not available.');
      }
      return ollama.provider;
    },
  });
  const engine = createDronePluginEngine({
    plugins,
    config: resolvedConfig.config,
    logger,
  });
  engineRef.current = engine;
  const conversation = createConversationService({
    engine,
    model,
    config: resolvedConfig.config,
    logger,
    sessionManager,
    budgetService,
  });
  const registeredPlugins = await engine.initialize();

  // ── Elicitation wiring ──────────────────────────────────────────────
  // In plain-output mode we attach the readline-backed elicitation
  // immediately. In TUI mode the App constructs its own elicitation
  // capability; we wire it just before `createTui({...})` further down
  // so the App has its UI handlers registered. In non-interactive
  // modes (e.g. `--once`, workflow runs from non-interactive shells)
  // we deliberately leave the capability unset so plugins that try to
  // elicit get a clean "host is non-interactive" error rather than a
  // hanging readline.
  if (invocation.kind === 'default' && invocation.options.plainOutput) {
    engine.setElicitation(createReadlineElicitation());
  }

  await engine.runHooks('onPluginsLoaded');
  await engine.runHooks('onSessionStart');

  // ── First-run setup ──────────────────────────────────────────────────
  // If no user-level config exists, prompt the user to pick an Ollama model
  // and write it to ~/.drone-agent/config.json. We use the Ink-based
  // ModelPicker (same component tree as the chat TUI) so the prompt
  // matches the visual style of the rest of the app.
  const hasUserLayer = resolvedConfig.layers.some(l => l.scope === 'user');
  if (!hasUserLayer && !invocation.options.modelOverride) {
    const ollama = getOllamaCapability(engine);
    if (ollama) {
      try {
        const models = await ollama.listModels();
        if (models.length > 0) {
          // Pick a model via the Ink-based picker. Renders into the
          // normal scrollback, then exits cleanly so the chat TUI can
          // mount on the same terminal without state collisions.
          const selectedModel = await pickModelInteractive(
            models,
            resolvedConfig.config.ollama.model
          );

          const userConfigDir = path.join(os.homedir(), '.drone-agent');
          const userConfigFile = path.join(userConfigDir, 'config.json');
          await mkdir(userConfigDir, { recursive: true });
          await writeFile(
            userConfigFile,
            JSON.stringify({ ollama: { model: selectedModel } }, null, 2) + '\n'
          );

          logger.info(`Wrote ${userConfigFile} with model "${selectedModel}".`);
          conversation.setModel(selectedModel);
        } else {
          logger.warn(
            'No Ollama models found. Pull a model first (e.g. "ollama pull llama3.1").'
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(
          `Could not reach Ollama at ${resolvedConfig.config.ollama.host}: ${msg}`
        );
        logger.warn(
          'Start Ollama or create ~/.drone-agent/config.json manually.'
        );
      }
    }
  }

  const activeModel = conversation.getModel();
  logger.info(`registered plugins: ${registeredPlugins.length}`);
  logger.info(`registered tools: ${engine.getRegisteredToolCount()}`);
  logger.info(
    `config layers: ${resolvedConfig.layers.map(layer => layer.scope).join(', ')}`
  );
  logger.info(`ollama host: ${resolvedConfig.config.ollama.host}`);
  logger.info(`ollama model: ${activeModel}`);

  if (invocation.kind === 'chat') {
    await engine.runHooks('onBeforePrompt');
    const plainHandler = makePlainOutputEventHandler();
    const response = await conversation.sendUserMessage(
      invocation.prompt,
      plainHandler
    );
    // The handler deliberately suppresses assistantMessage events to avoid
    // double-printing; render the final reply here.
    output.write(`${response}\n`);
    await engine.runHooks('onAfterToolCall');
  } else if (invocation.kind === 'workflow') {
    // For workflow runs we always need elicitation. If we're in plain
    // mode the capability is already set; otherwise (e.g. someone ran
    // `--workflow` without `--plain-output`) attach the readline
    // elicitation here so the wizard can prompt.
    if (!engine.getElicitation()) {
      engine.setElicitation(createReadlineElicitation());
    }
    const { pluginId, workflowName, args } = invocation.options.workflow;
    const canonicalName = `${pluginId}.${workflowName}`;
    await engine.runHooks('onBeforePrompt');
    const result = await engine.runWorkflow(canonicalName, args);
    if (result.toolResult) {
      logger.info(result.toolResult);
    }
    await engine.runHooks('onAfterToolCall');

    if (result.kickMessage) {
      // The workflow wants the agent to react to its completion. Inject
      // the message as a synthetic user turn and re-enter the chat loop
      // so the assistant can summarise the result.
      sessionManager.appendUserMessage(result.kickMessage);
      await engine.runHooks('onBeforePrompt');
      const plainHandler = makePlainOutputEventHandler();
      const reply = await conversation.sendUserMessage(
        result.kickMessage,
        plainHandler
      );
      output.write(`${reply}\n`);
      await engine.runHooks('onAfterToolCall');
    }
  } else if (invocation.kind === 'default' && !invocation.options.once) {
    if (invocation.options.plainOutput) {
      await runInteractiveLoop(conversation, engine, logger, sessionManager);
    } else {
      // TUI mode: defer elicitation wiring to the App (it constructs a
      // TUI-flavoured capability that draws prompts into the chat log).
      // The App reads `engine.getElicitation()` indirectly through its
      // own state — see tui/app.tsx for the construction site.
      const tui = createTui({
        engine,
        conversation,
        model,
        logger,
      });
      await tui.waitUntilExit();
    }
  } else {
    const selectedTool =
      invocation.kind === 'tool'
        ? engine.getTool(invocation.toolName)
        : engine.getTool('startup.status');
    if (!selectedTool) {
      throw new Error(
        invocation.kind === 'tool'
          ? `Unknown tool: ${invocation.toolName}`
          : 'Startup status tool is unavailable.'
      );
    }

    await engine.runHooks('onBeforePrompt');
    const result =
      invocation.kind === 'tool'
        ? await engine.executeTool(invocation.toolName, invocation.input)
        : await selectedTool.execute({});
    logger.info(result);
    await engine.runHooks('onAfterToolCall');
  }

  await engine.runHooks('onShutdown');
}

main().catch(error => {
  const logger = createConsoleLogger('drone-agent');
  logger.error(
    error instanceof Error ? (error.stack ?? error.message) : String(error)
  );
  process.exitCode = 1;
});
