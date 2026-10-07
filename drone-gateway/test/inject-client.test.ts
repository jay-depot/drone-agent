import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  ControlApiClient,
  GatewayHttpError,
  GatewayUnreachableError,
} from '../src/inject/client.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe('ControlApiClient', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.stubGlobal('fetch', mockFetch);
  });

  it('composes the base URL from host and port', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({ ok: true, version: '1', adapters: [] })
    );
    const client = new ControlApiClient({ host: '127.0.0.1', port: 8090 });
    await client.status();
    expect(mockFetch.mock.calls[0][0]).toBe('http://127.0.0.1:8090/status');
  });

  it('returns the status payload', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({ ok: true, version: '2.0.0', adapters: ['matrix'] })
    );
    const client = new ControlApiClient({ host: 'h', port: 1 });
    await expect(client.status()).resolves.toEqual({
      ok: true,
      version: '2.0.0',
      adapters: ['matrix'],
    });
  });

  it('returns the conversations list', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        ok: true,
        conversations: [{ adapterId: 'a', conversationId: 'c' }],
      })
    );
    const client = new ControlApiClient({ host: 'h', port: 1 });
    await expect(client.listConversations()).resolves.toEqual([
      { adapterId: 'a', conversationId: 'c' },
    ]);
  });

  it('sends a POST /inject with the JSON body', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ ok: true, posted: true }));
    const client = new ControlApiClient({ host: 'h', port: 1 });
    await client.inject('a', 'c', 'hello');
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://h:1/inject');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      adapterId: 'a',
      conversationId: 'c',
      text: 'hello',
    });
  });

  it('sends a Bearer header when a token is set', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({ ok: true, version: '', adapters: [] })
    );
    const client = new ControlApiClient({ host: 'h', port: 1, token: 't0ken' });
    await client.status();
    expect(mockFetch.mock.calls[0][1].headers).toMatchObject({
      Authorization: 'Bearer t0ken',
    });
  });

  it('omits the Bearer header when no token is set', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({ ok: true, version: '', adapters: [] })
    );
    const client = new ControlApiClient({ host: 'h', port: 1 });
    await client.status();
    expect(mockFetch.mock.calls[0][1].headers).not.toHaveProperty(
      'Authorization'
    );
  });

  it('throws GatewayHttpError with the server error detail on 404/403', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({ ok: false, error: 'Unknown adapter: x' }, 404)
    );
    const client = new ControlApiClient({ host: 'h', port: 1 });
    const err = await client.inject('x', 'c', 'hi').catch(e => e);
    expect(err).toBeInstanceOf(GatewayHttpError);
    expect((err as GatewayHttpError).status).toBe(404);
    expect((err as GatewayHttpError).message).toBe('Unknown adapter: x');
  });

  it('falls back to the bare status when the error body is not JSON', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error('not json');
      },
    } as unknown as Response);
    const client = new ControlApiClient({ host: 'h', port: 1 });
    const err = await client.inject('a', 'c', 'hi').catch(e => e);
    expect(err).toBeInstanceOf(GatewayHttpError);
    expect((err as GatewayHttpError).message).toBe('500');
  });

  it('throws GatewayUnreachableError on a network failure', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
    const client = new ControlApiClient({ host: 'h', port: 9 });
    await expect(client.status()).rejects.toBeInstanceOf(
      GatewayUnreachableError
    );
  });
});
