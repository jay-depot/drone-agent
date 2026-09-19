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

  it('renders an aside with the question and answer, without throwing', () => {
    const handler = makePlainOutputEventHandler();
    expect(() =>
      handler({
        kind: 'aside',
        question: 'what is the plan?',
        answer: 'it is make deploy.',
      })
    ).not.toThrow();
    const out = writtenLines().join('');
    expect(out).toContain('what is the plan?');
    expect(out).toContain('it is make deploy.');
  });
});
