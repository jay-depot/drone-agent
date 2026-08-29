/**
 * Shared retry/classification policy helpers for LLM chat() failures.
 * The conversation service owns the policy; these pure helpers compute the
 * building blocks (Retry-After parsing, backoff, status classification).
 */

import { DroneLlmError } from 'drone-core';

export type RetryPolicyConfig = {
  maxRetries: number;
  maxWaitMs: number;
  promptOnError: boolean;
  backoffBaseMs: number;
  backoffFactor: number;
};

export const DEFAULT_RETRY_CONFIG: RetryPolicyConfig = {
  maxRetries: 3,
  maxWaitMs: 30000,
  promptOnError: true,
  backoffBaseMs: 1000,
  backoffFactor: 2,
};

/** HTTP statuses that are considered transient and safe to auto-retry. */
export function isTransientStatus(status: number): boolean {
  return (
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
  );
}

/**
 * Parse a Retry-After header value into milliseconds. Supports both the
 * HTTP-date form (`Wed, 21 Oct 2015 07:28:00 GMT`) and the integer
 * seconds form (`120`). Returns undefined when unparseable.
 */
export function parseRetryAfterMs(
  header: string | undefined
): number | undefined {
  if (header === undefined) return undefined;
  const trimmed = header.trim();
  if (trimmed.length === 0) return undefined;

  // Integer seconds form.
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }

  // HTTP-date form.
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) return undefined;
  return Math.max(0, parsed - Date.now());
}

/**
 * Compute the delay (ms) to wait before the next retry attempt.
 * - If the server supplied a Retry-After and it's within the maxWaitMs cap,
 *   honor it.
 * - Otherwise apply exponential backoff `backoffBaseMs * backoffFactor^(attempt-1)`,
 *   capped at maxWaitMs.
 * `attempt` is 1-based (the first retry after the initial failure).
 */
export function computeBackoffDelay(
  attempt: number,
  config: Pick<
    RetryPolicyConfig,
    'maxWaitMs' | 'backoffBaseMs' | 'backoffFactor'
  >,
  retryAfterMs?: number
): number {
  if (
    retryAfterMs !== undefined &&
    retryAfterMs > 0 &&
    retryAfterMs <= config.maxWaitMs
  ) {
    return retryAfterMs;
  }
  const base = Math.max(1, config.backoffBaseMs);
  const factor = Math.max(1, config.backoffFactor);
  const backoff = base * Math.pow(factor, Math.max(0, attempt - 1));
  return Math.min(config.maxWaitMs, Math.floor(backoff));
}

/** Whether the message looks like a context-window-overflow error. */
export function isContextWindowExceeded(
  status: number | undefined,
  message: string
): boolean {
  if (
    status !== undefined &&
    (status === 413 || status === 400 || status === 429)
  ) {
    return CONTEXT_WINDOW_RE.test(message);
  }
  return false;
}

const CONTEXT_WINDOW_RE =
  /(?:context\s*(?:length|window|limit|size)|max\s*context|token\s*(?:limit|budget|context|window)|maximum\s*context)/i;

/**
 * Run a request with bounded silent auto-retry on transient statuses
 * (429/5xx), honoring Retry-After / exponential backoff, capped at
 * `config.maxRetries` attempts. Non-transient errors and non-DroneLlmError
 * errors are thrown immediately. Returns the first successful response.
 *
 * `onRetry` (optional) is invoked before each retry with the error, the
 * 1-based attempt number, and the computed delay in ms.
 */
export async function withBoundedSilentRetry<T>(
  request: () => Promise<T>,
  config: Pick<
    RetryPolicyConfig,
    'maxRetries' | 'maxWaitMs' | 'backoffBaseMs' | 'backoffFactor'
  >,
  onRetry?: (error: DroneLlmError, attempt: number, delayMs: number) => void
): Promise<T> {
  let failureCount = 0;
  while (true) {
    try {
      return await request();
    } catch (error) {
      if (!(error instanceof DroneLlmError)) {
        throw error;
      }
      const llmErr = error;
      const transient =
        llmErr.retryable ||
        (llmErr.status !== undefined && isTransientStatus(llmErr.status));
      if (transient && failureCount < config.maxRetries) {
        failureCount += 1;
        const delay = computeBackoffDelay(
          failureCount,
          config,
          llmErr.retryAfterMs
        );
        onRetry?.(llmErr, failureCount, delay);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      throw llmErr;
    }
  }
}
