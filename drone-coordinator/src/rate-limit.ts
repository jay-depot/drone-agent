import type { FastifyRequest } from 'fastify';
import { normalizeIP } from '@fastify/rate-limit';
import { resolveRequestNodeId } from './mtls.js';

/** Default per-client request limit. */
export const DEFAULT_RATE_LIMIT_MAX = 1000;
/** Default window length in milliseconds. */
export const DEFAULT_RATE_LIMIT_WINDOW_MS = 1000;

/**
 * Normalize the fallback address exactly as @fastify/rate-limit's default key
 * generator does: lowercase, un-map IPv4-in-IPv6, and collapse a bare IPv6
 * address to its /64 prefix. A missing address maps to a stable `'unknown'`.
 */
function normalizeClientIp(req: FastifyRequest): string {
  if (!req.ip) return 'unknown';
  return normalizeIP(req.ip);
}

/**
 * Rate-limit key: the resolved node id when we know the caller, else the IP.
 * One bucket per beacon; one bucket per IP for web-port clients.
 *
 * This runs first in the request pipeline, so it must never throw: if node-id
 * resolution fails (e.g. the trust table is unavailable) the request still
 * falls back to its (normalized) IP key instead of erroring the limiter.
 */
export function resolveRateLimitKey(req: FastifyRequest): string {
  try {
    return resolveRequestNodeId(req) ?? normalizeClientIp(req);
  } catch {
    return normalizeClientIp(req);
  }
}
