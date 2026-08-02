// ── LSP types ────────────────────────────────────────────────────────

/**
 * Describes how to auto-install a known LSP server when it isn't on PATH.
 * The `type` field determines how the tarball URL is resolved and how the
 * server binary is invoked after extraction.
 *
 * - `npm`: Download from the npm registry, invoke via `node <entryPoint>`.
 * - `cargo`: Download from crates.io, invoke the extracted binary.
 * - `pip`: Download from PyPI, invoke the extracted binary.
 * - `go`: Download from the Go module proxy, invoke the extracted binary.
 * - `github-release`: Download a prebuilt binary from a GitHub release,
 *   invoke the extracted binary. The tarball URL is pre-resolved and
 *   includes platform/arch in the filename.
 */
export type DroneLspInstallSpec = {
  type: 'npm' | 'cargo' | 'pip' | 'go' | 'github-release';
  package: string;
  version: string;
  tarballUrl: string;
  integrity: string;
  entryPoint?: string;
};

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
