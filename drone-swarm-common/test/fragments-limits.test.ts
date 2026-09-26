import { describe, it, expect, vi } from 'vitest';
import {
  countNonReserved,
  isReservedFragmentId,
  SWARM_IDENTITY_FRAGMENT_ID,
  validateFragmentUpsert,
  MAX_BROADCAST_FRAGMENTS,
  MAX_TARGETED_FRAGMENTS_PER_AGENT,
  MAX_FRAGMENT_CONTENT_BYTES,
} from '../src/fragments-limits.js';

const ctx = {
  countBroadcasts: () => 0,
  countTargetedForAgent: () => 0,
};

describe('reserved fragment ids', () => {
  it('recognises the reserved swarm-identity id', () => {
    expect(isReservedFragmentId(SWARM_IDENTITY_FRAGMENT_ID)).toBe(true);
    expect(isReservedFragmentId('user-fragment')).toBe(false);
  });

  it('counts only non-reserved fragments', () => {
    expect(
      countNonReserved([
        { id: SWARM_IDENTITY_FRAGMENT_ID },
        { id: 'a' },
        { id: 'b' },
      ])
    ).toBe(2);
    expect(countNonReserved([{ id: SWARM_IDENTITY_FRAGMENT_ID }])).toBe(0);
  });
});

describe('validateFragmentUpsert', () => {
  it('normalizes a targeted fragment with default TTL stamping', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000);
      const result = validateFragmentUpsert(
        { id: 'ok', target: 'agent-1', content: 'hi' },
        ctx
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.normalized.phase).toBe('header');
        expect(result.normalized.scope).toBe('local');
        expect(result.normalized.expiresAt).toBe(
          1_000_000 + 24 * 60 * 60 * 1000
        );
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('broadcast with no expiresAt never expires', () => {
    const result = validateFragmentUpsert(
      { id: 'ok', target: 'broadcast', content: 'hi' },
      ctx
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.normalized.expiresAt).toBeNull();
    }
  });

  it('defaults scope to local and honours an explicit scope', () => {
    const local = validateFragmentUpsert(
      { id: 'ok', target: 'broadcast', content: 'c' },
      ctx
    );
    expect(local.ok && local.normalized.scope).toBe('local');

    const coord = validateFragmentUpsert(
      { id: 'ok', target: 'broadcast', content: 'c' },
      { ...ctx, scope: 'coordinator' }
    );
    expect(coord.ok && coord.normalized.scope).toBe('coordinator');
  });

  it('rejects bad ids, missing target/content, bad phases, bad expiresAt, oversize content', () => {
    expect(
      validateFragmentUpsert({ id: 'bad id', target: 'a', content: 'c' }, ctx)
        .ok
    ).toBe(false);
    expect(
      validateFragmentUpsert({ id: 'ok', target: '', content: 'c' }, ctx).ok
    ).toBe(false);
    expect(
      validateFragmentUpsert({ id: 'ok', target: 'a', content: '' }, ctx).ok
    ).toBe(false);
    expect(
      validateFragmentUpsert(
        { id: 'ok', target: 'a', content: 'c', phase: 'middle' },
        ctx
      ).ok
    ).toBe(false);
    expect(
      validateFragmentUpsert(
        { id: 'ok', target: 'a', content: 'c', expiresAt: 'soon' },
        ctx
      ).ok
    ).toBe(false);
    const big = 'x'.repeat(MAX_FRAGMENT_CONTENT_BYTES + 1);
    const over = validateFragmentUpsert(
      { id: 'ok', target: 'a', content: big },
      ctx
    );
    expect(over.ok).toBe(false);
    if (!over.ok) {
      expect(over.code).toBe('limit');
    }
  });

  it('enforces broadcast and per-agent caps', () => {
    const fullBroadcasts = {
      countBroadcasts: () => MAX_BROADCAST_FRAGMENTS,
      countTargetedForAgent: () => 0,
    };
    const r1 = validateFragmentUpsert(
      { id: 'ok', target: 'broadcast', content: 'c' },
      fullBroadcasts
    );
    expect(r1.ok).toBe(false);
    if (!r1.ok) {
      expect(r1.code).toBe('limit');
    }
    const fullAgent = {
      countBroadcasts: () => 0,
      countTargetedForAgent: () => MAX_TARGETED_FRAGMENTS_PER_AGENT,
    };
    const r2 = validateFragmentUpsert(
      { id: 'ok', target: 'agent-1', content: 'c' },
      fullAgent
    );
    expect(r2.ok).toBe(false);
  });

  it('reserved ids may only target broadcast', () => {
    const result = validateFragmentUpsert(
      { id: SWARM_IDENTITY_FRAGMENT_ID, target: 'agent-1', content: 'c' },
      ctx
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('validation');
    }
  });

  it('reserved ids never expire', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000);
      const result = validateFragmentUpsert(
        { id: SWARM_IDENTITY_FRAGMENT_ID, target: 'broadcast', content: 'c' },
        ctx
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.normalized.expiresAt).toBeNull();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('reserved ids bypass the broadcast cap', () => {
    const fullBroadcasts = {
      countBroadcasts: () => MAX_BROADCAST_FRAGMENTS,
      countTargetedForAgent: () => 0,
    };
    const result = validateFragmentUpsert(
      { id: SWARM_IDENTITY_FRAGMENT_ID, target: 'broadcast', content: 'c' },
      fullBroadcasts
    );
    expect(result.ok).toBe(true);
  });

  it('reserved ids still enforce the content byte cap', () => {
    const big = 'x'.repeat(MAX_FRAGMENT_CONTENT_BYTES + 1);
    const over = validateFragmentUpsert(
      { id: SWARM_IDENTITY_FRAGMENT_ID, target: 'broadcast', content: big },
      ctx
    );
    expect(over.ok).toBe(false);
  });
});
