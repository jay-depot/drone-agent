// ── Portable-context types ──────────────────────────────────────────
//
// Portable context is a standardized, versioned JSON serialization of a
// session's *context* (its turns, its tool catalog, and a plugin-extensible
// metadata map) plus a *continuation* path that restores it as a brand-new
// session. The capability is engine-seeded (mirroring `reference`) and inert
// until a plugin or host calls it.
//
// See ADR 246.

import type {
  DroneSessionMessage,
  DroneSessionTurn,
  DroneToolJsonSchema,
} from './session-types.js';

export const DRONE_PORTABLE_CONTEXT_CAPABILITY_ID = 'portable-context';

/**
 * Substring that identifies the continuation-disclosure system-reminder a
 * portable-context import appends to the restored session. Used to build the
 * reminder AND to strip it back out on export, so repeated
 * export → import → export cycles never accumulate disclosure turns.
 */
export const CONTINUATION_DISCLOSURE_MARKER =
  'was restored from a prior checkpoint';

/** Lowest schema version this build can import. */
export const MIN_CONTEXT_SCHEMA_VERSION = 1;
/** Highest schema version this build can import. */
export const MAX_CONTEXT_SCHEMA_VERSION = 1;
/** Schema version this build emits. */
export const CURRENT_CONTEXT_SCHEMA_VERSION = 1;

export type DronePortableContextTool = {
  name: string;
  description: string;
  inputSchema?: DroneToolJsonSchema;
  defaultHidden?: boolean;
  mounted: boolean;
};

export type DronePortableContextSessionTurn = {
  /** Present and `'summary'` only for compaction-summary turns. */
  kind?: 'summary';
  /** Turn id is intentionally omitted; ids are re-minted on import. */
  messages: DroneSessionMessage[];
};

export type DronePortableContextSession = {
  /** Id of the session this context was exported from (lineage only). */
  sourceSessionId?: string;
  turns: DronePortableContextSessionTurn[];
};

export type DronePortableContextExport = {
  version: number;
  /** ISO timestamp of the export. */
  createdAt: string;
  session: DronePortableContextSession;
  tools: DronePortableContextTool[];
  /** Arbitrary JSON contributed by plugins, keyed by plugin id. */
  pluginData: Record<string, unknown>;
};

export type DronePortableContextExportContext = {
  turns: readonly DroneSessionTurn[];
};

export type DronePortableContextImportContext = {
  turns: readonly DroneSessionTurn[];
};

export type DronePortableContextContributor = {
  /** The `pluginData` key (the plugin id). */
  id: string;
  export: (
    ctx: DronePortableContextExportContext
  ) => unknown | Promise<unknown>;
  import?: (
    data: unknown,
    ctx: DronePortableContextImportContext
  ) => void | Promise<void>;
};

export type DronePortableContextImportResult = {
  warnings: string[];
  unavailableTools: string[];
};

export type DronePortableContextCapability = {
  registerContributor: (c: DronePortableContextContributor) => void;
  unregisterContributor: (id: string) => void;
  getContributors: () => DronePortableContextContributor[];
  exportContext: () => Promise<DronePortableContextExport>;
  importContext: (
    data: DronePortableContextExport
  ) => Promise<DronePortableContextImportResult>;
};
