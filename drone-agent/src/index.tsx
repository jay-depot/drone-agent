import {
  createConsoleLogger,
  type DroneAgentConfig,
  type DroneElicitation,
  type DroneElicitationAnswers,
  type DroneElicitationQuestion,
  type DroneLlmCapability,
} from 'drone-core';
import { createInterface, type Interface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { render } from 'ink';
import { builtInPlugins, createBuiltInPlugins } from './plugins/index.js';
import type { DronePersonaCapability } from 'drone-core';
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

function parseCliArgs(argv: string[]): CliInvocation {
  const options: CliOptions = {
    once: false,
    plainOutput: false,
    pluginOverrides: [],
  };

  const positionalArgs: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--once') {
      options.once = true;
    } else if (arg === '--plain-output') {
      options.plainOutput = true;
    } else if (arg === '--model' && i + 1 < argv.length) {
      options.modelOverride = argv[++i];
    } else if (arg === '--plugin' && i + 1 < argv.length) {
      options.pluginOverrides.push(argv[++i]);
    } else if (arg === '--workflow' && i + 1 < argv.length) {
      const raw = argv[++i];
      const parts = raw.split('.');
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        throw new Error(
          `Invalid workflow format: ${raw}. Expected <plugin>.<workflow>`
        );
      }
      const workflowArgs: Record<string, string> = {};
      while (i + 1 < argv.length && argv[i + 1].startsWith('--workflow-arg')) {
        const argKey = argv[++i];
        if (i + 1 >= argv.length) {
          throw new Error(
            `Missing value for ${argKey}. Usage: --workflow-arg key=value`
          );
        }
        const argValue = argv[++i];
        const eqIndex = argValue.indexOf('=');
        if (eqIndex === -1) {
          throw new Error(
            `Invalid workflow arg format: ${argValue}. Expected key=value`
          );
        }
        const key = argValue.slice(0, eqIndex).trim();
        if (!key) {
          throw new Error(
            `Invalid workflow arg format: ${argValue}. Key cannot be empty.`
          );
        }
        workflowArgs[key] = argValue.slice(eqIndex + 1);
      }
      options.workflow = {
        pluginId: parts[0],
        workflowName: parts[1],
        args: workflowArgs,
      };
    } else if (arg === '--tool' && i + 1 < argv.length) {
      const toolName = argv[++i];
      const input: Record<string, unknown> = {};
      while (i + 1 < argv.length && argv[i + 1].startsWith('--tool-arg')) {
        const argKey = argv[++i];
        if (i + 1 >= argv.length) {
          throw new Error(
            `Missing value for ${argKey}. Usage: --tool-arg key=value`
          );
        }
        const argValue = argv[++i];
        const eqIndex = argValue.indexOf('=');
        if (eqIndex === -1) {
          throw new Error(
            `Invalid tool arg format: ${argValue}. Expected key=value`
          );
        }
        input[argValue.slice(0, eqIndex)] = argValue.slice(eqIndex + 1);
      }
      return { kind: 'tool', toolName, input, options };
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      positionalArgs.push(arg);
    }
  }

  if (options.workflow) {
    return { kind: 'workflow', options } as CliInvocation;
  }

  if (positionalArgs.length > 0) {
    return { kind: 'chat', prompt: positionalArgs.join(' '), options };
  }

  return { kind: 'default', options };
}

function getLlmCapability(
  engine: ReturnType<typeof createDronePluginEngine>
): DroneLlmCapability | undefined {
  return engine.getCapability<DroneLlmCapability>('llm');
}

function getPersonaCapability(
  engine: ReturnType<typeof createDronePluginEngine>
): DronePersonaCapability | undefined {
  return engine.getCapability<DronePersonaCapability>('persona');
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
function makePlainOutputEventHandler() {
  return (event: {
    kind: string;
    content?: string;
    name?: string;
    message?: string;
  }): void => {
    switch (event.kind) {
      case 'reasoning':
        output.write(`\x1b[90m${event.content}\x1b[0m\n`);
        break;
      case 'toolCall':
        output.write(
          `\x1b[33m⚡ ${event.name}(${JSON.stringify(event.content ?? {})})\x1b[0m\n`
        );
        break;
      case 'toolResult':
        output.write(`\x1b[32m✓ ${event.name}\x1b[0m\n`);
        break;
      case 'error':
        output.write(`\x1b[31m✗ ${event.message}\x1b[0m\n`);
        break;
      case 'assistantMessage':
        // Suppress — the final reply is printed by the caller.
        break;
    }
  };
}

function createReadlineElicitation(): DroneElicitation & { close: () => void } {
  const rl: Interface = createInterface({ input, output });

  return {
    close: () => rl.close(),
    ask: async (questions: DroneElicitationQuestion[]) => {
      // Validate questions
      for (const question of questions) {
        if (question.choices && question.choices.length > 0 && question.freeform) {
          throw new Error(
            'Invalid question: cannot set both "choices" and "freeform: true".'
          );
        }
        if (
          (!question.choices || question.choices.length === 0) &&
          !question.freeform
        ) {
          throw new Error(
            'Invalid question: must set either "choices" or "freeform: true".'
          );
        }
      }

      const answers: DroneElicitationAnswers = {};

      for (const question of questions) {
        if (question.choices && question.choices.length > 0) {
          const lines = question.choices.map(
            (c, i) => `  ${i + 1}. ${c.label}`
          );
          const prompt = [
            question.prompt,
            ...lines,
            `Enter choice [1-${question.choices.length}]`,
            question.defaultValue
              ? ` (default: ${question.defaultValue})`
              : '',
            ': ',
          ].join('\n');

          const raw = await rl.question(prompt);
          const trimmed = raw.trim();
          if (trimmed.length === 0 && question.defaultValue) {
            answers[question.id] = question.defaultValue;
          } else {
            const idx = parseInt(trimmed, 10) - 1;
            if (
              !isNaN(idx) &&
              idx >= 0 &&
              idx < question.choices.length
            ) {
              answers[question.id] = question.choices[idx].value;
            } else {
              answers[question.id] = question.defaultValue ?? '';
            }
          }
        } else if (question.freeform) {
          const label = question.inputLabel ?? '';
          const placeholder = question.placeholder ?? '';
          const prompt = `${question.prompt}${placeholder ? ` (${placeholder})` : ''}${label ? `\n${label}` : ''}: `;
          const raw = await rl.question(prompt);
          const trimmed = raw.trim();
          answers[question.id] =
            trimmed.length > 0 ? trimmed : (question.defaultValue ?? '');
        }
      }

      return answers;
    },
  };
}

async function runInteractiveLoop(
  conversation: ReturnType<typeof createConversationService>,
  engine: ReturnType<typeof createDronePluginEngine>,
  logger: ReturnType<typeof createConsoleLogger>,
  sessionManager: ReturnType<typeof createSessionManager>
): Promise<void> {
  const rl: Interface = createInterface({ input, output });
  const promptLabel = buildPromptLabel(conversation, engine);

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const raw = await rl.question(promptLabel);
      const line = raw.trim();

      if (line.length === 0) continue;

      // Check for slash commands first
      if (line.startsWith('/')) {
        if (line === '/exit' || line === '/quit') {
          break;
        }

        if (line === '/clear') {
          conversation.clearSession();
          logger.info('Session cleared.');
          continue;
        }

        if (line === '/help') {
          const snippets = engine.getHelpSnippets();
          logger.info(`Available commands:\n${snippets.join('\n')}`);
          continue;
        }

        // Try plugin-registered slash commands
        const handled = await engine.dispatchSlashCommand(line, {
          logger,
          engine: {
            executeTool: (name, input) => engine.executeTool(name, input),
            runWorkflow: (name, args) => engine.runWorkflow(name, args),
            runHooks: hookName => engine.runHooks(hookName),
            getCapability: <T,>(id: string) => engine.getCapability<T>(id),
            dispatchSlashCommand: (l, ctx) =>
              engine.dispatchSlashCommand(l, ctx),
          },
          conversation: {
            getModel: () => conversation.getModel(),
            setModel: m => conversation.setModel(m),
            sendUserMessage: (p, onEvent) =>
              conversation.sendUserMessage(p, onEvent),
          },
          sessionManager: {
            appendUserMessage: m => sessionManager.appendUserMessage(m),
          },
        });

        if (handled) continue;

        logger.warn(`Unknown command: ${line}. Try /help.`);
        continue;
      }

      // Regular chat message
      await engine.runHooks('onBeforePrompt');
      const plainHandler = makePlainOutputEventHandler();
      const response = await conversation.sendUserMessage(line, plainHandler);
      output.write(`${response}\n`);
      await engine.runHooks('onAfterToolCall');
    }
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const logger = createConsoleLogger('drone-agent');
  const invocation = parseCliArgs(process.argv.slice(2));

  const resolvedConfig = await loadAgentConfig(process.cwd());

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
  // The getProvider and getModel are also lazy — they resolve through the
  // LLM broker once the engine is initialized.
  const budgetService = createContextBudgetService({
    config: resolvedConfig.config,
    renderPromptFragments: () => getEngine().renderPromptFragments(),
    getProvider: () => {
      const llm = getEngine().getCapability<DroneLlmCapability>('llm');
      if (!llm) {
        throw new Error('LLM provider broker is not available.');
      }
      return llm.getActiveProvider();
    },
    getModel: () => {
      const llm = getEngine().getCapability<DroneLlmCapability>('llm');
      if (!llm) {
        return model;
      }
      return llm.getModel();
    },
  });

  const plugins = createBuiltInPlugins({
    budgetService,
    sessionManager,
    getModel: () => {
      const llm = getEngine().getCapability<DroneLlmCapability>('llm');
      if (!llm) {
        return model;
      }
      return llm.getModel();
    },
    getProvider: () => {
      const llm = getEngine().getCapability<DroneLlmCapability>('llm');
      if (!llm) {
        throw new Error('LLM provider broker is not available.');
      }
      return llm.getActiveProvider();
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
    config: resolvedConfig.config,
    logger,
    sessionManager,
    budgetService,
    // When the tool iteration limit is reached and the config allows
    // prompting, ask the user whether to continue. The elicitation
    // capability is set lazily (by the TUI App on mount, or by the
    // readline host in plain-output mode), so we resolve it at call
    // time via engine.getElicitation().
    onToolIterationLimitReached: resolvedConfig.config.session
      .promptOnToolIterationLimit
      ? async (current, max) => {
          const elicit = engine.getElicitation();
          if (!elicit) return false; // non-interactive → abort
          const answers = await elicit.ask([
            {
              id: 'continue',
              prompt: `Tool call depth reached ${current}/${max}. Continue the session?`,
              choices: [
                { value: 'yes', label: 'Yes, continue' },
                { value: 'no', label: 'No, stop' },
              ],
              defaultValue: 'no',
            },
          ]);
          return answers.continue === 'yes';
        }
      : undefined,
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
  // If no user-level config exists, probe for available providers and ask
  // the user which one to use.
  const hasUserLayer = resolvedConfig.layers.some(l => l.scope === 'user');
  if (!hasUserLayer && !invocation.options.modelOverride) {
    const llm = getLlmCapability(engine);
    if (llm) {
      await runFirstRunSetup(llm, engine, conversation, logger, resolvedConfig.config);
    }
  }

  const activeModel = conversation.getModel();
  const activeProviderId = getLlmCapability(engine)?.getActiveProviderId() ?? 'unknown';
  logger.info(`registered plugins: ${registeredPlugins.length}`);
  logger.info(`registered tools: ${engine.getRegisteredToolCount()}`);
  logger.info(
    `config layers: ${resolvedConfig.layers.map(layer => layer.scope).join(', ')}`
  );
  logger.info(`llm provider: ${activeProviderId}`);
  logger.info(`model: ${activeModel}`);

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

/**
 * First-run setup: probe for available providers and ask the user which
 * one to use. Writes the user's choice to ~/.drone-agent/config.json.
 */
async function runFirstRunSetup(
  llm: DroneLlmCapability,
  engine: ReturnType<typeof createDronePluginEngine>,
  conversation: ReturnType<typeof createConversationService>,
  logger: ReturnType<typeof createConsoleLogger>,
  config: DroneAgentConfig
): Promise<void> {
  const userConfigDir = path.join(os.homedir(), '.drone-agent');
  const userConfigFile = path.join(userConfigDir, 'config.json');

  // Probe for available providers
  const availableProviders: { id: string; label: string }[] = [];

  // Check if Ollama is reachable
  const ollamaCap = engine.getCapability<{
    listModels: () => Promise<string[]>;
  }>('ollama');
  if (ollamaCap) {
    try {
      const models = await ollamaCap.listModels();
      if (models.length > 0) {
        availableProviders.push({ id: 'ollama', label: 'Ollama (local)' });
      }
    } catch {
      // Ollama not reachable — don't add it
    }
  }

  // OpenRouter is always an option (user provides the key)
  availableProviders.push({ id: 'openrouter', label: 'OpenRouter (cloud)' });

  if (availableProviders.length === 0) {
    logger.warn(
      'No LLM providers available. Install Ollama (https://ollama.ai) or configure OpenRouter manually.'
    );
    return;
  }

  // Use the readline elicitation to ask the user
  const elicit = createReadlineElicitation();

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const answers = await elicit.ask([
      {
        id: 'provider',
        prompt: 'Which LLM provider would you like to use?',
        choices: availableProviders.map(p => ({
          value: p.id,
          label: p.label,
        })),
        defaultValue: availableProviders[0].id,
      },
    ]);

    const chosenProvider = answers.provider;

    if (chosenProvider === 'ollama') {
      // Ollama flow: pick a model
      try {
        const ollamaCap2 = engine.getCapability<{
          listModels: () => Promise<string[]>;
        }>('ollama');
        if (!ollamaCap2) {
          logger.warn('Ollama capability not available.');
          continue;
        }
        const models = await ollamaCap2.listModels();
        if (models.length === 0) {
          logger.warn(
            'No Ollama models found. Pull a model first (e.g. "ollama pull llama3.1").'
          );
          continue;
        }

        const selectedModel = await pickModelInteractive(
          models,
          config.ollama.model
        );

        await mkdir(userConfigDir, { recursive: true });
        await writeFile(
          userConfigFile,
          JSON.stringify(
            {
              llm: { provider: 'ollama' },
              ollama: { model: selectedModel },
            },
            null,
            2
          ) + '\n'
        );

        logger.info(
          `Wrote ${userConfigFile} with Ollama model "${selectedModel}".`
        );
        conversation.setModel(selectedModel);
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`Failed to set up Ollama: ${msg}`);
        continue;
      }
    }

    if (chosenProvider === 'openrouter') {
      // OpenRouter flow: prompt for API key, pick a model
      const keyAnswers = await elicit.ask([
        {
          id: 'apiKey',
          prompt:
            'Enter your OpenRouter API key (it will be stored in config with env var interpolation):',
          freeform: true,
          placeholder: 'sk-or-v1-...',
          inputLabel: 'API key',
        },
      ]);

      const apiKey = keyAnswers.apiKey.trim();
      if (!apiKey) {
        logger.warn('API key is required for OpenRouter.');
        continue;
      }

      // Show curated default model list for selection
      const defaultModels = [
        { id: 'openai/gpt-4o', contextWindow: 128000 },
        { id: 'anthropic/claude-3.5-sonnet', contextWindow: 200000 },
        { id: 'google/gemini-2.0-flash-001', contextWindow: 1000000 },
        { id: 'mistralai/mistral-large-2411', contextWindow: 128000 },
        { id: 'meta-llama/llama-3.3-70b-instruct', contextWindow: 128000 },
      ];

      const modelAnswers = await elicit.ask([
        {
          id: 'model',
          prompt: 'Which model would you like to use as default?',
          choices: defaultModels.map(m => ({
            value: m.id,
            label: m.id,
          })),
          defaultValue: defaultModels[0].id,
        },
      ]);

      const selectedModel = modelAnswers.model;

      await mkdir(userConfigDir, { recursive: true });
      await writeFile(
        userConfigFile,
        JSON.stringify(
          {
            llm: { provider: 'openrouter' },
            openrouter: {
              apiKey: '${OPENROUTER_API_KEY}',
              defaultModel: selectedModel,
              baseUrl: 'https://openrouter.ai/api/v1',
              models: defaultModels,
            },
          },
          null,
          2
        ) + '\n'
      );

      // Set the env var for the current process
      process.env['OPENROUTER_API_KEY'] = apiKey;

      logger.info(
        `Wrote ${userConfigFile} with OpenRouter model "${selectedModel}".`
      );
      logger.info(
        'Set OPENROUTER_API_KEY in your environment or edit the config file directly.'
      );
      conversation.setModel(selectedModel);
      return;
    }

    // Unknown choice — loop back
    logger.warn('Unknown provider. Please choose again.');
  }
}

// Exported for tests
/** @internal */
export { parseCliArgs as parseCliInvocation };
/** @internal */
export { createReadlineElicitation };

main().catch(error => {
  const logger = createConsoleLogger('drone-agent');
  logger.error(
    error instanceof Error ? (error.stack ?? error.message) : String(error)
  );
  process.exitCode = 1;
});
