import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { PluginClientRoute, UIRegion } from './types';
import { loadExtensionBundles, defaultInjectStylesheet } from './loader';
import { useAuthenticatedFetch } from '@/hooks/use-auth';

/**
 * Loads the coordinator's extension bundles once and returns a `load` function
 * that hands each bundle's contributions to the registry callbacks. The heavy
 * lifting lives in the pure `loadExtensionBundles` so it is unit-testable
 * without a real dynamic `import()`.
 *
 * `load` MUST be reference-stable. The provider's effect depends on it, so an
 * unstable `load` re-runs that effect on every navigation and disposes the
 * whole registry. `navigate` (and `authFetch`) therefore live in refs, not in
 * the `useCallback` dependency list.
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
  /** True until the bundle load settles (success or failure). */
  loading: boolean;
}

export function useExtensions(): ExtensionsLoader {
  const authFetch = useAuthenticatedFetch();
  const navigate = useNavigate();
  const loadedRef = useRef<string[]>([]);
  const didLoadRef = useRef(false);
  const [loading, setLoading] = useState(true);

  const authFetchRef = useRef(authFetch);
  const navigateRef = useRef(navigate);
  useEffect(() => {
    authFetchRef.current = authFetch;
    navigateRef.current = navigate;
  }, [authFetch, navigate]);

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
        try {
          let entries: Parameters<typeof loadExtensionBundles>[0];
          try {
            const res = await authFetchRef.current('/api/extensions');
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
            fetch: (path, init) => authFetchRef.current(path, init),
            navigate: path => navigateRef.current(path),
          });
          disposers.push(...result.disposers);
          loadedRef.current = result.loaded;
        } finally {
          setLoading(false);
        }
      })();

      return disposers;
    },
    []
  );

  return useMemo(
    () => ({ load, loaded: loadedRef.current, loading }),
    [load, loading]
  );
}
