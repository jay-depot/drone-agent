import { describe, expect, it } from 'vitest';
import {
  MAX_SYSTEM_REMINDERS,
  SystemReminderQueue,
} from '../src/runtime/system-reminders.js';

describe('SystemReminderQueue', () => {
  it('starts empty and drains to nothing', () => {
    const queue = new SystemReminderQueue();
    expect(queue.drainAll()).toEqual([]);
  });

  it('preserves FIFO order across drainAll', () => {
    const queue = new SystemReminderQueue();
    queue.queue('first');
    queue.queue('second');
    queue.queue('third');
    expect(queue.drainAll()).toEqual(['first', 'second', 'third']);
  });

  it('drains once — a second drain returns an empty array', () => {
    const queue = new SystemReminderQueue();
    queue.queue('only-once');
    expect(queue.drainAll()).toEqual(['only-once']);
    expect(queue.drainAll()).toEqual([]);
  });

  it('silently drops entries beyond the cap', () => {
    const queue = new SystemReminderQueue();
    for (let i = 0; i < MAX_SYSTEM_REMINDERS + 3; i++) {
      queue.queue(`r${i}`);
    }
    const drained = queue.drainAll();
    expect(drained).toHaveLength(MAX_SYSTEM_REMINDERS);
    expect(drained[0]).toBe('r0');
    expect(drained).not.toContain('r8');
  });

  it('accepts new entries after a drain', () => {
    const queue = new SystemReminderQueue();
    for (let i = 0; i < MAX_SYSTEM_REMINDERS; i++) {
      queue.queue(`r${i}`);
    }
    queue.queue('dropped');
    expect(queue.drainAll()).toHaveLength(MAX_SYSTEM_REMINDERS);
    queue.queue('accepted');
    expect(queue.drainAll()).toEqual(['accepted']);
  });

  it('clear() empties queued reminders without delivering them', () => {
    const queue = new SystemReminderQueue();
    queue.queue('stale');
    queue.clear();
    expect(queue.drainAll()).toEqual([]);
  });
});
