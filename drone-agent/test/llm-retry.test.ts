import { describe, expect, it } from 'vitest';
import {
  computeBackoffDelay,
  DEFAULT_RETRY_CONFIG,
  isContextWindowExceeded,
  isTransientStatus,
  parseRetryAfterMs,
} from '../src/runtime/llm-retry.js';

const CONFIG = { maxWaitMs: 30000, backoffBaseMs: 1000, backoffFactor: 2 };

describe('isTransientStatus', () => {
  it('classifies 429 and 5xx as transient', () => {
    expect(isTransientStatus(429)).toBe(true);
    expect(isTransientStatus(500)).toBe(true);
    expect(isTransientStatus(502)).toBe(true);
    expect(isTransientStatus(503)).toBe(true);
    expect(isTransientStatus(504)).toBe(true);
  });

  it('classifies other statuses as non-transient', () => {
    expect(isTransientStatus(400)).toBe(false);
    expect(isTransientStatus(401)).toBe(false);
    expect(isTransientStatus(403)).toBe(false);
    expect(isTransientStatus(404)).toBe(false);
    expect(isTransientStatus(501)).toBe(false);
  });
});

describe('parseRetryAfterMs', () => {
  it('parses the integer-seconds form', () => {
    expect(parseRetryAfterMs('120')).toBe(120000);
    expect(parseRetryAfterMs('0')).toBe(0);
    expect(parseRetryAfterMs('  45 ')).toBe(45000);
  });

  it('parses the HTTP-date form', () => {
    const future = new Date(Date.now() + 15000);
    const header = future.toUTCString();
    const ms = parseRetryAfterMs(header);
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(16000);
  });

  it('returns undefined for unparseable values', () => {
    expect(parseRetryAfterMs(undefined)).toBeUndefined();
    expect(parseRetryAfterMs('')).toBeUndefined();
    expect(parseRetryAfterMs('   ')).toBeUndefined();
    expect(parseRetryAfterMs('not-a-date')).toBeUndefined();
  });
});

describe('computeBackoffDelay', () => {
  it('applies exponential backoff', () => {
    expect(computeBackoffDelay(1, CONFIG)).toBe(1000);
    expect(computeBackoffDelay(2, CONFIG)).toBe(2000);
    expect(computeBackoffDelay(3, CONFIG)).toBe(4000);
    expect(computeBackoffDelay(4, CONFIG)).toBe(8000);
  });

  it('caps backoff at maxWaitMs', () => {
    const cap = { maxWaitMs: 3000, backoffBaseMs: 1000, backoffFactor: 2 };
    expect(computeBackoffDelay(3, cap)).toBe(3000);
    expect(computeBackoffDelay(10, cap)).toBe(3000);
  });

  it('honors Retry-After when within the cap', () => {
    expect(computeBackoffDelay(1, CONFIG, 500)).toBe(500);
    expect(computeBackoffDelay(3, CONFIG, 2500)).toBe(2500);
  });

  it('ignores Retry-After exceeding the cap and falls back to backoff', () => {
    expect(computeBackoffDelay(1, CONFIG, 60000)).toBe(1000);
    expect(
      computeBackoffDelay(
        1,
        { maxWaitMs: 3000, backoffBaseMs: 1000, backoffFactor: 2 },
        10000
      )
    ).toBe(1000);
  });

  it('handles zero/negative Retry-After', () => {
    expect(computeBackoffDelay(1, CONFIG, 0)).toBe(1000);
    expect(computeBackoffDelay(1, CONFIG, -5)).toBe(1000);
  });
});

describe('isContextWindowExceeded', () => {
  it('detects context-overflow messages on 400/413/429', () => {
    expect(
      isContextWindowExceeded(400, 'maximum context length exceeded')
    ).toBe(true);
    expect(
      isContextWindowExceeded(413, 'Request too large for the context window')
    ).toBe(true);
    expect(isContextWindowExceeded(429, 'Context window size exceeded')).toBe(
      true
    );
    expect(
      isContextWindowExceeded(
        400,
        'This model maximum context length is 1000000 tokens'
      )
    ).toBe(true);
  });

  it('does not match non-context messages even on those statuses', () => {
    expect(isContextWindowExceeded(400, 'Invalid request body')).toBe(false);
    expect(isContextWindowExceeded(429, 'Rate limit exceeded')).toBe(false);
  });

  it('does not match on other statuses even with context wording', () => {
    expect(
      isContextWindowExceeded(500, 'maximum context length exceeded')
    ).toBe(false);
    expect(isContextWindowExceeded(undefined, 'context window overflow')).toBe(
      false
    );
  });
});

describe('DEFAULT_RETRY_CONFIG', () => {
  it('matches the locked design defaults', () => {
    expect(DEFAULT_RETRY_CONFIG).toEqual({
      maxRetries: 3,
      maxWaitMs: 30000,
      promptOnError: true,
      backoffBaseMs: 1000,
      backoffFactor: 2,
    });
  });
});
