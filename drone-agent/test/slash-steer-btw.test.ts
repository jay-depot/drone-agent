/**
 * Tests for the /steer and /btw built-in slash commands.
 */

import { describe, expect, it, vi } from 'vitest';
import { BUILT_IN_SLASH_COMMANDS } from '../src/runtime/builtin-commands.js';
import type { DroneSlashCommandContext } from 'drone-core';

function makeTestLogger(): {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  messages: string[];
} {
  const messages: string[] = [];
  return {
    info: (msg: string) => {
      messages.push(msg);
    },
    warn: (msg: string) => {
      messages.push(msg);
    },
    error: (msg: string) => {
      messages.push(msg);
    },
    messages,
  };
}

type ConversationOverrides = Partial<
  NonNullable<DroneSlashCommandContext['conversation']>
>;

function makeCtx(
  line: string,
  overrides: ConversationOverrides | undefined
): {
  ctx: DroneSlashCommandContext;
  logger: ReturnType<typeof makeTestLogger>;
} {
  const logger = makeTestLogger();
  const conversation: DroneSlashCommandContext['conversation'] = overrides
    ? {
        getModel: () => 'fake',
        setModel: () => {},
        getReasoningLevel: () => undefined,
        setReasoningLevel: () => {},
        sendUserMessage: async () => '',
        getDebugSubsystems: () => [],
        enableDebugSubsystem: () => {},
        disableDebugSubsystem: () => {},
        ...overrides,
      }
    : undefined;
  const ctx: DroneSlashCommandContext = {
    line,
    args: line.split(/\s+/).slice(1),
    logger,
    engine: {
      executeTool: async () => 'ok',
      runHooks: async () => {},
      getCapability: <T>() => undefined as T,
    },
    conversation,
  };
  return { ctx, logger };
}

const steerCmd = BUILT_IN_SLASH_COMMANDS.find(c => c.command === '/steer');
const btwCmd = BUILT_IN_SLASH_COMMANDS.find(c => c.command === '/btw');

describe('/steer built-in command', () => {
  it('is registered with busyBehavior true', () => {
    expect(steerCmd).toBeDefined();
    expect(steerCmd?.busyBehavior).toBe(true);
  });

  it('errors with usage when the message is empty', async () => {
    const steerMessage = vi.fn(async () => {});
    const { ctx, logger } = makeCtx('/steer   ', { steerMessage });
    const result = await steerCmd!.handler(ctx);
    expect(result).toBe(true);
    expect(logger.messages).toContain('Usage: /steer <message>');
    expect(steerMessage).not.toHaveBeenCalled();
  });

  it('errors when the host does not wire steerMessage', async () => {
    const { ctx, logger } = makeCtx('/steer hello', undefined);
    const result = await steerCmd!.handler(ctx);
    expect(result).toBe(true);
    expect(logger.messages).toContain('/steer: not available in this host');
  });

  it('delegates the rest-of-line message to steerMessage', async () => {
    const steerMessage = vi.fn(async () => {});
    const { ctx, logger } = makeCtx('/steer focus on the parser bug', {
      steerMessage,
    });
    const result = await steerCmd!.handler(ctx);
    expect(result).toBe(true);
    expect(steerMessage).toHaveBeenCalledWith('focus on the parser bug');
    // The handler must not log the message itself.
    expect(logger.messages).not.toContain('focus on the parser bug');
  });
});

describe('/btw built-in command', () => {
  it('is registered with busyBehavior true', () => {
    expect(btwCmd).toBeDefined();
    expect(btwCmd?.busyBehavior).toBe(true);
  });

  it('errors with usage when the question is empty', async () => {
    const askAside = vi.fn(async () => 'answer');
    const { ctx, logger } = makeCtx('/btw', { askAside });
    const result = await btwCmd!.handler(ctx);
    expect(result).toBe(true);
    expect(logger.messages).toContain('Usage: /btw <question>');
    expect(askAside).not.toHaveBeenCalled();
  });

  it('errors when the host does not wire askAside', async () => {
    const { ctx, logger } = makeCtx('/btw why?', undefined);
    const result = await btwCmd!.handler(ctx);
    expect(result).toBe(true);
    expect(logger.messages).toContain('/btw: not available in this host');
  });

  it('delegates the rest-of-line question to askAside without logging the answer', async () => {
    const askAside = vi.fn(async () => 'the answer text');
    const { ctx, logger } = makeCtx('/btw what is the plan?', { askAside });
    const result = await btwCmd!.handler(ctx);
    expect(result).toBe(true);
    expect(askAside).toHaveBeenCalledWith('what is the plan?');
    expect(logger.messages).not.toContain('the answer text');
  });
});
