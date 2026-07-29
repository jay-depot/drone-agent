/**
 * Shared type guard utilities used across the drone-agent codebase.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
