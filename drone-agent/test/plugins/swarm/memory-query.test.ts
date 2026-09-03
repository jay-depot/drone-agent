import { describe, expect, it } from 'vitest';

import { buildQueryInputs } from '../../../src/plugins/swarm/memory-query.js';
import type { WindowParts } from '../../../src/plugins/swarm/memory-window.js';

function parts(overrides: Partial<WindowParts> = {}): WindowParts {
  return {
    currentQuery: 'how does vec0 mirroring work',
    prevUserQuery: 'explain the beacon sqlite index',
    prevSteering: [],
    prevResponse: 'The beacon mirrors chunks into a vec0 virtual table.',
    ...overrides,
  };
}

describe('buildQueryInputs', () => {
  it('puts the current query first and the window second for small sessions', () => {
    const result = buildQueryInputs(parts());
    expect(result.inputs).toHaveLength(2);
    expect(result.inputs[0]).toBe('how does vec0 mirroring work');
    expect(result.inputs[1]).toContain('explain the beacon sqlite index');
    expect(result.inputs[1]).toContain('vec0');
  });

  it('keeps the current query verbatim as the first input for over-budget windows', () => {
    const bigResponse = 'paragraph about vector search. '.repeat(2000);
    const result = buildQueryInputs(parts({ prevResponse: bigResponse }), {
      maxQueryTokens: 600,
      maxQuerySegments: 2,
    });
    expect(result.inputs[0]).toBe('how does vec0 mirroring work');
    expect(result.inputs.length).toBeLessThanOrEqual(3);
    for (const input of result.inputs.slice(1)) {
      expect(input.length).toBeLessThan(600 * 6);
    }
  });

  it('caps window segments at maxQuerySegments', () => {
    const response = Array.from(
      { length: 60 },
      (_, i) => `Section ${i}: discusses embedding indexes and retrieval.`
    ).join('\n\n');
    const result = buildQueryInputs(parts({ prevResponse: response }), {
      maxQueryTokens: 40,
      maxQuerySegments: 3,
    });
    expect(result.inputs.length).toBeLessThanOrEqual(4); // current query + 3
    expect(result.inputs[0]).toBe('how does vec0 mirroring work');
  });

  it('drops the OLDEST window segments, keeping the most recent fitting ones', () => {
    const response = [
      'Old topic: the persona broker sorts providers by precedence.',
      'Middle topic: compaction triggers at fifty percent.',
      'Recent topic: the wiki indexer reconciles nightly.',
    ].join('\n\n');
    const result = buildQueryInputs(parts({ prevResponse: response }), {
      maxQueryTokens: 30,
      maxQuerySegments: 2,
    });
    const windowInput = result.inputs[1] ?? '';
    expect(windowInput).toContain('wiki indexer');
    expect(windowInput).not.toContain('persona broker');
  });

  it('produces a stable hash for identical windows and a different one for changed windows', () => {
    const a = buildQueryInputs(parts());
    const b = buildQueryInputs(parts());
    expect(a.hash).toBe(b.hash);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);

    const c = buildQueryInputs(
      parts({ currentQuery: 'something else entirely' })
    );
    expect(c.hash).not.toBe(a.hash);
  });

  it('filters tool noise out of the assembled window input', () => {
    const result = buildQueryInputs(
      parts({
        prevResponse:
          'Read the file.\n```json\n{"toolCalls": [1,2,3]}\n```\nIt contains /long/path/to/some/module/deep/file.ts inside.',
      })
    );
    const window = result.inputs[1] ?? '';
    expect(window).toContain('Read the file');
    expect(window).not.toContain('toolCalls');
    expect(window).not.toContain('/some/module/deep');
  });
});
