import { describe, expect, it } from 'vitest';
import type { DroneConversationEvent } from 'drone-core';

import {
  ConversationWindowTracker,
  filterForQuery,
} from '../../../src/plugins/swarm/memory-window.js';

function userMessage(content: string): DroneConversationEvent {
  return { kind: 'userMessage', content };
}

function assistantMessage(content: string): DroneConversationEvent {
  return { kind: 'assistantMessage', content };
}

describe('ConversationWindowTracker', () => {
  it('keeps the in-flight round as current and the last completed round as previous', () => {
    const tracker = new ConversationWindowTracker();
    tracker.onEvent(userMessage('How does the fragment TTL sweep work?'));
    tracker.onEvent(assistantMessage('The beacon runs it every 60s.'));
    tracker.onEvent({ kind: 'roundComplete' });
    tracker.onEvent(userMessage('make it configurable'));
    tracker.onEvent(assistantMessage('Added TTL_SWEEP_INTERVAL_MS.'));
    tracker.onEvent({ kind: 'roundComplete' });
    tracker.onEvent(userMessage('now wire it into the tests'));

    const parts = tracker.assemble();
    expect(parts.currentQuery).toBe('now wire it into the tests');
    expect(parts.prevUserQuery).toBe('make it configurable');
    expect(parts.prevResponse).toBe('Added TTL_SWEEP_INTERVAL_MS.');
  });

  it('roundComplete closes rounds; error/cancel paths still mark the boundary', () => {
    const tracker = new ConversationWindowTracker();
    tracker.onEvent(userMessage('first question about sqlite-vec'));
    tracker.onEvent(assistantMessage('sqlite-vec stores 768-dim vectors.'));
    tracker.onEvent({ kind: 'roundComplete' });
    tracker.onEvent(userMessage('go on'));

    const parts = tracker.assemble();
    expect(parts.prevUserQuery).toBe('first question about sqlite-vec');
    expect(parts.prevResponse).toContain('768-dim');
    expect(parts.currentQuery).toBe('go on');
  });

  it('assistant messages during a round keep overwriting the final response', () => {
    const tracker = new ConversationWindowTracker();
    tracker.onEvent(userMessage('do the thing'));
    tracker.onEvent(assistantMessage('interim thought'));
    tracker.onEvent(assistantMessage('final answer'));
    tracker.onEvent({ kind: 'roundComplete' });
    tracker.onEvent(userMessage('next'));

    expect(tracker.assemble().prevResponse).toBe('final answer');
  });

  it('steering messages land in the steering list of the in-flight round', () => {
    const tracker = new ConversationWindowTracker();
    tracker.onEvent(userMessage('start'));
    tracker.onEvent({ kind: 'roundComplete' });
    tracker.onEvent(userMessage('real query'));
    // enqueueUserMessage mid-round emits another userMessage before complete:
    tracker.onEvent(userMessage('steering note'));
    tracker.onEvent(assistantMessage('done'));
    tracker.onEvent({ kind: 'roundComplete' });
    tracker.onEvent(userMessage('next question'));

    const parts = tracker.assemble();
    expect(parts.prevUserQuery).toBe('real query');
    expect(parts.prevSteering).toEqual(['steering note']);
    expect(parts.prevResponse).toBe('done');
    expect(parts.currentQuery).toBe('next question');
  });

  it('ignores tool/progress events entirely', () => {
    const tracker = new ConversationWindowTracker();
    tracker.onEvent(userMessage('question'));
    tracker.onEvent({ kind: 'toolCall', name: 'file__read', arguments: {} });
    tracker.onEvent({
      kind: 'toolResult',
      name: 'file__read',
      content: '{"lots":"of json"}',
      arguments: {},
    });
    tracker.onEvent(assistantMessage('answer'));
    const parts = tracker.assemble();
    expect(parts.currentQuery).toBe('question');
    // The response belongs to the in-flight round → not in the window yet.
    expect(parts.prevResponse).toBe('');
    expect(tracker.assemble().currentQuery).toBe('question');
  });

  it('reset clears all tracked state', () => {
    const tracker = new ConversationWindowTracker();
    tracker.onEvent(userMessage('q'));
    tracker.onEvent(assistantMessage('a'));
    tracker.onEvent({ kind: 'roundComplete' });
    tracker.reset();
    const parts = tracker.assemble();
    expect(parts.currentQuery).toBe('');
    expect(parts.prevUserQuery).toBe('');
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
    const text = 'Fix `/src/foo/bar.ts`:\n```json\n{"a":1}\n``` then run tests';
    expect(filterForQuery(text)).toBe(filterForQuery(text));
  });
});
