import { createCoordinatorFetch } from './coordinator-client.js';
import {
  dequeueDueOutbox,
  markOutboxDelivered,
  markOutboxFailed,
  deleteOutboxEntry,
  type OutboxEntry,
} from './db/index.js';
import { logger } from './logger.js';

const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_MAX_ATTEMPTS = 10;

export interface OutboxFlusherOptions {
  /** Returns the coordinator base URL, or undefined when not configured. */
  getBaseUrl: () => string | undefined;
  intervalMs: number;
  batchSize?: number;
  maxAttempts?: number;
  /** Injectable clock for due-time checks (tests). Defaults to Date.now. */
  now?: () => number;
}

export interface FlushResult {
  attempted: number;
  delivered: number;
  failed: number;
  dropped: number;
}

export interface OutboxFlusher {
  flushOnce(now?: number): Promise<FlushResult>;
  start(): void;
  stop(): void;
}

/**
 * Deliver queued outbox entries to the coordinator. Entries whose HTTP
 * responses were lost (connection reset mid-flight) are safe to treat 404s
 * as delivered because every outboxed route is idempotent under replay.
 */
async function deliverEntry(
  entry: OutboxEntry,
  baseUrl: string,
  fetcher: typeof fetch,
  maxAttempts: number
): Promise<'delivered' | 'failed' | 'dropped'> {
  if (entry.attempts >= maxAttempts) {
    logger.error(
      `Outbox entry ${entry.id} (${entry.kind} ${entry.endpoint}) dropped after ${entry.attempts} attempts: ${entry.lastError}`
    );
    deleteOutboxEntry(entry.id);
    return 'dropped';
  }
  try {
    const res = await fetcher(`${baseUrl}${entry.endpoint}`, {
      method: entry.method,
      headers: { 'Content-Type': 'application/json' },
      body: entry.body ?? undefined,
    });
    if (res.ok || res.status === 404) {
      markOutboxDelivered(entry.id);
      return 'delivered';
    }
    markOutboxFailed(entry.id, `status ${res.status}`);
    return 'failed';
  } catch (err) {
    markOutboxFailed(entry.id, String(err));
    return 'failed';
  }
}

/**
 * Periodically drain the beacon's durable outbox to the coordinator, with
 * exponential backoff between attempts and a hard attempt cap.
 */
export function createOutboxFlusher(
  options: OutboxFlusherOptions
): OutboxFlusher {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  let fetcher: typeof fetch | undefined;

  async function flushOnce(now?: number): Promise<FlushResult> {
    const result: FlushResult = {
      attempted: 0,
      delivered: 0,
      failed: 0,
      dropped: 0,
    };
    const baseUrl = options.getBaseUrl();
    if (!baseUrl) {
      return result;
    }
    fetcher ??= createCoordinatorFetch(baseUrl);
    const entries = dequeueDueOutbox(
      batchSize,
      now ?? options.now?.() ?? Date.now()
    );
    for (const entry of entries) {
      result.attempted += 1;
      const outcome = await deliverEntry(entry, baseUrl, fetcher, maxAttempts);
      if (outcome === 'delivered') {
        result.delivered += 1;
      } else if (outcome === 'failed') {
        result.failed += 1;
      } else {
        result.dropped += 1;
      }
    }
    if (result.attempted > 0) {
      logger.info(
        `Outbox flush: ${result.delivered} delivered, ${result.failed} failed, ${result.dropped} dropped (${result.attempted} attempted)`
      );
    }
    return result;
  }

  let timer: NodeJS.Timeout | undefined;

  return {
    flushOnce,
    start() {
      timer = setInterval(() => {
        flushOnce().catch(err => {
          logger.warn(`Outbox flush failed: ${err}`);
        });
      }, options.intervalMs);
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
    },
  };
}
