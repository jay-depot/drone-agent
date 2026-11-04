const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const LIVE_STATUSES = new Set(['active', 'stale']);
function pad2(n: number): string {
  return String(n).padStart(2, '0');
}
/** Format a duration in milliseconds: 42s, 17m, 3h 05m, 2d 04h. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return 'unknown';
  const value = Math.max(0, ms);
  if (value < MINUTE) return `${Math.floor(value / 1000)}s`;
  if (value < HOUR) return `${Math.floor(value / MINUTE)}m`;
  if (value < DAY) {
    const hours = Math.floor(value / HOUR);
    const minutes = Math.floor((value % HOUR) / MINUTE);
    return `${hours}h ${pad2(minutes)}m`;
  }
  const days = Math.floor(value / DAY);
  const hours = Math.floor((value % DAY) / HOUR);
  return `${days}d ${pad2(hours)}h`;
}
export interface SessionDurationInput {
  createdAt: number;
  endedAt: number | null;
  status: string;
}
/**
 * Show a session duration. A set end time gives a frozen value. A live status
 * gives a `~`-prefixed age. Any other case gives "unknown". An absent
 * (undefined) endedAt behaves as null, because JSON does not enforce types.
 */
export function formatSessionDuration(
  session: SessionDurationInput,
  now: number = Date.now()
): string {
  const endedAt = session.endedAt ?? null;
  if (endedAt !== null) {
    return formatDuration(endedAt - session.createdAt);
  }
  const age = now - session.createdAt;
  if (LIVE_STATUSES.has(session.status) && Number.isFinite(age)) {
    return `~${formatDuration(age)}`;
  }
  return 'unknown';
}
