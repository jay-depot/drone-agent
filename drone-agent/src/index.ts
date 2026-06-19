import { createConsoleLogger } from 'drone-core';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { builtInPlugins } from './plugins/index.js';
import { createConversationService } from './runtime/conversation-service.js';
import { loadAgentConfig } from './runtime/config.js';
import { createDronePluginEngine } from './runtime/plugin-engine.js';
import { createSessionManager } from './runtime/session-manager.js';

type CliOptions = {
  once: boolean;
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
    pluginOverrides: [],
  };

  while (args.length > 0) {
    if (args[0] === '--once') {
      options.once = true;
      args.shift();
      continue;
    }

    if (args[0] === '--model') {
      if (args.length < 2) {
        throw new Error(
          'Usage: drone-agent [--once] [--model <model>] [--plugin <id>] [chat <prompt>|tool <plugin.tool> [jsonInput]|exec <command>]'
        );
      }
      options.modelOverride = args[1];
      args.splice(0, 2);
      continue;
    }

    if (args[0] === '--plugin') {
      if (args.length < 2) {
        throw new Error(
          'Usage: drone-agent [--once] [--model <model>] [--plugin <id>] [chat <prompt>|tool <plugin.tool> [jsonInput]|exec <command>]'
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
  output.write('  /tool <name> [json]   Run a registered tool directly\n');
  output.write(
    '  /exec <command>       Run a shell command through exec.run\n'
  );
  output.write('  Any other input is sent to the chat model\n');
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
      let promptLabel = 'drone> ';
      try {
        const contextUsePercent =
          await conversation.getEstimatedContextUsagePercent();
        promptLabel = `drone (${contextUsePercent}% ctx)> `;
      } catch {
        // Fall back to the default prompt if context estimation fails.
      }

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
    const defaultEnabled = resolvedConfig.config.enabledPlugins.length > 0
      ? resolvedConfig.config.enabledPlugins
      : builtInPlugins
          .filter(p => p.metadata.required || p.metadata.defaultEnabled)
          .map(p => p.metadata.id);
    const overrideSet = new Set([...defaultEnabled, ...invocation.options.pluginOverrides]);
    resolvedConfig.config.enabledPlugins = [...overrideSet];
  }

  const model =
    invocation.options.modelOverride ?? resolvedConfig.config.ollama.model;
  const engine = createDronePluginEngine({
    plugins: builtInPlugins,
    config: resolvedConfig.config,
    logger,
  });
  const sessionManager = createSessionManager();
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

  logger.info(`registered plugins: ${registeredPlugins.length}`);
  logger.info(`registered tools: ${engine.getRegisteredToolCount()}`);
  logger.info(
    `config layers: ${resolvedConfig.layers.map(layer => layer.scope).join(', ')}`
  );
  logger.info(`ollama host: ${resolvedConfig.config.ollama.host}`);
  logger.info(`ollama model: ${model}`);

  if (invocation.kind === 'chat') {
    await engine.runHooks('onBeforePrompt');
    logger.info(await conversation.sendUserMessage(invocation.prompt));
    await engine.runHooks('onAfterToolCall');
  } else if (invocation.kind === 'default' && !invocation.options.once) {
    await runInteractiveLoop(conversation, engine, logger);
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
