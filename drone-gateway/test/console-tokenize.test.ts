import { describe, expect, it } from 'vitest';
import { tokenize } from '../src/console/tokenize.js';

describe('tokenize', () => {
  it('splits on whitespace', () => {
    expect(tokenize('swarm.beacon.list')).toEqual(['swarm.beacon.list']);
    expect(tokenize('swarm.agent.status   agent-1')).toEqual([
      'swarm.agent.status',
      'agent-1',
    ]);
  });

  it('collapses whitespace runs including tabs and newlines', () => {
    expect(tokenize('a\t\tb\n c')).toEqual(['a', 'b', 'c']);
  });

  it('returns an empty array for empty or whitespace-only input', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize('   \t ')).toEqual([]);
  });

  it('groups double-quoted text', () => {
    expect(tokenize('swarm.broadcast "hello world"')).toEqual([
      'swarm.broadcast',
      'hello world',
    ]);
  });

  it('groups single-quoted text', () => {
    expect(tokenize("swarm.agent.inject a 'fix the bug'")).toEqual([
      'swarm.agent.inject',
      'a',
      'fix the bug',
    ]);
  });

  it('preserves empty quotes as an empty token', () => {
    expect(tokenize('a "" b')).toEqual(['a', '', 'b']);
  });

  it('keeps flags inside quotes as literal text', () => {
    expect(tokenize('swarm.broadcast "a --b c"')).toEqual([
      'swarm.broadcast',
      'a --b c',
    ]);
  });

  it('takes the rest of the line on an unterminated quote', () => {
    expect(tokenize('a "unterminated rest')).toEqual([
      'a',
      'unterminated rest',
    ]);
    expect(tokenize("a 'unterminated rest")).toEqual([
      'a',
      'unterminated rest',
    ]);
  });
});
