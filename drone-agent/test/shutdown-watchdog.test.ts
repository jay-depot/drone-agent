import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  armShutdownWatchdog,
  SHUTDOWN_RESIDUAL_MS,
} from '../src/runtime/shutdown-watchdog.js';

describe('armShutdownWatchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('forces exit(1) once the deadline elapses', () => {
    armShutdownWatchdog(30_000);
    expect(process.exit).not.toHaveBeenCalled();

    vi.advanceTimersByTime(29_999);
    expect(process.exit).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(process.exit).toHaveBeenCalledTimes(1);
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('disarm clears the watchdog and arms a residual timer at SHUTDOWN_RESIDUAL_MS', () => {
    const disarm = armShutdownWatchdog(30_000);

    disarm();
    vi.advanceTimersByTime(SHUTDOWN_RESIDUAL_MS - 1);
    expect(process.exit).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(process.exit).toHaveBeenCalledTimes(1);
    expect(process.exit).toHaveBeenCalledWith(process.exitCode ?? 0);

    // The cleared watchdog must not fire exit(1) past the arming deadline.
    vi.advanceTimersByTime(30_000);
    expect(process.exit).toHaveBeenCalledTimes(1);
  });

  it('disarm is idempotent: a second call does not re-arm the residual timer', () => {
    const disarm = armShutdownWatchdog(30_000);

    disarm();
    disarm();
    vi.advanceTimersByTime(30_000 + SHUTDOWN_RESIDUAL_MS);
    expect(process.exit).toHaveBeenCalledTimes(1);
  });

  it('calls unref on the watchdog and residual timers', () => {
    const unrefSpies: Array<ReturnType<typeof vi.fn>> = [];
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(
      ((_handler: TimerHandler, _timeout?: number) => {
        const unref = vi.fn();
        unrefSpies.push(unref);
        return { unref, ref: vi.fn() };
      }) as typeof setTimeout
    );

    const disarm = armShutdownWatchdog(30_000);
    disarm();

    expect(unrefSpies).toHaveLength(2);
    for (const unref of unrefSpies) {
      expect(unref).toHaveBeenCalledTimes(1);
    }
  });
});
