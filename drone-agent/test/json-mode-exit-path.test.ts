/**
 * `runJsonMode` error path: on a sendUserMessage failure the NDJSON error +
 * return events must still be emitted, but the process must exit via
 * `process.exitCode = 1` (not `process.exit(1)`) so the in-process
 * `onShutdown` hooks run before the process actually exits.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';

vi.mock('node:readline/promises', () => ({
  createInterface: () => ({
    async *[Symbol.asyncIterator]() {
      yield JSON.stringify({ type: 'kickoff', task: 'do the thing' });
    },
    close: () => {},
  }),
}));

import { runJsonMode } from '../src/interactive.js';

function makeEngine(runtime?: { subagentId?: string }) {
  return {
    getCapability: <T>(_id: string) => runtime as unknown as T,
    runHooks: async () => {},
  };
}

describe('runJsonMode error path', () => {
  let stdoutWriteSpy: MockInstance<typeof process.stdout.write>;
  let exitSpy: MockInstance<typeof process.exit>;
  const originalExitCode = process.exitCode;

  beforeEach(() => {
    stdoutWriteSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    // Spy on process.exit WITHOUT invoking it (mockImplementation replaces),
    // so a regression back to process.exit(1) is detectable without killing
    // the test runner.
    exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as typeof process.exit);
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
  });

  function written(): string {
    return stdoutWriteSpy.mock.calls.map(call => String(call[0])).join('');
  }

  it('sets process.exitCode=1 instead of calling process.exit on failure', async () => {
    const engine = makeEngine({ subagentId: 'sub-1' });
    const conversation = {
      sendUserMessage: async () => {
        throw new Error('boom');
      },
    };

    await runJsonMode(
      conversation as unknown as Parameters<typeof runJsonMode>[0],
      engine as unknown as Parameters<typeof runJsonMode>[1]
    );

    expect(process.exitCode).toBe(1);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('still emits error and return NDJSON events before exiting', async () => {
    const engine = makeEngine({ subagentId: 'sub-1' });
    const conversation = {
      sendUserMessage: async () => {
        throw new Error('boom');
      },
    };

    await runJsonMode(
      conversation as unknown as Parameters<typeof runJsonMode>[0],
      engine as unknown as Parameters<typeof runJsonMode>[1]
    );

    const out = written();
    expect(out).toContain('"kind":"error"');
    expect(out).toContain('boom');
    expect(out).toContain('"kind":"return"');
    expect(out).toContain('"subagentId":"sub-1"');
  });
});
