import type { DronePromptFragment } from 'drone-core';

import type { SwarmInfoStore } from './swarm-info.js';

/**
 * The `# Swarm Status` header fragment: names the local beacon, locates the
 * coordinator, and lists the registered beacons. Reads the in-memory swarm
 * info snapshot ONLY — never the network — and hides itself entirely until at
 * least a beacon name or a roster has been observed.
 */
export function createSwarmStatusFragment(
  store: SwarmInfoStore
): DronePromptFragment {
  return {
    key: 'status',
    phase: 'header',
    render: async () => {
      const info = store.getInfo();
      const roster = store.getRoster();
      if (!info?.name && roster.length === 0) {
        return false;
      }

      const lines: string[] = ['# Swarm Status', ''];
      if (info?.name) {
        lines.push(`- Local beacon: ${info.name} (${store.getLocalAddress()})`);
      }
      if (info?.coordinatorHost) {
        const port = info.coordinatorPort ? `:${info.coordinatorPort}` : '';
        lines.push(`- Coordinator: ${info.coordinatorHost}${port}`);
      }
      if (roster.length > 0) {
        lines.push(`- Registered beacons (${roster.length}):`);
        for (const beacon of roster) {
          const markers: string[] = [];
          if (!beacon.connected) markers.push('offline');
          if (beacon.trustStatus && beacon.trustStatus !== 'approved') {
            markers.push(
              beacon.trustStatus === 'rejected'
                ? 'rejected'
                : 'pending approval'
            );
          }
          const suffix = markers.length > 0 ? ` · ${markers.join(' · ')}` : '';
          lines.push(
            `  - ${beacon.name} (${beacon.host}:${beacon.port})${suffix}`
          );
        }
      }
      return lines.join('\n');
    },
  };
}
