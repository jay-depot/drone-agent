import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from 'react';
import { Navigate } from 'react-router-dom';
import { Skeleton } from '@/components/ui/skeleton';
import type { PluginClientRoute, UIRegion } from './types';
import { useExtensions } from './useExtensions';

/** One component registered into a region, with the owning node's label. */
export interface RegionEntry {
  /** Node id that contributed the component (used for section headings). */
  label?: string;
  component: ComponentType;
}

/**
 * In-memory registry of everything loaded extension bundles contribute:
 * region components (keyed by region) and client routes. Populated by
 * `useExtensions()`; read by `<RegionSlot>` / `<ExtensionSections>` and the
 * app's route table.
 */
export interface ExtensionRegistry {
  /** Components registered for a region, in load order. */
  components: Map<UIRegion, RegionEntry[]>;
  /** Client routes contributed by bundles. */
  routes: PluginClientRoute[];
  /** Node ids whose bundles loaded successfully. */
  loaded: string[];
  /** True until the bundle load settles (success or failure). */
  loading: boolean;
}

interface ExtensionContextValue extends ExtensionRegistry {
  /** Register a component into a region; returns a disposer. */
  registerComponent: (
    region: UIRegion,
    component: ComponentType,
    label?: string
  ) => () => void;
  registerRoute: (route: PluginClientRoute) => () => void;
}

/**
 * Graceful default: when a page renders a region slot outside an
 * `<ExtensionProvider>` (e.g. a focused unit test), the slot simply renders
 * nothing rather than throwing. The provider overrides this value.
 */
const EMPTY_REGISTRY: ExtensionContextValue = {
  components: new Map(),
  routes: [],
  loaded: [],
  loading: false,
  registerComponent: () => () => {},
  registerRoute: () => () => {},
};

const ExtensionContext = createContext<ExtensionContextValue>(EMPTY_REGISTRY);

/**
 * Loads every coordinator extension bundle once on mount and exposes the
 * resulting registry to the app via context. Bundles are same-origin ESM
 * modules loaded with a dynamic `import()`; failures are contained per-bundle
 * so one bad bundle never breaks the app.
 */
export function ExtensionProvider({ children }: { children: ReactNode }) {
  const [components, setComponents] = useState<Map<UIRegion, RegionEntry[]>>(
    new Map()
  );
  const [routes, setRoutes] = useState<PluginClientRoute[]>([]);
  const [loaded, setLoaded] = useState<string[]>([]);

  const disposersRef = useRef<Array<() => void>>([]);

  const registerComponent = useMemo(
    () => (region: UIRegion, component: ComponentType, label?: string) => {
      setComponents(prev => {
        const next = new Map(prev);
        next.set(region, [...(next.get(region) ?? []), { component, label }]);
        return next;
      });
      return () => {
        setComponents(prev => {
          const next = new Map(prev);
          const list = (next.get(region) ?? []).filter(
            e => e.component !== component
          );
          if (list.length === 0) next.delete(region);
          else next.set(region, list);
          return next;
        });
      };
    },
    []
  );

  const registerRoute = useMemo(
    () => (route: PluginClientRoute) => {
      setRoutes(prev => [...prev.filter(r => r.path !== route.path), route]);
      return () => setRoutes(prev => prev.filter(r => r.path !== route.path));
    },
    []
  );

  const extensions = useExtensions();
  useEffect(() => {
    extensions.load(
      (region, component, label) => {
        const dispose = registerComponent(
          region as UIRegion,
          component as ComponentType,
          label
        );
        disposersRef.current.push(dispose);
        return dispose;
      },
      route => {
        const dispose = registerRoute(route);
        disposersRef.current.push(dispose);
        return dispose;
      }
    );
    if (extensions.loaded.length > 0) setLoaded(extensions.loaded);
    return () => {
      for (const dispose of disposersRef.current) dispose();
      disposersRef.current = [];
    };
  }, [extensions.load, registerComponent, registerRoute]);

  const value: ExtensionContextValue = {
    components,
    routes,
    loaded,
    loading: extensions.loading,
    registerComponent,
    registerRoute,
  };

  return (
    <ExtensionContext.Provider value={value}>
      {children}
    </ExtensionContext.Provider>
  );
}

export function useExtensionRegistry(): ExtensionContextValue {
  return useContext(ExtensionContext);
}

/**
 * Render every component registered into a region, in load order. Renders
 * nothing when the region is empty, so core layouts are unaffected when no
 * extensions are installed.
 */
export function RegionSlot({ region }: { region: UIRegion }) {
  const { components } = useExtensionRegistry();
  const list = components.get(region) ?? [];
  if (list.length === 0) return null;
  return (
    <>
      {list.map((entry, i) => {
        const Component = entry.component;
        return <Component key={`${region}-${i}`} />;
      })}
    </>
  );
}

/**
 * Render the `settings-panel` region as one core-headed section per extension.
 * The heading text is the owning node id (core-provided), so extension authors
 * never style their own top-level section title.
 */
export function ExtensionSections() {
  const { components } = useExtensionRegistry();
  const list = components.get('settings-panel') ?? [];
  return (
    <>
      {list.map((entry, i) => {
        const Component = entry.component;
        return (
          <section key={`settings-panel-${i}`} className="mb-8">
            <h2 className="text-xl font-semibold mb-3">
              {entry.label ?? 'Extension'}
            </h2>
            <Component />
          </section>
        );
      })}
    </>
  );
}

/**
 * The catch-all element. While extension bundles load, an extension route is
 * not yet in the route table. Show a placeholder and do not redirect. After
 * the load settles, an unknown path goes to the topology page.
 */
export function ExtensionRouteFallback() {
  const { loading } = useExtensionRegistry();
  if (loading) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-3/4" />
      </div>
    );
  }
  return <Navigate to="/" replace />;
}
