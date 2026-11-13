import { describe, expect, it, vi } from 'vitest';
import { ReconcileTracker } from '../src/scheduler-reconcile.js';

describe('ReconcileTracker', () => {
  it('seeds running job ids and confirms on session start', () => {
    const tracker = new ReconcileTracker({ onSettle: async () => {} });
    tracker.seed(['j_1', 'j_2']);
    expect(tracker.pendingIds().sort()).toEqual(['j_1', 'j_2']);
    tracker.confirm('j_1');
    expect(tracker.pendingIds()).toEqual(['j_2']);
  });

  it('fails unconfirmed jobs after the settle window', async () => {
    vi.useFakeTimers();
    try {
      const onSettle = vi.fn(async () => {});
      const tracker = new ReconcileTracker({ onSettle, settleMs: 30_000 });
      tracker.seed(['j_1', 'j_2']);
      tracker.confirm('j_2');
      tracker.armSettle();
      expect(onSettle).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(onSettle).toHaveBeenCalledWith(['j_1']);
      expect(tracker.pendingIds()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('arms the settle timer only once', async () => {
    vi.useFakeTimers();
    try {
      const onSettle = vi.fn(async () => {});
      const tracker = new ReconcileTracker({ onSettle, settleMs: 1000 });
      tracker.seed(['j_1']);
      tracker.armSettle();
      tracker.armSettle();
      await vi.advanceTimersByTimeAsync(1000);
      expect(onSettle).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels the settle timer on stop', async () => {
    vi.useFakeTimers();
    try {
      const onSettle = vi.fn(async () => {});
      const tracker = new ReconcileTracker({ onSettle, settleMs: 1000 });
      tracker.seed(['j_1']);
      tracker.armSettle();
      tracker.stop();
      await vi.advanceTimersByTimeAsync(2000);
      expect(onSettle).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
