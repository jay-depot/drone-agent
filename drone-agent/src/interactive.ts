import { createInterface, type Interface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { makePlainOutputEventHandler } from './output-handlers.js';
import type { createConversationService } from './runtime/conversation-service.js';
import type { createDronePluginEngine } from './runtime/plugin-engine.js';
import type { createConsoleLogger, DroneLlmCapability } from 'drone-core';
import type { createSessionManager } from './runtime/session-manager.js';
import type { CliOptions } from './cli.js';

export type CreateConsoleLogger = ReturnType<typeof createConsoleLogger>;
export type CreateConversationService = ReturnType<typeof createConversationService>;
export type CreateDronePluginEngine = ReturnType<typeof createDronePluginEngine>;
export type CreateSessionManager = ReturnType<typeof createSessionManager>;

function getPersonaCapability(
  engine: CreateDronePluginEngine
): { getActivePersona: () => { name: string } } | undefined {
  return engine.getCapability<{ getActivePersona: () => { name: string } }>('persona');
}

function buildPromptLabel(
  _conversation: CreateConversationService,
  engine: CreateDronePluginEngine
): string {
  const persona = getPersonaCapability(engine)?.getActivePersona();
  return persona
    ? `${persona.name.toLowerCase().replace(/\s+/g, '-')}> `
    : 'drone> ';
}

/**
 * Run the interactive chat loop using readline.
 */
export async function runInteractiveLoop(
  conversation: CreateConversationService,
  engine: CreateDronePluginEngine,
  logger: CreateConsoleLogger,
  sessionManager: CreateSessionManager,
  options: CliOptions
): Promise<void> {
  const rl: Interface = createInterface({ input, output });
  const promptLabel = buildPromptLabel(conversation, engine);

  try {
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

export function getLlmCapability(
  engine: CreateDronePluginEngine
): DroneLlmCapability | undefined {
  return engine.getCapability<DroneLlmCapability>('llm');
}