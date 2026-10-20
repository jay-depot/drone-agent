// Re-export the shared UI-extension contract from the types-only package so
// UI code imports from one local module.
export type {
  UIRegion,
  PluginClientRoute,
  UIExtensionApi,
  PluginClientExport,
  ExtensionManifestEntry,
} from 'drone-extension-ui-types';
