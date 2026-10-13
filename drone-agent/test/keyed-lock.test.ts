import { describe, expect, it } from 'vitest';
import { withKeyLock, withPathLock } from '../src/shared/keyed-lock.js';

describe('withKeyLock', () => {
  it('serializes same-key tasks in submission order', async () => {
    const order: string[] = [];
    const task = (label: string): Promise<void> =>
      withKeyLock('serialize-order-key', async () => {
        order.push(`${label}:start`);
        await new Promise(resolve => setTimeout(resolve, 5));
        order.push(`${label}:end`);
      });

    await Promise.all([task('a'), task('b'), task('c')]);
    expect(order).toEqual([
      'a:start',
      'a:end',
      'b:start',
      'b:end',
      'c:start',
      'c:end',
    ]);
  });

  it('runs different-key tasks concurrently', async () => {
    let active = 0;
    let maxActive = 0;
    const task = (key: string): Promise<void> =>
      withKeyLock(key, async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise(resolve => setTimeout(resolve, 5));
        active -= 1;
      });

    await Promise.all([task('concurrent-key-a'), task('concurrent-key-b')]);
    expect(maxActive).toBe(2);
  });

  it('does not poison the chain when a task rejects', async () => {
    await expect(
      withKeyLock('reject-key', async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    await expect(withKeyLock('reject-key', async () => 'ok')).resolves.toBe(
      'ok'
    );
  });
});

describe('withPathLock', () => {
  it('collapses dot-segments and case variants of one path', async () => {
    const order: string[] = [];
    await Promise.all([
      withPathLock('/tmp/A/../a.ts', async () => {
        order.push('first');
        await new Promise(resolve => setTimeout(resolve, 5));
        order.push('first-done');
      }),
      withPathLock('/tmp/a.TS', async () => {
        order.push('second');
      }),
    ]);
    expect(order).toEqual(['first', 'first-done', 'second']);
  });
});
