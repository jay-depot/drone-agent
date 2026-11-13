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
 * Error-reporting helpers the host gives to a bundle. All three report through
 * the host error toast, so a bundle does not need its own error surface.
 */
export interface DroneUIErrors {
  /** Show a message to the user. */
  show: (message: string) => void;
  /**
   * Read a non-ok Response, turn it into a message, show it, and return the
   * message. Ignore the returned promise for a fire-and-forget call.
   */
  fromResponse: (res: Response) => Promise<string>;
  /** Turn a thrown error into a message, show it, and return the message. */
  fromThrown: (err: unknown) => string;
}

/** Host-provided UI helpers. Add a new area as a new field. */
export interface DroneUI {
  errors: DroneUIErrors;
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
  /** Navigate to a client route without a page reload. */
  navigate: (path: string) => void;
  /** Host-provided UI helpers. */
  ui: DroneUI;
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
