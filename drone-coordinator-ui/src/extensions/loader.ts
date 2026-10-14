import type {
  ExtensionManifestEntry,
  PluginClientExport,
  PluginClientRoute,
  UIExtensionApi,
  UIRegion,
} from './types';

/**
 * The pure bundle-loader core, extracted from the `useExtensions` hook so it
 * can be unit-tested without a real dynamic `import()`.
 *
 * For each manifest entry's bundles it:
 *  1. injects each bundle's stylesheets,
 *  2. resolves each script URL to its default client export,
 *  3. feeds `regions` + `routes` to the registry callbacks and calls
 *     `onReady(api)` for imperative registration.
 *
 * Failures are contained per bundle: a bundle that fails to resolve/parse is
 * skipped and never breaks the app or other bundles.
 */

export interface LoaderDeps {
  /** Resolve a bundle script URL to its module (defaults to dynamic import). */
  importModule: (url: string) => Promise<{ default?: PluginClientExport }>;
  registerComponent: (
    region: UIRegion,
    component: unknown,
    label?: string
  ) => () => void;
  registerRoute: (route: PluginClientRoute) => () => void;
  /** Inject a bundle stylesheet (defaults to a `<link>` in `<head>`). */
  injectStylesheet: (href: string) => void;
  /** Called with any load error (defaults to console.warn). */
  onError?: (message: string) => void;
}

export interface LoadResult {
  disposers: Array<() => void>;
  /** Node ids whose bundles loaded successfully. */
  loaded: string[];
}

function defaultInjectStylesheet(href: string): void {
  if (document.querySelector(`link[data-extension-style="${href}"]`)) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  link.dataset.extensionStyle = href;
  document.head.appendChild(link);
}

function makeApi(
  registerComponent: LoaderDeps['registerComponent'],
  registerRoute: LoaderDeps['registerRoute']
): UIExtensionApi {
  return {
    registerComponent: (region, component) =>
      registerComponent(region, component),
    registerRoute,
  };
}

export async function loadExtensionBundles(
  entries: ExtensionManifestEntry[],
  deps: LoaderDeps
): Promise<LoadResult> {
  const disposers: Array<() => void> = [];
  const loaded: string[] = [];
  const injectStylesheet = deps.injectStylesheet ?? defaultInjectStylesheet;
  const onError =
    deps.onError ?? ((message: string) => console.warn(message));

  for (const entry of entries) {
    for (const bundle of entry.bundles ?? []) {
      const styles = bundle.styleUrls ?? [];
      const scripts = bundle.scriptUrls ?? [];
      for (const href of styles) injectStylesheet(href);
      for (const src of scripts) {
        try {
          const mod = await deps.importModule(src);
          const client = mod.default;
          if (!client) continue;
          for (const [region, component] of Object.entries(
            client.regions ?? {}
          )) {
            if (component) {
              disposers.push(
                deps.registerComponent(region as UIRegion, component, entry.nodeId)
              );
            }
          }
          for (const route of client.routes ?? []) {
            disposers.push(deps.registerRoute(route));
          }
          client.onReady?.(
            makeApi(deps.registerComponent, deps.registerRoute)
          );
          loaded.push(entry.nodeId);
        } catch (err) {
          // Contained: one bad bundle never breaks the app.
          onError(
            `Failed to load extension bundle ${entry.nodeId}/${bundle.name}: ${String(err)}`
          );
        }
      }
    }
  }

  return { disposers, loaded };
}

export { defaultInjectStylesheet };
