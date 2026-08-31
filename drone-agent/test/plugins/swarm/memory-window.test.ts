import { describe, expect, it } from 'vitest';
import type { DroneSessionMessage } from 'drone-core';

import {
  assembleWindow,
  filterForQuery,
} from '../../../src/plugins/swarm/memory-window.js';

function msg(
  role: DroneSessionMessage['role'],
  content: string
): DroneSessionMessage {
  return { role, content };
}

describe('assembleWindow', () => {
  it('extracts the previous round and current query from a realistic session', () => {
    const messages: DroneSessionMessage[] = [
      msg('system', 'system prompt'),
      msg('user', 'How does the fragment TTL sweep work?'),
      msg(
        'assistant',
        'The beacon runs a TTL sweep every 60s that deletes expired rows.'
      ),
      msg('user', 'now make it configurable'),
      msg('assistant', 'Done — added TTL_SWEEP_INTERVAL_MS.'),
      msg('user', 'now wire it into the tests')
    ];

    const parts = assembleWindow(() => messages, 'also update the docs');

    expect(parts.currentQuery).toBe('also update the docs');
    expect(parts.prevUserQuery).toBe('now make it configurable');
    expect(parts.prevResponse).toBe('Done — added TTL_SWEEP_INTERVAL_MS.');
  });

  it('collects steering messages after the first user message', () => {
    const messages: DroneSessionMessage[] = [
      msg('user', 'fix the beacon bug'),
      msg('assistant', 'checking the socket code'),
      // Assistant still holds toolCalls → user reply is steering, not a new round:
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 't1', name: 'exec__run', arguments: {} }],
      } as unknown as DroneSessionMessage,
      msg('tool', '{"exit": 0}'),
      msg('user', 'actually focus on the readyState one'),
      msg('assistant', 'Fixed the numeric readyState comparison.')
    ];

    const parts = assembleWindow(() => messages, 'next');

    expect(parts.prevUserQuery).toBe('fix the beacon bug');
    expect(parts.prevSteering).toEqual(['actually focus on the readyState one']);
    expect(parts.prevResponse).toBe('Fixed the numeric readyState comparison.');
  });

  it('skips the trailing round when it has no assistant response', () => {
    const messages: DroneSessionMessage[] = [
      msg('user', 'first real question about sqlite-vec'),
      msg('assistant', 'sqlite-vec stores 768-dim vectors.'),
      msg('user', 'hmm'),
      msg('tool', '{"result": "pending"}')
    ];

    const parts = assembleWindow(() => messages, 'go on');

    expect(parts.prevUserQuery).toBe('first real question about sqlite-vec');
    expect(parts.prevResponse).toContain('768-dim');
  });

  it('returns empty previous parts for a brand-new session', () => {
    const parts = assembleWindow(() => [], 'hello there');
    expect(parts.currentQuery).toBe('hello there');
    expect(parts.prevUserQuery).toBe('');
    expect(parts.prevSteering).toEqual([]);
    expect(parts.prevResponse).toBe('');
  });
});

describe('filterForQuery', () => {
  it('strips fenced code blocks', () => {
    const filtered = filterForQuery(
      'Here is the fix:\n```ts\nconst x = 42;\nconst y = x * 2;\n```\nLet me know.'
    );
    expect(filtered).toBe('Here is the fix: Let me know.');
  });

  it('strips paths, hashes, and symbol-dense runs', () => {
    const filtered = filterForQuery(
      'Check /home/unleet/Projects/drone-agent/src/runtime/plugin-engine.ts — ' +
        'commit 86b208b1a2c3d4e5f6a7b8c9d0e1f2a3 broke configureSomethingWithTheseOptions'
    );
    expect(filtered).not.toContain('drone-agent');
    expect(filtered).not.toContain('86b208b');
    expect(filtered).toContain('Check');
    expect(filtered).toContain('broke');
  });

  it('keeps ordinary prose and questions intact', () => {
    const text =
      'How does the semantic search scoring combine cosine with anchor boosts?';
    expect(filterForQuery(text)).toBe(text);
  });

  it('collapses whitespace', () => {
    expect(filterForQuery('a\n\n\nb   c')).toBe('a b c');
  });

  it('is deterministic for identical input', () => {
    const text =
      'Fix `/src/foo/bar.ts`:\n```json\n{"a":1}\n``` then run tests';
    expect(filterForQuery(text)).toBe(filterForQuery(text));
  });
});