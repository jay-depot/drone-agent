import { createInterface, type Interface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import {
  makePlainOutputEventHandler,
  makeNdjsonOutputEventHandler,
} from './output-handlers.js';
import type {
  createConversationService,
  ConversationEvent,
  ConversationEventHandler,
} from './runtime/conversation-service.js';
import type { createDronePluginEngine } from './runtime/plugin-engine.js';
import type { createConsoleLogger, DroneLlmCapability } from 'drone-core';
import type { createSessionManager } from './runtime/session-manager.js';
import type { CliOptions } from './cli.js';

export type CreateConsoleLogger = ReturnType<typeof createConsoleLogger>;
export type CreateConversationService = ReturnType<
  typeof createConversationService
>;
export type CreateDronePluginEngine = ReturnType<
  typeof createDronePluginEngine
>;
export type CreateSessionManager = ReturnType<typeof createSessionManager>;

/**
 * Input event types for JSON mode (NDJSON input from stdin).
 */
export type InputEvent =
  | { type: 'kickoff'; task: string }
  | { type: 'chat'; message: string };

function getPersonaCapability(
  engine: CreateDronePluginEngine
): { getActivePersona: () => { name: string } } | undefined {
  return engine.getCapability<{ getActivePersona: () => { name: string } }>(
    'persona'
  );
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
 * Read all NDJSON lines from stdin.
 * Returns an array of parsed JSON objects.
 */
export async function readNdjsonInput(): Promise<unknown[]> {
  const rl = createInterface({ input });
  const lines: string[] = [];

  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed) {
      lines.push(trimmed);
    }
  }
  rl.close();

  return lines.map(line => {
    try {
      return JSON.parse(line);
    } catch {
      throw new Error(`Invalid JSON line: ${line}`);
    }
  });
}

/**
 * Run in JSON mode (for subagent). Reads kickoff from stdin,
 * executes the task, and outputs NDJSON events.
 */
export async function runJsonMode(
  conversation: CreateConversationService,
  engine: CreateDronePluginEngine,
  logger: CreateConsoleLogger
): Promise<void> {
  // Read stdin as NDJSON
  const events = await readNdjsonInput();

  // Find the first kickoff event
  const kickoffEvent = events.find(
    (e): e is InputEvent =>
      typeof e === 'object' &&
      e !== null &&
      'type' in e &&
      (e as InputEvent).type === 'kickoff'
  );

  if (!kickoffEvent) {
    throw new Error(
      'No kickoff event found in input. Expected: { "type": "kickoff", "task": "..." }'
    );
  }

  const task = (kickoffEvent as { type: 'kickoff'; task: string }).task;
  if (typeof task !== 'string' || !task.trim()) {
    throw new Error('Invalid kickoff event: task must be a non-empty string');
  }

  // Run the task with NDJSON output
  await engine.runHooks('onBeforePrompt');

  // Create handler that converts OutputEvent to ConversationEvent
  const ndjsonHandler = makeNdjsonOutputEventHandler();
  const conversationHandler: ConversationEventHandler = (
    event: ConversationEvent
  ) => {
    // Convert ConversationEvent to OutputEvent format
    switch (event.kind) {
      case 'assistantMessage':
        ndjsonHandler({ kind: 'assistantMessage', content: event.content });
        break;
      case 'reasoning':
        ndjsonHandler({ kind: 'reasoning', content: event.content });
        break;
      case 'toolCall':
        ndjsonHandler({
          kind: 'toolCall',
          name: event.name,
          input: event.arguments,
        });
        break;
      case 'toolResult':
        ndjsonHandler({
          kind: 'toolResult',
          name: event.name,
          result: event.content,
        });
        break;
      case 'error':
        ndjsonHandler({ kind: 'error', message: event.message });
        break;
    }
  };

  const response = await conversation.sendUserMessage(
    task,
    conversationHandler
  );

  // Output the final assistant message
  ndjsonHandler({ kind: 'assistantMessage', content: response });

  await engine.runHooks('onAfterToolCall');
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

        if (line === '/tools') {
          const tools = engine.listTools();
          const lines = ['Registered tools:'];
          for (const tool of tools) {
            lines.push(`  ${tool.name}`);
            lines.push(`    ${tool.description}`);
          }
          logger.info(lines.join('\n'));
          continue;
        }

        // Try plugin-registered slash commands
        const handled = await engine.dispatchSlashCommand(line, {
          logger,
          engine: {
            executeTool: (name, input) => engine.executeTool(name, input),
            runWorkflow: (name, args) => engine.runWorkflow(name, args),
            runHooks: hookName => engine.runHooks(hookName),
            getCapability: <T>(id: string) => engine.getCapability<T>(id),
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
