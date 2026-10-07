export const HTTP_TIMEOUT_MS = 30_000;

export interface ControlApiClientOptions {
  host: string;
  port: number;
  token?: string;
}

export class GatewayUnreachableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'GatewayUnreachableError';
  }
}

export class GatewayHttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'GatewayHttpError';
  }
}

export class ControlApiClient {
  private readonly baseUrl: string;

  constructor(private readonly opts: ControlApiClientOptions) {
    this.baseUrl = `http://${opts.host}:${opts.port}`;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.opts.token) h['Authorization'] = `Bearer ${this.opts.token}`;
    return h;
  }

  private async request(
    method: string,
    path: string,
    body?: unknown
  ): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: this.headers(),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
    } catch (err) {
      throw new GatewayUnreachableError(
        `Gateway not reachable at ${this.opts.host}:${this.opts.port} ` +
          `(is it running? is controlApi.enabled true?)`,
        { cause: err }
      );
    }
    if (!res.ok) {
      let detail = `${res.status}`;
      try {
        const parsed = (await res.json()) as { error?: string };
        if (parsed.error) detail = parsed.error;
      } catch {
        // Not JSON — keep the bare status.
      }
      throw new GatewayHttpError(res.status, detail);
    }
    return res.json();
  }

  async status(): Promise<{
    ok: boolean;
    version: string;
    adapters: string[];
  }> {
    return (await this.request('GET', '/status')) as {
      ok: boolean;
      version: string;
      adapters: string[];
    };
  }

  async listConversations(): Promise<
    Array<{ adapterId: string; conversationId: string }>
  > {
    const data = (await this.request('GET', '/conversations')) as {
      conversations: Array<{ adapterId: string; conversationId: string }>;
    };
    return data.conversations;
  }

  async inject(
    adapterId: string,
    conversationId: string,
    text: string
  ): Promise<void> {
    await this.request('POST', '/inject', { adapterId, conversationId, text });
  }
}
