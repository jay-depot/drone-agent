/**
 * NDJSON stdin control commands for portable context (§0 of the plan):
 * `exportContext` / `importContext` are control commands on the same stdin
 * stream — not turns. They must not run the prompt hooks and must not emit
 * `turnComplete`.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';

const INPUT_LINES: string[] = [];

vi.mock('node:readline/promises', () => ({
  createInterface: () => ({
    async *[Symbol.asyncIterator]() {
      for (const line of INPUT_LINES) {
        yield line;
      }
    },
    close: () => {},
  }),
}));

import { runJsonListenMode } from '../src/interactive.js';

function makeEngine(importImpl?: (data: unknown) => Promise<unknown>) {
  const exportContext = vi.fn(async () => ({
    version: 1,
    createdAt: '2026-10-11T00:00:00.000Z',
    session: { sourceSessionId: 's', turns: [] },
    tools: [],
    pluginData: {},
  }));
  const importContext = vi.fn(
    importImpl ??
      (async () => ({ warnings: ['w1'], unavailableTools: ['gone__tool'] }))
  );
  const runHooks = vi.fn(async () => {});
  return {
    engine: {
      getCapability: (id: string) =>
        id === 'portable-context' ? { exportContext, importContext } : undefined,
      onConversationEvent: () => () => {},
      runHooks,
    },
    exportContext,
    importContext,
    runHooks,
  };
}

describe('NDJSON portable-context control commands', () => {
  let stdoutWriteSpy: MockInstance<typeof process.stdout.write>;

  beforeEach(() => {
    INPUT_LINES.length = 0;
    stdoutWriteSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function written(): string {
    return stdoutWriteSpy.mock.calls.map(call => String(call[0])).join('');
  }

  it('exportContext emits a contextExport and no turnComplete', async () => {
    INPUT_LINES.push(JSON.stringify({ type: 'exportContext' }));
    const { engine, exportContext } = makeEngine();

    await runJsonListenMode(
      {} as unknown as Parameters<typeof runJsonListenMode>[0],
      engine as unknown as Parameters<typeof runJsonListenMode>[1]
    );

    expect(exportContext).toHaveBeenCalledOnce();
    const out = written();
    expect(out).toContain('"kind":"contextExport"');
    expect(out).toContain('"ok":true');
    expect(out).not.toContain('"turnComplete"');
  });

  it('importContext emits a contextImport with warnings + unavailableTools, no turnComplete', async () => {
    INPUT_LINES.push(
      JSON.stringify({ type: 'importContext', context: { version: 1 } })
    );
    const { engine, importContext, runHooks } = makeEngine();

    await runJsonListenMode(
      {} as unknown as Parameters<typeof runJsonListenMode>[0],
      engine as unknown as Parameters<typeof runJsonListenMode>[1]
    );

    expect(importContext).toHaveBeenCalledOnce();
    const out = written();
    expect(out).toContain('"kind":"contextImport"');
    expect(out).toContain('"unavailableTools":["gone__tool"]');
    expect(out).not.toContain('"turnComplete"');
    // Control commands never run the prompt hooks.
    expect(runHooks).not.toHaveBeenCalledWith('onBeforePrompt');
  });

  it('a failing import yields contextImport ok:false with an error', async () => {
    INPUT_LINES.push(
      JSON.stringify({ type: 'importContext', context: { version: 99 } })
    );
    const { engine } = makeEngine(async () => {
      throw new Error('Unsupported portable-context version 99');
    });

    await runJsonListenMode(
      {} as unknown as Parameters<typeof runJsonListenMode>[0],
      engine as unknown as Parameters<typeof runJsonListenMode>[1]
    );

    const out = written();
    expect(out).toContain('"kind":"contextImport"');
    expect(out).toContain('"ok":false');
    expect(out).toContain('Unsupported portable-context version 99');
  });

  it('emits ok:false when the capability is unavailable', async () => {
    INPUT_LINES.push(JSON.stringify({ type: 'exportContext' }));
    const engine = {
      getCapability: () => undefined,
      onConversationEvent: () => () => {},
      runHooks: async () => {},
    };

    await runJsonListenMode(
      {} as unknown as Parameters<typeof runJsonListenMode>[0],
      engine as unknown as Parameters<typeof runJsonListenMode>[1]
    );

    const out = written();
    expect(out).toContain('"kind":"contextExport"');
    expect(out).toContain('"ok":false');
  });
});
