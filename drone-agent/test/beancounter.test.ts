/**
 * Tests for the beancounter plugin and the llm broker's usage ledger.
 *
 * The broker records provider-reported usage at its enrichProvider
 * chokepoint (main rounds, model roles, the image describer) and
 * exposes it via getUsageLedger(). Beancounter offers a mid-panel
 * widget that renders the cumulative totals. These tests drive a real
 * engine with a stub protocol driver so the whole path — provider chat,
 * ledger recording, widget formatting — is exercised end to end.
 */

import { describe, expect, it } from 'vitest';
import { createDronePluginEngine } from '../src/runtime/plugin-engine.js';
import { beancounterPlugin } from '../src/plugins/beancounter.js';
import { llmPlugin } from '../src/plugins/llm/index.js';
import { createDefaultAgentConfig, type DroneLlmCapability } from 'drone-core';
import { silentLogger } from './helpers.js';

type MidPanelWidgetShape = {
  id: string;
  label: string;
  getContent: () => string[];
};

type StubChatResponse = {
  message?: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cost?: number;
  };
};

function makeStubDriver(responder: () => StubChatResponse) {
  return {
    protocolId: 'stubproto',
    createProvider: () => ({
      chat: async () => responder(),
      getContextWindowInfo: async () => null,
    }),
    parameterSchema: { parameters: {} },
  };
}

async function createEngineWithStubDriver(responder: () => StubChatResponse) {
  const config = createDefaultAgentConfig();
  config.providers = {
    stub: {
      protocol: 'stubproto',
      models: { 'stub-model': { hasVision: true, contextWindow: 4096 } },
    },
  };
  config.llm.active = 'stub/stub-model';
  const engine = createDronePluginEngine({
    plugins: [llmPlugin, beancounterPlugin],
    config: { ...config, enabledPlugins: ['llm', 'beancounter'] },
    logger: silentLogger(),
  });
  await engine.initialize();

  const llm = engine.getCapability<DroneLlmCapability>('llm');
  if (!llm) throw new Error('llm capability missing');
  llm.registerDriver(makeStubDriver(responder));
  llm.activateProvider('stub');

  const widget = engine.getCapability<MidPanelWidgetShape>('beancounter');
  if (!widget) throw new Error('beancounter widget missing');

  return { engine, llm, widget };
}

describe('llm broker usage ledger', () => {
  it('records main-round usage tagged with role main', async () => {
    const { llm } = await createEngineWithStubDriver(() => ({
      message: 'ok',
      usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
    }));

    await llm.getActiveProvider().chat({
      model: 'stub-model',
      messages: [{ role: 'user', content: 'hi' }],
    });

    const ledger = llm.getUsageLedger();
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      providerId: 'stub',
      model: 'stub-model',
      role: 'main',
      usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
    });
    expect(typeof ledger[0]!.at).toBe('number');
  });

  it('tags model-role and image_describer calls with their broker path', async () => {
    const { llm } = await createEngineWithStubDriver(() => ({
      message: 'a red circle',
      usage: { promptTokens: 10, completionTokens: 3, totalTokens: 13 },
    }));

    await llm.getActiveProvider().chat({
      model: 'stub-model',
      messages: [{ role: 'user', content: 'hi' }],
    });
    await llm
      .resolveModelForRole('summarizer')
      .provider.chat({ model: 'stub-model', messages: [] });
    await llm.describeImages([{ mimeType: 'image/png', data: 'aGk=' }]);

    const roles = llm.getUsageLedger().map(entry => entry.role);
    expect(roles).toEqual(['main', 'summarizer', 'image_describer']);
  });

  it('skips recording when the provider reports no usage', async () => {
    const { llm } = await createEngineWithStubDriver(() => ({
      message: 'ok',
    }));

    await llm.getActiveProvider().chat({
      model: 'stub-model',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(llm.getUsageLedger()).toHaveLength(0);
  });

  it('clears the ledger on session clear', async () => {
    const { engine, llm } = await createEngineWithStubDriver(() => ({
      message: 'ok',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    }));

    await llm.getActiveProvider().chat({
      model: 'stub-model',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(llm.getUsageLedger()).toHaveLength(1);

    await engine.runHooks('onSessionClear');
    expect(llm.getUsageLedger()).toHaveLength(0);
  });
});

describe('beancounter widget', () => {
  it('hides until the first usage entry lands', async () => {
    let reportUsage = false;
    const { llm, widget } = await createEngineWithStubDriver(() => ({
      message: 'ok',
      ...(reportUsage
        ? { usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 } }
        : {}),
    }));
    expect(widget.label).toBe('USED');
    expect(widget.getContent()).toEqual([]);

    reportUsage = true;
    await llm.getActiveProvider().chat({
      model: 'stub-model',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(widget.getContent().length).toBeGreaterThan(0);
  });

  it('formats tokens and cost as `<n> tok · $<cost>`', async () => {
    const { llm, widget } = await createEngineWithStubDriver(() => ({
      message: 'ok',
      usage: {
        promptTokens: 40000,
        completionTokens: 5200,
        totalTokens: 45200,
        cost: 0.0421,
      },
    }));

    await llm.getActiveProvider().chat({
      model: 'stub-model',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(widget.getContent()).toEqual(['45.2k tok · $0.0421']);
  });

  it('formats token boundaries: raw under 1k, k under 1M, M above', async () => {
    async function contentFor(totalTokens: number): Promise<string> {
      const { llm, widget } = await createEngineWithStubDriver(() => ({
        message: 'ok',
        usage: { promptTokens: totalTokens, completionTokens: 0, totalTokens },
      }));
      await llm.getActiveProvider().chat({
        model: 'stub-model',
        messages: [{ role: 'user', content: 'hi' }],
      });
      return widget.getContent()[0] ?? '';
    }

    expect(await contentFor(999)).toBe('999 tok · $0.0000');
    expect(await contentFor(1000)).toBe('1.0k tok · $0.0000');
    expect(await contentFor(1_234_567)).toBe('1.2M tok · $0.0000');
  });

  it('shows $0.0000 when no provider reports cost', async () => {
    const { llm, widget } = await createEngineWithStubDriver(() => ({
      message: 'ok',
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    }));

    await llm.getActiveProvider().chat({
      model: 'stub-model',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(widget.getContent()).toEqual(['15 tok · $0.0000']);
  });

  it('accumulates across calls', async () => {
    const { llm, widget } = await createEngineWithStubDriver(() => ({
      message: 'ok',
      usage: {
        promptTokens: 1000,
        completionTokens: 0,
        totalTokens: 1000,
        cost: 0.01,
      },
    }));

    await llm.getActiveProvider().chat({
      model: 'stub-model',
      messages: [{ role: 'user', content: 'hi' }],
    });
    await llm.getActiveProvider().chat({
      model: 'stub-model',
      messages: [{ role: 'user', content: 'hi again' }],
    });

    expect(widget.getContent()).toEqual(['2.0k tok · $0.0200']);
  });
});
