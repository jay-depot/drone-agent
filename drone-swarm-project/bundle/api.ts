/**
 * Module-level holder for the coordinator UI API captured in `onReady`.
 *
 * React is shared via `globalThis.React` (the host installs it before loading
 * bundles), so this module never imports react. Coordinator calls go through
 * `api.fetch`, which carries the coordinator web token.
 */

import type { UIExtensionApi } from 'drone-extension-ui-types';

let api: UIExtensionApi | undefined;

export function setApi(next: UIExtensionApi): void {
  api = next;
}

/** POST an action to this node and return the parsed JSON reply. */
export async function action<T = unknown>(
  name: string,
  params: Record<string, unknown> = {}
): Promise<T> {
  if (!api) throw new Error('drone-swarm-project: api not ready');
  const res = await api.fetch(
    `/api/extensions/drone-swarm-project/actions/${name}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ params }),
    }
  );
  return (await res.json()) as T;
}
