/** The invoke context the service needs; a structural subset of the SDK's. */
export interface InvokeCtxLike {
  caller: 'ui' | 'agent';
  sessionId?: string;
}

/** Resolve a wake-up instant from `dueAt` (ISO-8601) or `delayMs`. */
export function resolveDueAt(params: {
  dueAt?: unknown;
  delayMs?: unknown;
}): { ok: true; dueAt: number } | { ok: false; error: string } {
  const dueAtRaw = params.dueAt;
  const delayRaw = params.delayMs;
  const now = Date.now();
  if (typeof dueAtRaw === 'string' && dueAtRaw.trim() !== '') {
    const parsed = Date.parse(dueAtRaw);
    if (Number.isNaN(parsed)) {
      return { ok: false, error: 'dueAt is not a valid ISO-8601 time' };
    }
    return { ok: true, dueAt: parsed };
  }
  if (typeof delayRaw === 'number' && Number.isFinite(delayRaw)) {
    if (delayRaw < 0) {
      return { ok: false, error: 'delayMs must not be negative' };
    }
    return { ok: true, dueAt: now + delayRaw };
  }
  return { ok: false, error: 'provide dueAt or delayMs' };
}

/** A short relative description of a resolved instant, for the tool result. */
export function formatHuman(dueAt: number, now: number): string {
  const diff = dueAt - now;
  if (diff <= 0) return 'in the past (fires on the next tick)';
  const mins = Math.round(diff / 60000);
  if (mins < 60) return `in ${mins} minute(s)`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  return `in ${hours}h ${rem}m`;
}
