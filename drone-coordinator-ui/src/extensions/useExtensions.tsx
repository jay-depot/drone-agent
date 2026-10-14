import { useCallback, useMemo, useRef } from 'react';
import type { PluginClientRoute, UIRegion } from './types';
import { loadExtensionBundles, defaultInjectStylesheet } from './loader';
import { useAuthenticatedFetch } from '@/hooks/use-auth';

/**
 * Loads the coordinator's extension bundles once and returns a `load` function
 * that hands each bundle's contributions to the registry callbacks. The heavy
 * lifting lives in the pure `loadExtensionBundles` so it is unit-testable
 * without a real dynamic `import()`.
 */

export interface ExtensionsLoader {
  /** Load all bundles; returns disposers for everything registered. */
  load: (
    registerComponent: (
      region: UIRegion,
      component: unknown,
      label?: string
    ) => () => void,
    registerRoute: (route: PluginClientRoute) => () => void
  ) => Array<() => void>;
  loaded: string[];
}

export function useExtensions(): ExtensionsLoader {
  const authFetch = useAuthenticatedFetch();
  const loadedRef = useRef<string[]>([]);
  const didLoadRef = useRef(false);

  const load = useCallback(
    (
      registerComponent: (
        region: UIRegion,
        component: unknown,
        label?: string
      ) => () => void,
      registerRoute: (route: PluginClientRoute) => () => void
    ): Array<() => void> => {
      const disposers: Array<() => void> = [];
      if (didLoadRef.current) return disposers;
      didLoadRef.current = true;

      void (async () => {
        let entries: Parameters<typeof loadExtensionBundles>[0];
        try {
          const res = await authFetch('/api/extensions');
          if (!res.ok) return;
          entries = await res.json();
        } catch {
          return;
        }

        const result = await loadExtensionBundles(entries, {
          importModule: url => import(/* @vite-ignore */ url),
          registerComponent,
          registerRoute,
          injectStylesheet: defaultInjectStylesheet,
        });
        disposers.push(...result.disposers);
        loadedRef.current = result.loaded;
      })();

      return disposers;
    },
    [authFetch]
  );

  return useMemo(() => ({ load, loaded: loadedRef.current }), [load]);
}
