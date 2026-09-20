/**
 * `@`-reference expansion in the workflow host (`ctx.agent`), which is backed by
 * the ephemeral conversation. The ephemeral host passes the engine straight into
 * the conversation service and never wires `expandUserMessage`, so this test
 * proves the engine's `reference` capability reaches it as the default expander.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DronePluginEngine } from '../src/runtime/plugin-engine.js';
import {
  createDefaultAgentConfig,
  type DroneChatRequest,
  type DroneChatResponse,
  type DroneContextWindowInfo,
  type DroneLlmCapability,
  type DroneLlmProvider,
} from 'drone-core';
import { createEphemeralConversation } from '../src/runtime/ephemeral-conversation.js';
import { createReferenceCapability } from '../src/runtime/reference-expansion/index.js';
import { createMockEngine, silentLogger } from './helpers.js';

function makeCapturingProvider(): DroneLlmProvider & {
  __requests: DroneChatRequest[];
} {
  const requests: DroneChatRequest[] = [];
  return {
    chat: vi.fn(async (request: DroneChatRequest) => {
      requests.push(request);
      return { message: 'done' } satisfies DroneChatResponse;
    }),
    getContextWindowInfo: async () =>
      ({
        model: 'fake',
        contextWindowTokens: 1_000_000,
        source: 'config',
      }) satisfies DroneContextWindowInfo,
    __requests: requests,
  };
}

function makeLlmCapability(provider: DroneLlmProvider): DroneLlmCapability {
  return {
    getActiveProvider: () => provider,
    resolveModelForRole: () => ({
      provider,
      providerId: 'test-provider',
      model: 'fake',
    }),
    getActiveProviderId: () => 'test-provider',
    getAvailableProviders: () => [{ id: 'test-provider', precedence: 1000 }],
    activateProvider: () => {},
    getModel: () => 'fake',
    setModel: () => {},
    getReasoningLevel: () => undefined,
    setReasoningLevel: () => {},
    listModels: async () => ['fake'],
    registerDriver: () => {},
    registerProvider: () => {},
    unregisterProvider: () => {},
    describeImages: async images => images,
    getUsageLedger: () => [],
  };
}

/** Last user message the provider saw, flattened to a string. */
function lastUserMessage(requests: DroneChatRequest[]): string {
  const request = requests[requests.length - 1];
  const user = [...request.messages].reverse().find(m => m.role === 'user');
  return typeof user?.content === 'string' ? user.content : '';
}

describe('workflow host: ctx.agent reference expansion via the ephemeral conversation', () => {
  let dir: string | undefined;

  afterEach(async () => {
    if (dir) {
      await rm(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  it('expands an @file reference in an agent step with no expandUserMessage option', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ref-workflow-'));
    await writeFile(path.join(dir, 'notes.md'), 'hello from disk\n', 'utf-8');

    const provider = makeCapturingProvider();
    const capability = createReferenceCapability({ cwd: dir, homedir: dir });
    const engine = createMockEngine({
      tools: [],
      executeToolImpl: async () => 'ok',
    });
    (engine as { getCapability: (id: string) => unknown }).getCapability = (
      id: string
    ) => {
      if (id === 'llm') return makeLlmCapability(provider);
      if (id === 'reference') return capability;
      return undefined;
    };

    const ephemeral = createEphemeralConversation({
      engine: engine as unknown as DronePluginEngine,
      config: createDefaultAgentConfig(),
      logger: silentLogger(),
    });

    await ephemeral.send('see @notes.md');

    const user = lastUserMessage(provider.__requests);
    expect(user).toContain('--- Referenced content ---');
    expect(user).toContain('hello from disk');
  });
});
