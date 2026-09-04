/**
 * Capture pristine globals at module-collection time, before any other
 * suite's hooks can replace them. Some suites (e.g. MCP unit tests) install
 * throwing guards into globalThis.fetch in afterEach and never restore it;
 * under the single-fork pool that poisons every later suite. Reinstalling
 * the pristine references in beforeAll makes this suite order-independent.
 */
const pristineFetch = globalThis.fetch;
const pristineResponse = globalThis.Response;
import {
  createServer,
  request as httpRequest,
  Agent,
  type Server,
} from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { main } from '../src/index.js';

/**
 * A fetch implementation that bypasses globalThis.fetch entirely (node:http
 * under the hood), so the tests stay immune to other suites stubbing or
 * poisoning the global.
 */
function makeDirectFetch(): typeof fetch {
  const agent = new Agent({ keepAlive: false });
  return ((input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      const url = new URL(typeof input === 'string' ? input : input.toString());
      const req = httpRequest(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname + url.search,
          method: init?.method ?? 'GET',
          headers: init?.headers as Record<string, string> | undefined,
          agent,
        },
        res => {
          const chunks: Buffer[] = [];
          res.on('data', chunk => chunks.push(chunk as Buffer));
          res.on('end', () => {
            const bodyText = Buffer.concat(chunks).toString('utf8');
            const status = res.statusCode ?? 500;
            // Minimal Response stand-in built from scratch so the test does
            // not depend on globalThis.Response, which other suites replace.
            const response = {
              ok: status >= 200 && status < 300,
              status,
              statusText: res.statusMessage ?? '',
              text: async () => bodyText,
              json: async () => JSON.parse(bodyText),
            };
            resolve(response as unknown as Response);
          });
        }
      );
      req.on('error', reject);
      if (init?.body) {
        req.write(init.body);
      }
      req.end();
    })) as typeof fetch;
}

/**
 * Wraps a fetch impl and records the request URLs so tests can assert on the
 * query strings the CLI sends (e.g. exclude=archived).
 */
function makeRecordingFetch(inner: typeof fetch, urls: string[]): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => {
    urls.push(String(input));
    return inner(input as string, init);
  }) as typeof fetch;
}

/**
 * Fixture server implementing both route dialects:
 * - coordinator dialect: everything under /api (wiki + sessions)
 * - beacon dialect: flat /wiki routes only
 */
async function startFixture(port: number): Promise<Server> {
  const server = createServer((req, res) => {
    const url = req.url ?? '';
    const sendJson = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (url.startsWith('/api/sessions?') || url === '/api/sessions') {
      return sendJson(200, {
        sessions: [{ id: 's-1', status: 'ended' }],
        count: 1,
        auth: req.headers.authorization ?? null,
      });
    }
    if (url === '/api/sessions/s-1/log') {
      return sendJson(200, {
        session: { id: 's-1' },
        events: [{ type: 'message', payload: 'hello' }],
      });
    }
    if (url === '/api/sessions/s-1/transcript') {
      return sendJson(200, {
        session: { id: 's-1' },
        transcript: '--- Turn 1 ---\nhello',
      });
    }
    if (url === '/api/sessions/s-1/process') {
      return sendJson(200, { session: { id: 's-1', status: 'processing' } });
    }
    if (url === '/api/sessions/s-1/processed') {
      let body = '';
      req.on('data', chunk => {
        body += String(chunk);
      });
      req.on('end', () => {
        sendJson(200, { session: { id: 's-1', status: 'processed', body } });
      });
      return;
    }
    if (url === '/api/sessions/s-1/archive') {
      return sendJson(200, { session: { id: 's-1', status: 'archived' } });
    }
    if (url === '/api/sessions/s-1/restore') {
      return sendJson(200, { session: { id: 's-1', status: 'processed' } });
    }

    if (
      url === '/api/wiki/search?q=pipeline' ||
      url === '/wiki/search?q=pipeline'
    ) {
      return sendJson(200, [
        {
          id: 'memory-pipeline',
          title: 'Memory Pipeline',
          snippet: 'pipeline',
        },
      ]);
    }
    if (url === '/api/wiki/my-page' || url === '/wiki/my-page') {
      if (req.method === 'PUT') {
        let body = '';
        req.on('data', chunk => {
          body += String(chunk);
        });
        req.on('end', () => {
          sendJson(200, { id: 'my-page', written: JSON.parse(body) });
        });
        return;
      }
      return sendJson(200, {
        id: 'my-page',
        title: 'My Page',
        content: '# My Page\n\nHello',
        auth: req.headers.authorization ?? null,
      });
    }
    if (url === '/api/wiki/missing' || url === '/wiki/missing') {
      return sendJson(404, { error: 'Wiki page not found' });
    }

    sendJson(404, { error: `no fixture for ${req.method} ${url}` });
  });

  await new Promise<void>(resolve =>
    server.listen(port === -1 ? 0 : port, '127.0.0.1', resolve)
  );
  return server;
}

function listeningPort(server: Server): number {
  const addr = server.address();
  if (!addr || typeof addr !== 'object') {
    throw new Error('fixture server has no address');
  }
  return addr.port;
}

describe('drone-swarm CLI against a coordinator-dialect fixture', () => {
  let server: Server;
  let port = -1;
  const directFetch = makeDirectFetch();

  beforeAll(async () => {
    globalThis.fetch = pristineFetch;
    (globalThis as { Response: unknown }).Response = pristineResponse;
    globalThis.fetch = pristineFetch;
    (globalThis as { Response: unknown }).Response = pristineResponse;
    server = await startFixture(port);
    port = listeningPort(server);
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it('session list uses the /api prefix and prints JSON', async () => {
    const out: string[] = [];
    const originalLog = console.log;
    console.log = (...msgs: unknown[]) => {
      out.push(msgs.map(String).join(' '));
    };
    try {
      const code = await main(
        [
          '--coordinator',
          `http://127.0.0.1:${port}`,
          'session',
          'list',
          '--status',
          'ended',
        ],
        directFetch
      );
      expect(code).toBe(0);
      const parsed = JSON.parse(out.join('\n'));
      expect(parsed.count).toBe(1);
      expect(parsed.sessions[0].id).toBe('s-1');
    } finally {
      console.log = originalLog;
    }
  });

  it('session list (no --status) sends exclude=archived by default', async () => {
    const out: string[] = [];
    const urls: string[] = [];
    const originalLog = console.log;
    console.log = (...msgs: unknown[]) => {
      out.push(msgs.map(String).join(' '));
    };
    try {
      const recordingFetch = makeRecordingFetch(directFetch, urls);
      const code = await main(
        ['--coordinator', `http://127.0.0.1:${port}`, 'session', 'list'],
        recordingFetch
      );
      expect(code).toBe(0);
      const parsed = JSON.parse(out.join('\n'));
      expect(parsed.count).toBe(1);
      expect(urls.some(u => u.includes('exclude=archived'))).toBe(true);
    } finally {
      console.log = originalLog;
    }
  });

  it('session list --status archived does not add exclude=archived', async () => {
    const out: string[] = [];
    const urls: string[] = [];
    const originalLog = console.log;
    console.log = (...msgs: unknown[]) => {
      out.push(msgs.map(String).join(' '));
    };
    try {
      const recordingFetch = makeRecordingFetch(directFetch, urls);
      const code = await main(
        [
          '--coordinator',
          `http://127.0.0.1:${port}`,
          'session',
          'list',
          '--status',
          'archived',
        ],
        recordingFetch
      );
      expect(code).toBe(0);
      const parsed = JSON.parse(out.join('\n'));
      expect(parsed.count).toBe(1);
      expect(urls.some(u => u.includes('exclude=archived'))).toBe(false);
      expect(urls.some(u => u.includes('status=archived'))).toBe(true);
    } finally {
      console.log = originalLog;
    }
  });

  it('session archive archives a session', async () => {
    const out: string[] = [];
    const originalLog = console.log;
    console.log = (...msgs: unknown[]) => {
      out.push(msgs.map(String).join(' '));
    };
    try {
      const code = await main(
        [
          '--coordinator',
          `http://127.0.0.1:${port}`,
          'session',
          'archive',
          's-1',
        ],
        directFetch
      );
      expect(code).toBe(0);
      const parsed = JSON.parse(out.join('\n'));
      expect(parsed.session.status).toBe('archived');
    } finally {
      console.log = originalLog;
    }
  });

  it('session restore restores a session', async () => {
    const out: string[] = [];
    const originalLog = console.log;
    console.log = (...msgs: unknown[]) => {
      out.push(msgs.map(String).join(' '));
    };
    try {
      const code = await main(
        [
          '--coordinator',
          `http://127.0.0.1:${port}`,
          'session',
          'restore',
          's-1',
        ],
        directFetch
      );
      expect(code).toBe(0);
      const parsed = JSON.parse(out.join('\n'));
      expect(parsed.session.status).toBe('processed');
    } finally {
      console.log = originalLog;
    }
  });

  it('session transcript prints the readable turn transcript', async () => {
    const out: string[] = [];
    const originalLog = console.log;
    console.log = (...msgs: unknown[]) => {
      out.push(msgs.map(String).join(' '));
    };
    try {
      const code = await main(
        [
          '--coordinator',
          `http://127.0.0.1:${port}`,
          'session',
          'transcript',
          's-1',
        ],
        directFetch
      );
      expect(code).toBe(0);
      expect(out.join('\n')).toContain('--- Turn 1 ---');
    } finally {
      console.log = originalLog;
    }
  });

  it('session log retrieves the transcript', async () => {
    const out: string[] = [];
    const originalLog = console.log;
    console.log = (...msgs: unknown[]) => {
      out.push(msgs.map(String).join(' '));
    };
    try {
      const code = await main(
        ['--coordinator', `http://127.0.0.1:${port}`, 'session', 'log', 's-1'],
        directFetch
      );
      expect(code).toBe(0);
      const parsed = JSON.parse(out.join('\n'));
      expect(parsed.session.id).toBe('s-1');
      expect(parsed.events).toHaveLength(1);
    } finally {
      console.log = originalLog;
    }
  });

  it('session process transitions to processing', async () => {
    const out: string[] = [];
    const originalLog = console.log;
    console.log = (...msgs: unknown[]) => {
      out.push(msgs.map(String).join(' '));
    };
    try {
      const code = await main(
        [
          '--coordinator',
          `http://127.0.0.1:${port}`,
          'session',
          'process',
          's-1',
        ],
        directFetch
      );
      expect(code).toBe(0);
      const parsed = JSON.parse(out.join('\n'));
      expect(parsed.session.status).toBe('processing');
    } finally {
      console.log = originalLog;
    }
  });

  it('session processed posts summary/notes', async () => {
    const out: string[] = [];
    const originalLog = console.log;
    console.log = (...msgs: unknown[]) => {
      out.push(msgs.map(String).join(' '));
    };
    try {
      const code = await main(
        [
          '--coordinator',
          `http://127.0.0.1:${port}`,
          'session',
          'processed',
          's-1',
          '--summary',
          'done',
          '--notes',
          'ok',
        ],
        directFetch
      );
      expect(code).toBe(0);
      const parsed = JSON.parse(out.join('\n'));
      expect(parsed.session.status).toBe('processed');
      const sentBody = JSON.parse(parsed.session.body);
      expect(sentBody.summary).toBe('done');
      expect(sentBody.notes).toBe('ok');
    } finally {
      console.log = originalLog;
    }
  });

  it('wiki read/write/search work through the coordinator dialect', async () => {
    const out: string[] = [];
    const originalLog = console.log;
    console.log = (...msgs: unknown[]) => {
      out.push(msgs.map(String).join(' '));
    };
    try {
      expect(
        await main(
          [
            '--coordinator',
            `http://127.0.0.1:${port}`,
            'wiki',
            'read',
            'my-page',
          ],
          directFetch
        )
      ).toBe(0);
      expect(JSON.parse(out[0]).title).toBe('My Page');

      out.length = 0;
      expect(
        await main(
          [
            '--coordinator',
            `http://127.0.0.1:${port}`,
            'wiki',
            'write',
            'my-page',
            '--title',
            'T',
            '--content',
            'C',
            '--tags',
            'a,b',
          ],
          directFetch
        )
      ).toBe(0);
      const written = JSON.parse(out[0]);
      expect(written.written.title).toBe('T');
      expect(written.written.tags).toEqual(['a', 'b']);

      out.length = 0;
      expect(
        await main(
          [
            '--coordinator',
            `http://127.0.0.1:${port}`,
            'wiki',
            'search',
            'pipeline',
          ],
          directFetch
        )
      ).toBe(0);
      expect(JSON.parse(out[0]).results).toHaveLength(1);

      out.length = 0;
      const errSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => undefined);
      try {
        expect(
          await main(
            [
              '--coordinator',
              `http://127.0.0.1:${port}`,
              'wiki',
              'read',
              'missing',
            ],
            directFetch
          )
        ).toBe(1);
        expect(errSpy).toHaveBeenCalled();
      } finally {
        errSpy.mockRestore();
      }
    } finally {
      console.log = originalLog;
    }
  });

  it('sends Bearer token from the --web-token flag', async () => {
    const out: string[] = [];
    const originalLog = console.log;
    console.log = (...msgs: unknown[]) => {
      out.push(msgs.map(String).join(' '));
    };
    try {
      const code = await main(
        [
          '--coordinator',
          `http://127.0.0.1:${port}`,
          '--web-token',
          'flag-token',
          'wiki',
          'read',
          'my-page',
        ],
        directFetch
      );
      expect(code).toBe(0);
      expect(JSON.parse(out.join('\n')).auth).toBe('Bearer flag-token');
    } finally {
      console.log = originalLog;
    }
  });

  it('sends Bearer token from DRONE_COORDINATOR_WEB_TOKEN', async () => {
    const previous = process.env.DRONE_COORDINATOR_WEB_TOKEN;
    process.env.DRONE_COORDINATOR_WEB_TOKEN = 'env-token';
    const out: string[] = [];
    const originalLog = console.log;
    console.log = (...msgs: unknown[]) => {
      out.push(msgs.map(String).join(' '));
    };
    try {
      const code = await main(
        [
          '--coordinator',
          `http://127.0.0.1:${port}`,
          'wiki',
          'read',
          'my-page',
        ],
        directFetch
      );
      expect(code).toBe(0);
      expect(JSON.parse(out.join('\n')).auth).toBe('Bearer env-token');
    } finally {
      console.log = originalLog;
      if (previous === undefined) {
        delete process.env.DRONE_COORDINATOR_WEB_TOKEN;
      } else {
        process.env.DRONE_COORDINATOR_WEB_TOKEN = previous;
      }
    }
  });

  it('the --web-token flag wins over the env var', async () => {
    const previous = process.env.DRONE_COORDINATOR_WEB_TOKEN;
    process.env.DRONE_COORDINATOR_WEB_TOKEN = 'env-token';
    const out: string[] = [];
    const originalLog = console.log;
    console.log = (...msgs: unknown[]) => {
      out.push(msgs.map(String).join(' '));
    };
    try {
      const code = await main(
        [
          '--coordinator',
          `http://127.0.0.1:${port}`,
          '--web-token',
          'flag-token',
          'wiki',
          'read',
          'my-page',
        ],
        directFetch
      );
      expect(code).toBe(0);
      expect(JSON.parse(out.join('\n')).auth).toBe('Bearer flag-token');
    } finally {
      console.log = originalLog;
      if (previous === undefined) {
        delete process.env.DRONE_COORDINATOR_WEB_TOKEN;
      } else {
        process.env.DRONE_COORDINATOR_WEB_TOKEN = previous;
      }
    }
  });

  it('sends no Authorization header when no token is configured', async () => {
    const previous = process.env.DRONE_COORDINATOR_WEB_TOKEN;
    delete process.env.DRONE_COORDINATOR_WEB_TOKEN;
    const out: string[] = [];
    const originalLog = console.log;
    console.log = (...msgs: unknown[]) => {
      out.push(msgs.map(String).join(' '));
    };
    try {
      const code = await main(
        [
          '--coordinator',
          `http://127.0.0.1:${port}`,
          'wiki',
          'read',
          'my-page',
        ],
        directFetch
      );
      expect(code).toBe(0);
      expect(JSON.parse(out.join('\n')).auth).toBeNull();
    } finally {
      console.log = originalLog;
      if (previous !== undefined) {
        process.env.DRONE_COORDINATOR_WEB_TOKEN = previous;
      }
    }
  });
});

describe('drone-swarm CLI against a beacon-dialect fixture', () => {
  let server: Server;
  let port = -1;
  const directFetch = makeDirectFetch();

  beforeAll(async () => {
    server = await startFixture(port);
    port = listeningPort(server);
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it('wiki commands use the flat route prefix', async () => {
    const out: string[] = [];
    const originalLog = console.log;
    console.log = (...msgs: unknown[]) => {
      out.push(msgs.map(String).join(' '));
    };
    try {
      expect(
        await main(
          ['--beacon', `http://127.0.0.1:${port}`, 'wiki', 'read', 'my-page'],
          directFetch
        )
      ).toBe(0);
      expect(JSON.parse(out[0]).id).toBe('my-page');

      out.length = 0;
      expect(
        await main(
          [
            '--beacon',
            `http://127.0.0.1:${port}`,
            'wiki',
            'search',
            'pipeline',
          ],
          directFetch
        )
      ).toBe(0);
      expect(JSON.parse(out[0]).results).toHaveLength(1);
    } finally {
      console.log = originalLog;
    }
  });

  it('ignores DRONE_COORDINATOR_WEB_TOKEN on the beacon target', async () => {
    const previous = process.env.DRONE_COORDINATOR_WEB_TOKEN;
    process.env.DRONE_COORDINATOR_WEB_TOKEN = 'env-token';
    const out: string[] = [];
    const originalLog = console.log;
    console.log = (...msgs: unknown[]) => {
      out.push(msgs.map(String).join(' '));
    };
    try {
      const code = await main(
        ['--beacon', `http://127.0.0.1:${port}`, 'wiki', 'read', 'my-page'],
        directFetch
      );
      expect(code).toBe(0);
      expect(JSON.parse(out[0]).auth).toBeNull();
    } finally {
      console.log = originalLog;
      if (previous === undefined) {
        delete process.env.DRONE_COORDINATOR_WEB_TOKEN;
      } else {
        process.env.DRONE_COORDINATOR_WEB_TOKEN = previous;
      }
    }
  });

  it('rejects --beacon and --coordinator together', async () => {
    const errSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    try {
      const code = await main([
        '--beacon',
        'http://127.0.0.1:1',
        '--coordinator',
        'http://127.0.0.1:2',
        'wiki',
        'read',
        'x',
      ]);
      expect(code).toBe(1);
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining('mutually exclusive')
      );
    } finally {
      errSpy.mockRestore();
    }
  });
});
