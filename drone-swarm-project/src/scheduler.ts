import type { Job, Limits, Project } from './board-types.js';
import type { BoardStore } from './store/board-store.js';
import type { SchedulerStore } from './store/scheduler-store.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** The minimum spacing between starts, derived from the daily cap. */
export function intervalMs(limits: Limits): number {
  if (limits.maxDailySessions <= 0) return 0;
  return DAY_MS / limits.maxDailySessions;
}

export interface SchedulerDeps {
  store: SchedulerStore;
  board: BoardStore;
  spawn: (
    job: Job,
    project: Project
  ) => Promise<{ spawnId: string; agentId: string }>;
  now?: () => number;
  logger?: (msg: string) => void;
}

/**
 * Paces spawn starts against three gates (concurrency, rolling-24h daily cap,
 * spacing). Every matching move enqueues a job; the drain loop starts at most
 * `maxConcurrentSessions` jobs per tick, oldest first.
 */
export class Scheduler {
  private readonly store: SchedulerStore;
  private readonly board: BoardStore;
  private readonly spawn: SchedulerDeps['spawn'];
  private readonly clock: () => number;
  private readonly logger: (msg: string) => void;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(deps: SchedulerDeps) {
    this.store = deps.store;
    this.board = deps.board;
    this.spawn = deps.spawn;
    this.clock = deps.now ?? (() => Date.now());
    this.logger = deps.logger ?? (() => {});
  }

  /** Enqueue a job, then evaluate the gates. */
  async enqueue(job: Job): Promise<void> {
    await this.store.enqueueJob(job);
    await this.tick();
  }

  /** Evaluate the three gates and start at most `maxConcurrentSessions` jobs. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const limits = await this.store.getLimits();
      let starts = 0;
      while (starts < Math.max(1, limits.maxConcurrentSessions)) {
        const jobs = await this.store.listJobs();
        const current = this.clock();
        if (!this.gatesPass(jobs, limits, current)) return;
        const queued = jobs
          .filter(job => job.state === 'queued')
          .sort((a, b) => a.createdAt - b.createdAt);
        const next = queued[0];
        if (!next) return;
        await this.store.updateJob(next.id, {
          state: 'running',
          startedAt: current,
        });
        starts++;
        await this.startJob({ ...next, state: 'running', startedAt: current });
      }
    } finally {
      this.ticking = false;
    }
  }

  private gatesPass(jobs: Job[], limits: Limits, current: number): boolean {
    const running = jobs.filter(job => job.state === 'running').length;
    if (running >= limits.maxConcurrentSessions) return false;

    const windowStart = current - DAY_MS;
    const startedInWindow = jobs.filter(
      job => job.startedAt !== undefined && job.startedAt > windowStart
    ).length;
    if (startedInWindow >= limits.maxDailySessions) return false;

    const lastStartedAt = jobs.reduce<number | undefined>((max, job) => {
      if (job.startedAt === undefined) return max;
      return max === undefined || job.startedAt > max ? job.startedAt : max;
    }, undefined);
    if (lastStartedAt !== undefined) {
      if (current < lastStartedAt + intervalMs(limits)) return false;
    }
    return true;
  }

  private async startJob(job: Job): Promise<void> {
    const project = await this.board.getProject(job.projectId);
    if (!project) {
      await this.store.updateJob(job.id, {
        state: 'failed',
        endedAt: this.clock(),
        error: 'project not found',
      });
      return;
    }
    try {
      const { spawnId, agentId } = await this.spawn(job, project);
      await this.store.updateJob(job.id, { spawnId, agentId });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger(`spawn failed for job ${job.id}: ${message}`);
      await this.store.updateJob(job.id, {
        state: 'failed',
        endedAt: this.clock(),
        error: message,
      });
    }
  }

  /**
   * Mark stale `running` jobs failed. Called after the boot settle window with
   * the set of jobs whose session never re-announced itself.
   */
  async reconcile(staleJobIds: string[]): Promise<void> {
    for (const jobId of staleJobIds) {
      const jobs = await this.store.listJobs();
      const job = jobs.find(candidate => candidate.id === jobId);
      if (!job || job.state !== 'running') continue;
      await this.store.updateJob(jobId, {
        state: 'failed',
        endedAt: this.clock(),
        error: 'session not found after restart',
      });
      const card = await this.board.getCard(job.cardId);
      if (card) {
        await this.board.setCardSession({
          projectId: card.project.id,
          cardId: job.cardId,
          sessionStatus: 'failed',
        });
      }
    }
  }

  /** Start the periodic drain loop. */
  start(intervalMsValue = 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMsValue);
    this.timer.unref();
  }

  /** Stop the periodic drain loop. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
