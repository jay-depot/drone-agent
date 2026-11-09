import type { Job, Limits } from '../board-types.js';

/**
 * Scheduler persistence contract. Keeps the limits and the job queue behind an
 * interface so the pacing logic never touches the filesystem directly.
 */
export interface SchedulerStore {
  getLimits(): Promise<Limits>;
  setLimits(patch: Partial<Limits>): Promise<Limits>;
  listJobs(): Promise<Job[]>;
  enqueueJob(job: Job): Promise<void>;
  updateJob(jobId: string, patch: Partial<Job>): Promise<Job | undefined>;
}
