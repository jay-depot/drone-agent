// ── MCP types ────────────────────────────────────────────────────────

export type DroneMcpServerState = {
  id: string;
  transport: 'stdio' | 'streamable_http';
  ownership: 'spawned' | 'external';
  status: 'connected' | 'connecting' | 'disconnected' | 'error';
  detail: string;
  discoveredToolCount: number;
  mountedToolCount: number;
  filteredToolCount: number;
  toolsListTruncated?: boolean;
  resourcesListTruncated?: boolean;
  promptsListTruncated?: boolean;
  compatibilityMode?: 'strict' | 'permissive';
  retryCount: number;
  retryAttemptCount: number;
  lastErrorCategory?:
    | 'transport'
    | 'timeout'
    | 'protocol'
    | 'payload'
    | 'unknown';
  lastError?: string;
  /** True while the streamable-HTTP GET SSE channel is open. */
  streaming?: boolean;
  /** Last error observed on the GET SSE stream (e.g. a transient drop). */
  lastStreamError?: string;
};

export type DroneMcpMountedToolMeta = {
  serverId: string;
  originalName: string;
  description?: string;
};

export type DroneMcpPromptArgument = {
  name: string;
  required?: boolean;
  description?: string;
};

export type DroneMcpPromptMeta = {
  name: string;
  description?: string;
  arguments?: DroneMcpPromptArgument[];
};

export type DroneMcpResourceMeta = {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
};

export type DroneMcpError = {
  code: string;
  message: string;
  serverId?: string;
  data?: unknown;
};
