import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import { makePlainOutputEventHandler } from '../src/output-handlers.js';

describe('makePlainOutputEventHandler', () => {
  let stdoutWriteSpy: MockInstance<typeof process.stdout.write>;

  beforeEach(() => {
    stdoutWriteSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function writtenLines(): string[] {
    return stdoutWriteSpy.mock.calls.map(call => String(call[0]));
  }

  it('suppresses assistantMessage by default', () => {
    const handler = makePlainOutputEventHandler();
    handler({ kind: 'assistantMessage', content: 'hello' });
    expect(writtenLines()).toEqual([]);
  });

  it('renders assistantMessage when renderAssistantMessage is true', () => {
    const handler = makePlainOutputEventHandler({
      renderAssistantMessage: true,
    });
    handler({ kind: 'assistantMessage', content: 'hello' });
    expect(writtenLines()).toEqual(['hello\n']);
  });

  it('still renders other event kinds regardless of the flag', () => {
    const handler = makePlainOutputEventHandler({
      renderAssistantMessage: true,
    });
    handler({ kind: 'reasoning', content: 'thinking' });
    handler({ kind: 'error', message: 'boom' });
    expect(writtenLines().join('')).toContain('thinking');
    expect(writtenLines().join('')).toContain('boom');
  });
});
