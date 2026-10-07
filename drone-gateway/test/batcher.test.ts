import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { MessageBatcher } from '../src/batcher.js';
import type { AdapterMessage } from '../src/types.js';

function msg(text: string): AdapterMessage {
  return {
    adapterId: 'a',
    conversationId: 'conv-1',
    text,
    conversationKind: 'dm',
  };
}

describe('MessageBatcher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('flushes a single push once after the debounce window', () => {
    const flush = vi.fn();
    const batcher = new MessageBatcher(500, flush);

    batcher.push(msg('one'));
    expect(flush).not.toHaveBeenCalled();

    vi.advanceTimersByTime(499);
    expect(flush).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush.mock.calls[0][0].map((m: AdapterMessage) => m.text)).toEqual([
      'one',
    ]);
  });

  it('coalesces pushes inside the window into one batch in arrival order', () => {
    const flush = vi.fn();
    const batcher = new MessageBatcher(500, flush);

    batcher.push(msg('a'));
    vi.advanceTimersByTime(200);
    batcher.push(msg('b'));
    vi.advanceTimersByTime(200);
    batcher.push(msg('c'));

    // Still within the (restarted) window.
    expect(flush).not.toHaveBeenCalled();

    vi.advanceTimersByTime(500);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush.mock.calls[0][0].map((m: AdapterMessage) => m.text)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('starts a new batch after a flush', () => {
    const flush = vi.fn();
    const batcher = new MessageBatcher(500, flush);

    batcher.push(msg('first'));
    vi.advanceTimersByTime(500);
    expect(flush).toHaveBeenCalledTimes(1);

    batcher.push(msg('second'));
    vi.advanceTimersByTime(500);
    expect(flush).toHaveBeenCalledTimes(2);
    expect(flush.mock.calls[1][0].map((m: AdapterMessage) => m.text)).toEqual([
      'second',
    ]);
  });

  it('flushes on the next tick when debounceMs is 0', () => {
    const flush = vi.fn();
    const batcher = new MessageBatcher(0, flush);

    batcher.push(msg('now'));
    expect(flush).not.toHaveBeenCalled();

    vi.advanceTimersByTime(0);

    // A 0ms timeout still fires asynchronously; drain the macrotask queue.
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush.mock.calls[0][0].map((m: AdapterMessage) => m.text)).toEqual([
      'now',
    ]);
  });

  it('dispose cancels a pending flush and drops the buffer', () => {
    const flush = vi.fn();
    const batcher = new MessageBatcher(500, flush);

    batcher.push(msg('dropped'));
    batcher.dispose();

    vi.advanceTimersByTime(1000);
    expect(flush).not.toHaveBeenCalled();

    // A push after dispose starts fresh (no stale buffered message).
    batcher.push(msg('fresh'));
    vi.advanceTimersByTime(500);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush.mock.calls[0][0].map((m: AdapterMessage) => m.text)).toEqual([
      'fresh',
    ]);
  });
});
