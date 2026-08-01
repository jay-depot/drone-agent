import { describe, expect, it } from 'vitest';
import {
  createDefaultAgentConfig,
  createRuntimeFlagRegistry,
} from 'drone-core';
import { createContextBudgetService } from '../src/runtime/context-budget-service.js';

function makeBudgetService(
  flags?: () => ReturnType<typeof createRuntimeFlagRegistry>
) {
  return createContextBudgetService({
    config: createDefaultAgentConfig(),
    renderPromptFragments: async () => [],
    getProvider: () => ({
      chat: async () => ({ message: '' }),
      getContextWindowInfo: async () => ({
        model: 'fake',
        contextWindowTokens: 100_000,
        source: 'config' as const,
      }),
    }),
    getModel: () => 'fake',
    runtimeFlags: flags,
  });
}

describe('context-budget-service runtime flags injection', () => {
  it('excludes flags block when no registry is provided', async () => {
    const svc = makeBudgetService();
    const msgs = await svc.buildSystemMessages();
    expect(msgs.length).toBe(1);
    expect(msgs[0].content).not.toContain('Runtime Flags');
  });

  it('excludes flags block when registry is empty', async () => {
    const registry = createRuntimeFlagRegistry();
    const svc = makeBudgetService(() => registry);
    const msgs = await svc.buildSystemMessages();
    expect(msgs.length).toBe(1);
    expect(msgs[0].content).not.toContain('Runtime Flags');
  });

  it('includes flags block when registry has list-mount flag', async () => {
    const registry = createRuntimeFlagRegistry();
    registry.append('list-mount', 'file');
    registry.append('list-mount', 'lsp');
    const svc = makeBudgetService(() => registry);
    const msgs = await svc.buildSystemMessages();
    expect(msgs.length).toBe(2);
    expect(msgs[0].content).not.toContain('Runtime Flags');
    expect(msgs[1].content).toContain('# Runtime Flags');
    expect(msgs[1].content).toContain('## List/Mount Pattern');
    expect(msgs[1].content).toContain('Active list-mount plugins: file, lsp');
  });

  it('includes flags block for non-list-mount flags', async () => {
    const registry = createRuntimeFlagRegistry();
    registry.set('debug', 'llm');
    const svc = makeBudgetService(() => registry);
    const msgs = await svc.buildSystemMessages();
    expect(msgs.length).toBe(2);
    expect(msgs[1].content).toContain('# Runtime Flags');
    expect(msgs[1].content).toContain('debug: llm');
  });
});
