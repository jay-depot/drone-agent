import type { DronePromptFragment } from 'drone-core';

import type { SwarmFragmentStore } from './fragment-store.js';

/**
 * The `# Swarm Identity` header fragment: renders the reserved `swarm-identity`
 * broadcast fragment (authored from the coordinator web UI) as its own
 * top-level section. Hidden until the row exists.
 */
export function createSwarmIdentityFragment(
  store: SwarmFragmentStore
): DronePromptFragment {
  return {
    key: 'identity',
    phase: 'header',
    render: async () => store.renderIdentity(),
  };
}
