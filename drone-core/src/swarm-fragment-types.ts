// ── Swarm prompt fragment types ───────────────────────────────────────

/**
 * Wire type for a swarm prompt fragment: a stored, addressed asset that a
 * beacon or the coordinator injects into running agent sessions' system
 * prompts.
 *
 * Targeted fragments address a single agentId; the reserved target value
 * {@link BROADCAST_TARGET} addresses all sessions. Stored in the beacon
 * `fragments` table (PK `(id, target)`); coordinator rows are mirrored into
 * the beacon with `scope: 'coordinator'` and shadow beacon-scoped rows with
 * the same id.
 *
 * Must be wire-compatible with the beacon's REST/WS payloads and the
 * coordinator's `/api/fragments` endpoint.
 */
export type DroneSwarmFragment = {
  /** Caller-chosen stable id. Must satisfy `validateFragmentId`. */
  id: string;
  /** Recipient agentId, or the reserved `broadcast` sentinel. */
  target: string;
  /** Prompt content to inject. */
  content: string;
  /** Which prompt seam the fragment renders into. */
  phase: 'header' | 'footer';
  /** Origin scope. Only the beacon distinguishes scopes; coordinator rows are implicitly coordinator-scoped. */
  scope: 'local' | 'coordinator';
  /** Epoch ms when the row was created. Preserved on upsert. */
  createdAt: number;
  /** Epoch ms of the last upsert. */
  updatedAt: number;
  /**
   * Epoch ms after which the fragment stops being served, or null for
   * no expiry (broadcast default). Targeted fragments default to now + 24h.
   */
  expiresAt: number | null;
};

/**
 * Reserved target value addressing all sessions of a beacon. POST /agents
 * must reject registering an agentId equal to this sentinel.
 */
export const BROADCAST_TARGET = 'broadcast';

/** Character set for fragment ids: URL-safe and prompt-display-safe. */
const FRAGMENT_ID_PATTERN = /^[a-zA-Z0-9:_-]+$/;

/** Whether `id` is a valid fragment id. */
export function validateFragmentId(id: string): boolean {
  return FRAGMENT_ID_PATTERN.test(id);
}
