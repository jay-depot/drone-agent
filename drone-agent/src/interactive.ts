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
 *
 * IMPORTANT: This function ensures a 'return' event is always emitted.
 * If the LLM completes without calling subagent.return, an implicit
 * return event is sent with the final assistant message as the result.
 */
export async function runJsonMode(
  conversation: CreateConversationService,
  engine: CreateDronePluginEngine
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
  let hasExplicitReturn = false;
  const conversationHandler: ConversationEventHandler = (
    event: ConversationEvent
  ) => {
    // Track if an explicit return event was emitted
    if (event.kind === 'toolCall' && event.name === 'subagent.return') {
      hasExplicitReturn = true;
    }
    // Convert ConversationEvent to OutputEvent format
    switch (event.kind) {
      case 'assistantMessage':
        ndjsonHandler({ kind: 'assistantMessage', content: event.content });
        break;
      case 'reasoning':
        ndjsonHandler({ kind: 'reasoning', content: event.content });
        break;
      case 'reasoningComplete':
      case 'assistantMessageComplete':
        // No-op — these markers are only meaningful for the TUI tail region
        break;
      case 'toolCall':
        ndjsonHandler({
          kind: 'toolCall',
          name: event.name,
          input: event.arguments,
        });
        break;
      case 'toolCallBatch':
        // Flatten batch into individual events for NDJSON consumers
        if (event.toolCalls) {
          for (const tc of event.toolCalls) {
            ndjsonHandler({
              kind: 'toolCall',
              name: tc.name,
              input: tc.arguments,
            });
          }
        }
        break;
      case 'toolResult':
        ndjsonHandler({
          kind: 'toolResult',
          name: event.name,
          result: event.content,
        });
        break;
      case 'toolResultBatch':
        // Flatten batch into individual events for NDJSON consumers
        if (event.results) {
          for (const result of event.results) {
            ndjsonHandler({
              kind: 'toolResult',
              name: result.name,
              result: result.content,
            });
          }
        }
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

  // CRITICAL FIX: If no explicit return event was emitted, send an implicit one.
  // This ensures the parent always receives a result, even if the LLM
  // didn't call the subagent.return tool.
  if (!hasExplicitReturn) {
    const runtime = engine.getCapability<{ subagentId?: string }>('runtime');
    const subagentId = runtime?.subagentId;
    ndjsonHandler({
      kind: 'return',
      result: response,
      subagentId,
    });
  }

  await engine.runHooks('onAfterToolCall');
}

/**
 * Run in JSON listen mode (for gateway integration).
 * Reads `chat` events from stdin in a loop, processes each via the
 * conversation service, writes NDJSON events to stdout, and emits a
 * `turnComplete` event after each turn.
 *
 * This mode is used when `--output-json` is specified WITHOUT `--once`,
 * enabling a parent process (like drone-gateway) to maintain a persistent
 * agent session across multiple turns.
 */
export async function runJsonListenMode(
  conversation: CreateConversationService,
  engine: CreateDronePluginEngine
): Promise<void> {
  const rl = createInterface({ input });
  const ndjsonHandler = makeNdjsonOutputEventHandler();

  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let event: InputEvent;
      try {
        event = JSON.parse(trimmed) as InputEvent;
      } catch {
        ndjsonHandler({ kind: 'error', message: `Invalid JSON: ${trimmed}` });
        continue;
      }

      if (event.type !== 'chat') {
        ndjsonHandler({
          kind: 'error',
          message: `Expected 'chat' event, got '${event.type}'`,
        });
        continue;
      }

      const message = event.message;
      if (typeof message !== 'string' || !message.trim()) {
        ndjsonHandler({
          kind: 'error',
          message: 'Invalid chat event: message must be a non-empty string',
        });
        continue;
      }

      // Process the message
      await engine.runHooks('onBeforePrompt');

      const conversationHandler: ConversationEventHandler = (
        convEvent: ConversationEvent
      ) => {
        switch (convEvent.kind) {
          case 'assistantMessage':
            ndjsonHandler({
              kind: 'assistantMessage',
              content: convEvent.content,
            });
            break;
          case 'reasoning':
            ndjsonHandler({ kind: 'reasoning', content: convEvent.content });
            break;
          case 'reasoningComplete':
          case 'assistantMessageComplete':
            // No-op — these markers are only meaningful for the TUI tail region
            break;
          case 'toolCall':
            ndjsonHandler({
              kind: 'toolCall',
              name: convEvent.name,
              input: convEvent.arguments,
            });
            break;
          case 'toolCallBatch':
            // Flatten batch into individual events for NDJSON consumers
            if (convEvent.toolCalls) {
              for (const tc of convEvent.toolCalls) {
                ndjsonHandler({
                  kind: 'toolCall',
                  name: tc.name,
                  input: tc.arguments,
                });
              }
            }
            break;
          case 'toolResult':
            ndjsonHandler({
              kind: 'toolResult',
              name: convEvent.name,
              result: convEvent.content,
            });
            break;
          case 'toolResultBatch':
            // Flatten batch into individual events for NDJSON consumers
            if (convEvent.results) {
              for (const result of convEvent.results) {
                ndjsonHandler({
                  kind: 'toolResult',
                  name: result.name,
                  result: result.content,
                });
              }
            }
            break;
          case 'error':
            ndjsonHandler({ kind: 'error', message: convEvent.message });
            break;
        }
      };

      const response = await conversation.sendUserMessage(
        message,
        conversationHandler
      );

      // Output the final assistant message
      ndjsonHandler({ kind: 'assistantMessage', content: response });

      // Signal that this turn is complete
      ndjsonHandler({ kind: 'turnComplete' });

      await engine.runHooks('onAfterToolCall');
    }
  } finally {
    rl.close();
  }
}

/**
 * Run the interactive chat loop using readline.
 */
export async function runInteractiveLoop(
  conversation: CreateConversationService,
  engine: CreateDronePluginEngine,
  logger: CreateConsoleLogger,
  sessionManager: CreateSessionManager
): Promise<void> {
  const rl: Interface = createInterface({ input, output });
  const promptLabel = buildPromptLabel(conversation, engine);

  let shouldExit = false;

  try {
    while (true) {
      const raw = await rl.question(promptLabel);
      const line = raw.trim();

      if (line.length === 0) continue;

      // Check for slash commands first
      if (line.startsWith('/')) {
        // Dispatch through engine (checks plugin commands, then built-ins).
        const handled = await engine.dispatchSlashCommand(line, {
          logger,
          engine: {
            executeTool: (name, input) => engine.executeTool(name, input),
            runWorkflow: (name, args) => engine.runWorkflow(name, args),
            runHooks: hookName => engine.runHooks(hookName),
            getCapability: <T>(id: string) => engine.getCapability<T>(id),
            dispatchSlashCommand: (l, ctx) =>
              engine.dispatchSlashCommand(l, ctx),
            onConversationEvent: cb => engine.onConversationEvent?.(cb),
          },
          conversation: {
            getModel: () => conversation.getModel(),
            setModel: m => conversation.setModel(m),
            getReasoningLevel: () => conversation.getReasoningLevel(),
            setReasoningLevel: l => conversation.setReasoningLevel(l),
            sendUserMessage: (p, onEvent) =>
              conversation.sendUserMessage(p, onEvent),
            clearSession: () => conversation.clearSession(),
          },
          sessionManager: {
            appendUserMessage: m => sessionManager.appendUserMessage(m),
            appendToolResult: (name, content, id) =>
              sessionManager.appendToolResult(name, content, id),
          },
          exit: () => {
            shouldExit = true;
          },
          printHelp: () => {
            const commands = engine.getSlashCommands();
            const lines = ['Available slash commands:'];
            for (const cmd of commands) {
              lines.push(`  ${cmd.command.padEnd(20)} ${cmd.description}`);
            }
            logger.info(lines.join('\n'));
          },
        });

        if (handled) {
          if (shouldExit) break;
          continue;
        }

        logger.warn(
          `Unknown command: ${line}. Type /help for available commands.`
        );
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
