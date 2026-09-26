/**
 * Fragment constants mirrored from drone-swarm-common. The web package cannot
 * import from drone-core / drone-swarm-common (no workspace dep), so the
 * reserved values the UI needs are duplicated here, matching the
 * lib/config-completions.ts convention.
 */
export const SWARM_IDENTITY_FRAGMENT_ID = 'swarm-identity';
export const BROADCAST_TARGET = 'broadcast';
export const MAX_FRAGMENT_CONTENT_BYTES = 16 * 1024;
