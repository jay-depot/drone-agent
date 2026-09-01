import type { SwarmTarget } from './address.js';

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface WikiPageSummary {
  id: string;
  title: string;
  scope?: string;
  tags?: string[];
  sources?: string[];
}

export interface WikiSearchResult {
  id: string;
  title: string;
  snippet?: string;
}

/**
 * REST client for one swarm server. The route dialect differs by target: the
 * coordinator serves everything under /api/... while the beacon serves wiki
 * routes flat (/wiki/...) and only proxies session reads via /sync/sessions.
 */
export class SwarmClient {
  constructor(
    readonly target: SwarmTarget,
    private readonly baseUrl: string,
    private readonly webToken?: string,
    private readonly fetchImpl: typeof fetch = (...args) =>
      fetch(...(args as Parameters<typeof fetch>))
  ) {}

  private url(path: string): string {
    const prefix = this.target === 'coordinator' ? '/api' : '';
    return `${this.baseUrl}${prefix}${path}`;
  }

  async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<{ status: number; data: T }> {
    const response = await this.fetchImpl(this.url(path), {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(this.webToken ? { Authorization: `Bearer ${this.webToken}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000),
    });
    const text = await response.text();
    let data: unknown = undefined;
    if (text.length > 0) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    return { status: response.status, data: data as T };
  }

  // === Session pipeline (coordinator dialect only; beacon proxies reads) ===

  async listSessions(query: Record<string, string> = {}): Promise<{
    status: number;
    sessions: unknown[];
    count: number;
  }> {
    const params = new URLSearchParams(query).toString();
    const path =
      this.target === 'coordinator'
        ? `/sessions${params ? `?${params}` : ''}`
        : `/sync/sessions${params ? `?${params}` : ''}`;
    const { status, data } = await this.request<{
      sessions?: unknown[];
      count?: number;
    }>('GET', path);
    if (status !== 200) {
      throw new ApiError(status, `Failed to list sessions: ${status}`);
    }
    return {
      status,
      sessions: data.sessions ?? [],
      count: data.count ?? data.sessions?.length ?? 0,
    };
  }

  async getSessionLog(sessionId: string): Promise<{
    status: number;
    log: unknown;
  }> {
    const path =
      this.target === 'coordinator'
        ? `/sessions/${encodeURIComponent(sessionId)}/log`
        : `/sync/sessions/${encodeURIComponent(sessionId)}/log`;
    const { status, data } = await this.request<unknown>('GET', path);
    if (status !== 200) {
      throw new ApiError(status, `Failed to get session log: ${status}`);
    }
    return { status, log: data };
  }

  async getSessionTranscript(sessionId: string): Promise<{
    status: number;
    transcript: unknown;
  }> {
    const path = `/sessions/${encodeURIComponent(sessionId)}/transcript`;
    const { status, data } = await this.request<{
      transcript?: unknown;
    }>('GET', path);
    if (status !== 200) {
      throw new ApiError(status, `Failed to get session transcript: ${status}`);
    }
    return { status, transcript: data.transcript ?? data };
  }

  async processSession(
    sessionId: string
  ): Promise<{ status: number; result: unknown }> {
    const { status, data } = await this.request<unknown>(
      'POST',
      `/sessions/${encodeURIComponent(sessionId)}/process`
    );
    if (status !== 200) {
      throw new ApiError(status, `Failed to process session: ${status}`);
    }
    return { status, result: data };
  }

  async markSessionProcessed(
    sessionId: string,
    body: { summary?: string; notes?: string } = {}
  ): Promise<{ status: number; result: unknown }> {
    const { status, data } = await this.request<unknown>(
      'POST',
      `/sessions/${encodeURIComponent(sessionId)}/processed`,
      body
    );
    if (status !== 200) {
      throw new ApiError(status, `Failed to mark session processed: ${status}`);
    }
    return { status, result: data };
  }

  // === Prompt fragments (list: both layers; set/delete: beacon only) ===

  async listFragments(query: Record<string, string> = {}): Promise<{
    status: number;
    fragments: unknown[];
  }> {
    const params = new URLSearchParams(query).toString();
    const { status, data } = await this.request<{
      fragments?: unknown[];
    }>('GET', `/fragments${params ? `?${params}` : ''}`);
    if (status !== 200) {
      throw new ApiError(status, `Failed to list fragments: ${status}`);
    }
    return { status, fragments: data.fragments ?? [] };
  }

  async setFragment(body: {
    id: string;
    target: string;
    content: string;
    phase?: string;
    expiresAt?: number | null;
  }): Promise<{ status: number; fragment: unknown }> {
    if (this.target !== 'beacon') {
      throw new ApiError(
        400,
        'fragment authoring requires --beacon (coordinator authoring arrives with the persistent-WS rework)'
      );
    }
    const { status, data } = await this.request<{
      fragment?: unknown;
      error?: string;
    }>('POST', '/fragments', body);
    if (status !== 200) {
      throw new ApiError(
        status,
        `Failed to set fragment: ${status}${typeof data === 'object' && data !== null && 'error' in data ? ` (${(data as { error: string }).error})` : ''}`
      );
    }
    return { status, fragment: data.fragment };
  }

  async deleteFragment(
    id: string,
    target?: string
  ): Promise<{ status: number; result: unknown }> {
    if (this.target !== 'beacon') {
      throw new ApiError(
        400,
        'fragment authoring requires --beacon (coordinator authoring arrives with the persistent-WS rework)'
      );
    }
    const params = new URLSearchParams();
    if (target) {
      params.set('target', target);
    }
    const { status, data } = await this.request<unknown>(
      'DELETE',
      `/fragments/${encodeURIComponent(id)}${params.size > 0 ? `?${params.toString()}` : ''}`
    );
    if (status !== 200) {
      throw new ApiError(status, `Failed to delete fragment: ${status}`);
    }
    return { status, result: data };
  }

  // === Wiki (available at both layers; route dialect handled in url()) ===

  async readWikiPage(
    pageId: string
  ): Promise<{ status: number; page: unknown }> {
    const { status, data } = await this.request<unknown>(
      'GET',
      `/wiki/${encodeURIComponent(pageId)}`
    );
    if (status !== 200) {
      throw new ApiError(status, `Wiki page not found: ${status}`);
    }
    return { status, page: data };
  }

  async writeWikiPage(
    pageId: string,
    body: {
      title: string;
      content: string;
      scope?: string;
      tags?: string[];
      sources?: string[];
    }
  ): Promise<{ status: number; page: unknown }> {
    const { status, data } = await this.request<unknown>(
      'PUT',
      `/wiki/${encodeURIComponent(pageId)}`,
      body
    );
    if (status !== 200 && status !== 201) {
      throw new ApiError(status, `Failed to write wiki page: ${status}`);
    }
    return { status, page: data };
  }

  async searchWiki(query: string): Promise<WikiSearchResult[]> {
    const { status, data } = await this.request<unknown[] | { error: string }>(
      'GET',
      `/wiki/search?q=${encodeURIComponent(query)}`
    );
    if (status !== 200) {
      throw new ApiError(status, `Wiki search failed: ${status}`);
    }
    return (Array.isArray(data) ? data : []) as WikiSearchResult[];
  }
}
