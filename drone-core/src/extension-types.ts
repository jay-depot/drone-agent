// ── Swarm extension types ─────────────────────────────────────────────
//
// Wire types for the swarm-extension protocol. An extension is a beacon
// that additionally declares a capability manifest over the live
// `/ws/beacon` WebSocket. See `docs/adr/254-swarm-extensions.md`.

/**
 * Protocol version for the extension protocol. Declared on both the
 * registration payload and the manifest frame; a mismatch is logged and
 * rejected (no negotiation in v0).
 */
export const EXTENSION_PROTOCOL_VERSION = 1;

/**
 * A capability an extension declares in its manifest. Surfaced
 * independently as a coordinator API action and/or as an agent tool; the
 * capability catalog is the single source of truth for both.
 */
export type DroneExtensionCapability = {
  /** Caller-chosen stable name, unique within the extension. */
  name: string;
  /** Human description, surfaced to the LLM for injected tools. */
  description: string;
  /** JSON Schema for the invocation params. Enforced by the coordinator. */
  paramSchema: Record<string, unknown>;
  /** JSON Schema for the response body. Advisory only. */
  responseSchema?: Record<string, unknown>;
  /** Invocation timeout in ms. Defaults to 15000. */
  timeoutMs?: number;
};

/**
 * A front-end bundle declared in the manifest. The bundle's files travel
 * separately over HTTP (`PUT /api/extensions/bundles/:name`).
 */
export type DroneExtensionBundle = {
  /** Bundle name, unique within the node. */
  name: string;
  /** Author-chosen version string. */
  version: string;
  /** sha256 hash of the concatenated file bytes; identities the served dir. */
  hash: string;
  /** UI regions the bundle wants to target, for UI-side filtering. */
  targetRegions?: string[];
};

/**
 * Manifest declared by an extension over the node WebSocket. Replace
 * semantics: a node is an "extension" iff it declares a manifest.
 */
export type DroneExtensionManifest = {
  protocolVersion: number;
  capabilities: DroneExtensionCapability[];
  bundles: DroneExtensionBundle[];
};

/**
 * Names-only snapshot of an agent session, forwarded by the beacon at
 * registration and pushed to every node on `sessionStarted`.
 */
export type DroneSessionSnapshot = {
  protocolVersion: number;
  sessionId: string;
  personaId: string | null;
  beaconId: string;
  interactive: boolean;
  isSubagent: boolean;
  cwd: string;
  enabledPlugins: string[];
  mountedTools: string[];
  /** Free-form hint identifying the session's origin (e.g. a gateway id). */
  extensionHint?: string;
};

/** Injection kinds an extension can push into an agent session. */
export type DroneInjectionKind = 'fragment' | 'reminder' | 'tools';

/**
 * A tool selection in a `tools` injection: a named capability from the
 * extension's catalog. Resolved coordinator-side at injection time.
 */
export type DroneInjectedToolSelection = {
  /** Capability name from the extension's manifest. */
  capability: string;
  /**
   * Resolved capability description, populated coordinator-side from the
   * manifest at injection time so the agent-side tool definition carries a
   * real description. Absent when the coordinator could not resolve it.
   */
  description?: string;
  /** Resolved param schema (JSON Schema), populated coordinator-side. */
  paramSchema?: Record<string, unknown>;
};

/**
 * Node → coordinator `inject` frame. The coordinator resolves the host
 * beacon of `target` and forwards to it.
 */
export type DroneInjectFrame = {
  type: 'inject';
  /** Caller-chosen injection id, used for later removal. */
  id: string;
  /** Recipient agent/session id. */
  target: string;
  kind: DroneInjectionKind;
  /** Fragment/reminder content. Absent for `tools`. */
  content?: string;
  /** Fragment prompt seam. Defaults to `header`. */
  phase?: 'header' | 'footer';
  /** Fragment time-to-live in ms. Absent = lives until removed. */
  ttlMs?: number;
  /** Tool selections for a `tools` injection. */
  tools?: DroneInjectedToolSelection[];
};

/**
 * Node → coordinator `inject-remove` frame. Removes a prior injection, or
 * (for `tools`) a subset of tool selections; an empty/absent `tools` list
 * on a `tools` removal drops all of the extension's tool injections.
 */
export type DroneInjectRemoveFrame = {
  type: 'inject-remove';
  target: string;
  kind: DroneInjectionKind;
  /** Specific injection id to remove. Absent removes all of `kind` from the sender. */
  injectionId?: string;
  /** Tool capability names to drop from the selection. */
  tools?: DroneInjectedToolSelection[];
};

/** Node → coordinator `manifest` frame. */
export type DroneManifestFrame = {
  type: 'manifest';
  protocolVersion: number;
  capabilities: DroneExtensionCapability[];
  bundles: DroneExtensionBundle[];
};

/**
 * Coordinator → node `event` frame. Carries lifecycle notifications to
 * every node (extensions and plain beacons alike).
 */
export type DroneExtensionEventFrame = {
  type: 'event';
  event: 'sessionStarted' | 'sessionEnded';
  session: DroneSessionSnapshot | DroneSessionEndedEvent;
};

/** Payload of a `sessionEnded` event. */
export type DroneSessionEndedEvent = {
  sessionId: string;
  extensionHint?: string;
};
