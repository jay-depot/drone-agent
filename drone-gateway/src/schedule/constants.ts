/** How often a schedule-enabled surface polls for due wake-ups. Not configurable in v1. */
export const DEFAULT_WAKEUP_TICK_MS = 15_000;

/** A wake turn that throws is retried; the row is dropped after this many attempts. */
export const MAX_WAKEUP_ATTEMPTS = 3;

/** Bound on the first-turn readiness wait: how long to wait for the session registry. */
export const SCHEDULE_READY_TIMEOUT_MS = 5_000;

/** Poll interval for the first-turn readiness wait. */
export const SCHEDULE_READY_POLL_MS = 250;

/** Injection id for the schedule guidance fragment. */
export const SCHEDULE_GUIDANCE_INJECTION_ID = 'schedule-guidance';
