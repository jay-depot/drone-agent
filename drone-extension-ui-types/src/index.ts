/**
 * Shared types for drone coordinator UI extension bundles (types-only).
 *
 * A front-end bundle is a same-origin ESM module whose `default` export is a
 * `PluginClientExport`. The coordinator UI loads it (dynamic `import()`),
 * reads `regions` + `routes`, and calls the optional `onReady(api)` hook to
 * let the bundle register further components/routes imperatively. React is
 * shared through `globalThis.React` (react/react-dom are externalized by the
 * bundle's build), so this package declares no runtime React dependency.
 */

import type { ComponentType } from 'react';

/**
 * UI regions a bundle can target. A region is a named slot the coordinator UI
 * renders into; each maps to a concrete location in the app shell.
 */
export type UIRegion =
  | 'sidebar-nav'
  | 'topology-widget'
  | 'topology-card'
  | 'topology-page'
  | 'sessions-widget'
  | 'session-card'
  | 'session-page'
  | 'settings-panel';

/** An arbitrary client-side route a bundle contributes. */
export interface PluginClientRoute {
  /** Route path relative to the app root (e.g. `/mcp-swarm`). */
  path: string;
  /** Nav/label text for the route. */
  title: string;
  /** React component rendered for the route. */
  component: ComponentType;
}

/**
 * The API handed to a bundle's `onReady(api)` hook. Lets a bundle register
 * components/routes imperatively in addition to the declarative `regions` +
 * `routes` fields.
 */
export interface UIExtensionApi {
  /** Register a component into a named region. Returns a disposer. */
  registerComponent: (region: UIRegion, component: ComponentType) => () => void;
  /** Register a client route. Returns a disposer. */
  registerRoute: (route: PluginClientRoute) => () => void;
  /** Authenticated same-origin fetch against the coordinator API. */
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
}

/** The `default` export shape of a front-end ESM bundle. */
export interface PluginClientExport {
  /** Declarative region → component map. */
  regions?: Partial<Record<UIRegion, ComponentType>>;
  /** Declarative client routes. */
  routes?: PluginClientRoute[];
  /** Imperative registration hook, called once after the module is loaded. */
  onReady?: (api: UIExtensionApi) => void;
}

/** One entry of the coordinator's `GET /api/extensions` UI manifest. */
export interface ExtensionManifestEntry {
  nodeId: string;
  connected: boolean;
  isExtension?: boolean;
  protocolVersion: number;
  capabilities: Array<{
    name: string;
    description: string;
    paramSchema: Record<string, unknown>;
  }>;
  bundles: Array<{
    name: string;
    version: string;
    hash: string;
    targetRegions?: string[];
    /** Resolved same-origin `<script>` URLs for this bundle's files. */
    scriptUrls?: string[];
    /** Resolved same-origin `<link>` stylesheet URLs for this bundle. */
    styleUrls?: string[];
  }>;
}
