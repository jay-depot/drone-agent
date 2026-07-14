// ── LSP types ────────────────────────────────────────────────────────

/**
 * 0-based LSP position (raw wire format).
 *
 * `line` and `character` follow the LSP protocol convention: both are
 * zero-based. Tools in the LSP plugin convert to 1-based for the LLM
 * and back to 0-based when sending requests to the server.
 */
export type DroneLspPosition = {
  line: number;
  character: number;
};

export type DroneLspRange = {
  start: DroneLspPosition;
  end: DroneLspPosition;
};

export type DroneLspDiagnostic = {
  filePath: string;
  range: DroneLspRange;
  severity: 'error' | 'warning' | 'information' | 'hint';
  message: string;
  source?: string;
  code?: string;
};

export type DroneLspHoverResult = {
  filePath: string;
  /** 1-based line number (post-conversion from LSP). */
  line: number;
  /** 1-based column number (post-conversion from LSP). */
  column: number;
  contents: string;
  range?: DroneLspRange;
};

export type DroneLspServerState = {
  id: string;
  language: string;
  transport: 'stdio' | 'tcp';
  ownership: 'spawned' | 'external';
  status: 'connected' | 'connecting' | 'disconnected' | 'error';
  detail: string;
  lastError?: string;
  /**
   * Where the running command came from. `'path'` means the user's
   * installed binary on PATH; `'cache'` means the auto-installed copy
   * in `~/.cache/drone-agent/lsp/...`.
   */
  installSource?: 'path' | 'cache';
  /**
   * Lifecycle of the auto-install step for this server. `'unused'`
   * means the server was found on PATH or auto-install is disabled;
   * `'cached'` means a previous install was reused; `'downloaded'`
   * means we just fetched it for the first time; `'failed'` means
   * the download/extract/integrity step failed and the server is
   * offline.
   */
  installStatus?: 'unused' | 'cached' | 'downloaded' | 'failed';
};
