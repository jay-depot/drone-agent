/**
 * Boot reconcile for spawn jobs that were `running` when the node restarted.
 *
 * The coordinator replays `sessionStarted` for every active session on connect,
 * so a job whose session still exists is confirmed by that replay. A job that
 * is never confirmed within the settle window is stale and gets failed.
 *
 * The tracker holds no timers of its own beyond one settle timer, so it is
 * unit-testable with an injected clock and a manual settle trigger.
 */
export interface ReconcileTrackerDeps {
  /** Called with the ids of jobs that were never confirmed. */
  onSettle: (staleJobIds: string[]) => Promise<void>;
  /** Settle window in ms (default 30s). */
  settleMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout;
}

const DEFAULT_SETTLE_MS = 30_000;

/**
 * Tracks the set of `running` jobs awaiting confirmation across a restart.
 *
 * At boot, `seed()` records every `running` job. A `sessionStarted` for a job
 * calls `confirm(jobId)` to remove it. After the settle window from the first
 * socket connect, `armSettle()` fires `onSettle` with whatever remains.
 */
export class ReconcileTracker {
  private readonly pending = new Set<string>();
  private readonly onSettle: (staleJobIds: string[]) => Promise<void>;
  private readonly settleMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => NodeJS.Timeout;
  private armed = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(deps: ReconcileTrackerDeps) {
    this.onSettle = deps.onSettle;
    this.settleMs = deps.settleMs ?? DEFAULT_SETTLE_MS;
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  }

  /** Record a job id awaiting confirmation. */
  seed(jobIds: string[]): void {
    for (const id of jobIds) this.pending.add(id);
  }

  /** Remove a job id from the pending set (its session re-announced itself). */
  confirm(jobId: string): void {
    this.pending.delete(jobId);
  }

  /** Ids still awaiting confirmation. */
  pendingIds(): string[] {
    return [...this.pending];
  }

  /** Arm the settle timer (call once, on the first socket connect). */
  armSettle(): void {
    if (this.armed) return;
    this.armed = true;
    this.timer = this.setTimer(() => {
      this.timer = null;
      const stale = [...this.pending];
      this.pending.clear();
      void this.onSettle(stale);
    }, this.settleMs);
  }

  /** Cancel the settle timer. */
  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
