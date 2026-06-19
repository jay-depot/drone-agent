import { createConsoleLogger } from 'drone-core';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { builtInPlugins, createBuiltInPlugins } from './plugins/index.js';
import type { DronePersonaCapability } from './plugins/persona/index.js';
import { createTui } from './tui/index.js';
import { createConversationService } from './runtime/conversation-service.js';
import { loadAgentConfig } from './runtime/config.js';
import { createDronePluginEngine } from './runtime/plugin-engine.js';
import { createSessionManager } from './runtime/session-manager.js';

type CliOptions = {
  once: boolean;
  plainOutput: boolean;
  modelOverride?: string;
  pluginOverrides: string[];
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
      kind: 'default';
      options: CliOptions;
    };

function parseJsonObject(raw: string): Record<string, unknown> {
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Tool input must be a JSON object.');
  }
  return parsed as Record<string, unknown>;
}

function parseCliInvocation(argv: string[]): CliInvocation {
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
          'Usage: drone-agent [--once] [--plain-output] [--model <model>] [--plugin <id>] [chat <prompt>|tool <plugin.tool> [jsonInput]|exec <command>]'
        );
      }
      options.modelOverride = args[1];
      args.splice(0, 2);
      continue;
    }

    if (args[0] === '--plugin') {
      if (args.length < 2) {
        throw new Error(
          'Usage: drone-agent [--once] [--plain-output] [--model <model>] [--plugin <id>] [chat <prompt>|tool <plugin.tool> [jsonInput]|exec <command>]'
        );
      }
      options.pluginOverrides.push(args[1]);
      args.splice(0, 2);
      continue;
    }

    break;
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
function printInteractiveHelp(): void {
  output.write('Interactive commands:\n');
  output.write('  /exit                 Quit the agent\n');
  output.write('  /clear                Clear the current session context\n');
  output.write('  /help                 Show this help\n');
  output.write(
    '  /plugins              List known plugins and enabled state\n'
  );
  output.write('  /model [name]         List models or switch model\n');
  output.write('  /persona list         List available personas\n');
  output.write(
    '  /persona select <id>  Switch active persona (or "none" to clear)\n'
  );
  output.write('  /persona current      Show current persona\n');
  output.write('  /tool <name> [json]   Run a registered tool directly\n');
  output.write(
    '  /exec <command>       Run a shell command through exec.run\n'
  );
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

function buildPromptLabel(
  _conversation: ReturnType<typeof createConversationService>,
  engine: ReturnType<typeof createDronePluginEngine>
): string {
  const persona = getPersonaCapability(engine)?.getActivePersona();
  return persona
    ? `${persona.name.toLowerCase().replace(/\s+/g, '-')}> `
    : 'drone> ';
}

async function handlePersonaSlashCommand(
  line: string,
  engine: ReturnType<typeof createDronePluginEngine>,
  logger: ReturnType<typeof createConsoleLogger>
): Promise<boolean> {
  const parts = line.slice('/persona '.length).trim().split(/\s+/);
  const subcommand = parts[0];

  if (subcommand === 'list') {
    const result = await engine.executeTool('persona.list', {});
    logger.info(result);
    return true;
  }

  if (subcommand === 'current') {
    const result = await engine.executeTool('persona.current', {});
    logger.info(result);
    return true;
  }

  if (subcommand === 'select') {
    const id = parts.slice(1).join(' ');
    if (!id) {
      logger.warn('Usage: /persona select <id> (or "none" to clear)');
      return true;
    }
    const result = await engine.executeTool('persona.select', { id });
    logger.info(result);
    return true;
  }

  return false;
}

async function handleModelSlashCommand(
  line: string,
  conversation: ReturnType<typeof createConversationService>,
  engine: ReturnType<typeof createDronePluginEngine>,
  logger: ReturnType<typeof createConsoleLogger>
): Promise<boolean> {
  const rest = line.slice('/model'.length).trim();
  const ollama = getOllamaCapability(engine);

  if (!ollama) {
    logger.warn(
      'Ollama capability not available — cannot list or switch models.'
    );
    return true;
  }

  // No argument: list models
  if (rest.length === 0) {
    try {
      const models = await ollama.listModels();
      const current = conversation.getModel();
      const lines = models.map(m =>
        m === current ? `  * ${m} (current)` : `    ${m}`
      );
      logger.info(`Available models:\n${lines.join('\n')}`);
      logger.info(`\nUse /model <name> to switch.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Failed to list models: ${msg}`);
    }
    return true;
  }

  // Has argument: switch model
  const modelName = rest;
  try {
    conversation.setModel(modelName);
    logger.info(`Switched to model: ${modelName}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`Failed to switch model: ${msg}`);
  }
  return true;
}

async function runInteractiveLoop(
  conversation: ReturnType<typeof createConversationService>,
  engine: ReturnType<typeof createDronePluginEngine>,
  logger: ReturnType<typeof createConsoleLogger>
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
        printInteractiveHelp();
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

      if (line.startsWith('/persona ')) {
        const handled = await handlePersonaSlashCommand(line, engine, logger);
        if (!handled) {
          logger.warn(
            'Unknown persona command. Try: /persona list, /persona select <id>, /persona current'
          );
        }
        continue;
      }

      if (line.startsWith('/model')) {
        await handleModelSlashCommand(line, conversation, engine, logger);
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
      logger.info(await conversation.sendUserMessage(line));
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
  // The compaction plugin needs the live engine handle, but the engine is
  // only constructable once we have the full plugin list. Use a deferred
  // getter to break the cycle: the engine is assigned to a `let` binding
  // after construction, and the compaction plugin reads it on demand.
  const engineRef: {
    current: ReturnType<typeof createDronePluginEngine> | undefined;
  } = {
    current: undefined,
  };
  const plugins = createBuiltInPlugins({
    engine: () => {
      if (!engineRef.current) {
        throw new Error('compaction plugin accessed engine before init.');
      }
      return engineRef.current;
    },
    sessionManager,
    getModel: () => model,
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
  });
  const registeredPlugins = await engine.initialize();

  await engine.runHooks('onPluginsLoaded');
  await engine.runHooks('onSessionStart');

  // ── First-run setup ──────────────────────────────────────────────────
  // If no user-level config exists, prompt the user to pick an Ollama model
  // and write it to ~/.drone-agent/config.json.
  const hasUserLayer = resolvedConfig.layers.some(l => l.scope === 'user');
  if (!hasUserLayer && !invocation.options.modelOverride) {
    const ollama = getOllamaCapability(engine);
    if (ollama) {
      try {
        const models = await ollama.listModels();
        if (models.length > 0) {
          logger.info('No user config found — pick a default Ollama model.');
          const modelList = models.map((m, i) => `  [${i}] ${m}`).join('\n');
          logger.info(`Available models:\n${modelList}`);

          const rl = createInterface({ input, output });
          const answer = (
            await rl.question('Select by number or name (Enter for first): ')
          ).trim();
          rl.close();
          // Reset terminal state after readline's raw-mode prompt so
          // blessed (or the next readline) doesn't get doubled keystrokes.
          if (input.isTTY) {
            input.setRawMode(false);
          }
          output.write('\n');

          let selectedModel: string;
          const numIndex = Number.parseInt(answer, 10);
          if (answer.length === 0) {
            selectedModel = models[0];
          } else if (
            !Number.isNaN(numIndex) &&
            numIndex >= 0 &&
            numIndex < models.length
          ) {
            selectedModel = models[numIndex];
          } else if (models.includes(answer)) {
            selectedModel = answer;
          } else {
            logger.warn(`"${answer}" not found, using "${models[0]}".`);
            selectedModel = models[0];
          }

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
    logger.info(await conversation.sendUserMessage(invocation.prompt));
    await engine.runHooks('onAfterToolCall');
  } else if (invocation.kind === 'default' && !invocation.options.once) {
    if (invocation.options.plainOutput) {
      await runInteractiveLoop(conversation, engine, logger);
    } else {
      createTui({
        engine,
        conversation,
        model,
        logger,
      });
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
