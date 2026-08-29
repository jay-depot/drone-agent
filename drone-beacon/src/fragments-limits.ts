import { Buffer } from 'node:buffer';
import { BROADCAST_TARGET, validateFragmentId } from 'drone-core';

export const MAX_BROADCAST_FRAGMENTS = 5;
export const MAX_TARGETED_FRAGMENTS_PER_AGENT = 50;
export const MAX_FRAGMENT_CONTENT_BYTES = 16 * 1024;
export const DEFAULT_TARGETED_TTL_MS = 24 * 60 * 60 * 1000;
export const TTL_SWEEP_INTERVAL_MS = 60_000;

export const FRAGMENT_PHASES = ['header', 'footer'] as const;
export type FragmentPhase = (typeof FRAGMENT_PHASES)[number];

export type FragmentUpsertInput = {
  id: string;
  target: string;
  content: string;
  phase?: string;
  expiresAt?: number | null;
};

export type NormalizedFragmentUpsert = {
  id: string;
  target: string;
  content: string;
  phase: FragmentPhase;
  scope: 'local';
  expiresAt: number | null;
};

export type FragmentUpsertResult =
  | { ok: true; normalized: NormalizedFragmentUpsert }
  | { ok: false; error: string; code: 'validation' | 'limit' };

function isFiniteEpochMs(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Validate and normalize a fragment upsert request body. Applies TTL
 * stamping (targeted + no expiresAt => now + 24h; broadcast + no expiresAt
 * => never expires), phase defaulting, and the broadcast / per-agent count
 * caps.
 */
export function validateFragmentUpsert(
  body: unknown,
  ctx: {
    now?: number;
    countBroadcasts: () => number;
    countTargetedForAgent: (target: string) => number;
  }
): FragmentUpsertResult {
  const now = ctx.now ?? Date.now();
  const raw = (body ?? {}) as Partial<FragmentUpsertInput> & {
    phase?: unknown;
    expiresAt?: unknown;
  };

  if (
    typeof raw.id !== 'string' ||
    raw.id.length === 0 ||
    !validateFragmentId(raw.id)
  ) {
    return {
      ok: false,
      error: 'Fragment id is required and must match ^[a-zA-Z0-9:_-]+$',
      code: 'validation',
    };
  }

  if (typeof raw.target !== 'string' || raw.target.length === 0) {
    return {
      ok: false,
      error: 'Fragment target is required',
      code: 'validation',
    };
  }

  if (typeof raw.content !== 'string' || raw.content.length === 0) {
    return {
      ok: false,
      error: 'Fragment content is required',
      code: 'validation',
    };
  }

  if (Buffer.byteLength(raw.content, 'utf8') > MAX_FRAGMENT_CONTENT_BYTES) {
    return {
      ok: false,
      error: `Fragment content exceeds ${MAX_FRAGMENT_CONTENT_BYTES} bytes`,
      code: 'limit',
    };
  }

  let phase: FragmentPhase = 'header';
  if (raw.phase !== undefined) {
    if (
      typeof raw.phase !== 'string' ||
      !FRAGMENT_PHASES.includes(raw.phase as FragmentPhase)
    ) {
      return {
        ok: false,
        error: `Fragment phase must be one of: ${FRAGMENT_PHASES.join(', ')}`,
        code: 'validation',
      };
    }
    phase = raw.phase as FragmentPhase;
  }

  let expiresAt: number | null;
  if (raw.expiresAt === undefined || raw.expiresAt === null) {
    expiresAt =
      raw.target === BROADCAST_TARGET ? null : now + DEFAULT_TARGETED_TTL_MS;
  } else {
    if (!isFiniteEpochMs(raw.expiresAt)) {
      return {
        ok: false,
        error: 'Fragment expiresAt must be an epoch ms number or null',
        code: 'validation',
      };
    }
    expiresAt = raw.expiresAt;
  }

  if (raw.target === BROADCAST_TARGET) {
    const count = ctx.countBroadcasts();
    if (count >= MAX_BROADCAST_FRAGMENTS) {
      return {
        ok: false,
        error: `Broadcast fragment limit reached (${MAX_BROADCAST_FRAGMENTS})`,
        code: 'limit',
      };
    }
  } else {
    const count = ctx.countTargetedForAgent(raw.target);
    if (count >= MAX_TARGETED_FRAGMENTS_PER_AGENT) {
      return {
        ok: false,
        error: `Targeted fragment limit reached for ${raw.target} (${MAX_TARGETED_FRAGMENTS_PER_AGENT})`,
        code: 'limit',
      };
    }
  }

  return {
    ok: true,
    normalized: {
      id: raw.id,
      target: raw.target,
      content: raw.content,
      phase,
      scope: 'local',
      expiresAt,
    },
  };
}
