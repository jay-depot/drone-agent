import { describe, expect, it } from 'vitest';
import type {
  DroneChatMessage,
  DroneContextWindowInfo,
  DroneToolDescriptor,
} from 'drone-core';
import { createDefaultAgentConfig } from 'drone-core';
import { createContextBudgetService } from '../src/runtime/context-budget-service.js';

/**
 * Regression tests for the status-bar context percentage.
 *
 * Bug being documented: the Phase 2 driver conversion dropped
 * getContextWindowInfo from every non-ollama protocol plugin, so the budget
 * service fell back to session.contextWindowTokens (default 32768) and a
 * fresh session on a 1M-token model displayed >50% used.
 */

const FRESH_SESSION_INPUT = (() => {
  const systemMessages: DroneChatMessage[] = [
    { role: 'system', content: 'S'.repeat(60_000) },
  ];
  const tools: DroneToolDescriptor[] = Array.from({ length: 40 }, (_, i) => ({
    name: `tool_${i}`,
    description: 'd'.repeat(800),
    inputSchema: {
      type: 'object',
      properties: { x: { type: 'string', description: 'p'.repeat(400) } },
    },
  }));
  return { systemMessages, turns: [], tools };
})();

const ONE_MILLION_WINDOW: DroneContextWindowInfo = {
  model: 'anthropic/claude-sonnet-4-6',
  contextWindowTokens: 1_000_000,
  source: 'metadata',
};

// The old effective denominator: probe missing + no metadata → default.
const STALE_DEFAULT_WINDOW: DroneContextWindowInfo = {
  model: 'anthropic/claude-sonnet-4-6',
  contextWindowTokens: 32_768,
  source: 'default',
};

function makeService() {
  return createContextBudgetService({
    config: createDefaultAgentConfig(),
    renderPromptFragments: async () => [],
    getProvider: () => ({ chat: async () => ({ message: '' }) }),
    getModel: () => 'claude-sonnet-4-6',
  });
}

describe('fresh-session context percentage', () => {
  it('is low single digits against a declared 1M window', () => {
    const svc = makeService();
    const percent = svc.getEstimatedContextUsagePercent({
      ...FRESH_SESSION_INPUT,
      contextWindow: ONE_MILLION_WINDOW,
    });
    expect(percent).toBeGreaterThan(0);
    expect(percent).toBeLessThan(10);
  });

  it('does not require safety trim against a declared 1M window', () => {
    const svc = makeService();
    const snapshot = svc.getBudgetSnapshot({
      ...FRESH_SESSION_INPUT,
      contextWindow: ONE_MILLION_WINDOW,
    });
    expect(snapshot.budget.requiresSafetyTrim).toBe(false);
  });

  it('reproduces the pre-fix failure mode against the stale 32768 default (>50%)', () => {
    // Documents why the fix matters: identical prompt weight, collapsed
    // denominator. This is exactly what users saw before broker metadata
    // resolution existed.
    const svc = makeService();
    const percent = svc.getEstimatedContextUsagePercent({
      ...FRESH_SESSION_INPUT,
      contextWindow: STALE_DEFAULT_WINDOW,
    });
    expect(percent).toBeGreaterThan(50);
  });
});
