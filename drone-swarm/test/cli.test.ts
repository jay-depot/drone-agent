import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { main } from '../src/index.js';

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
      });
    }
    if (url === '/api/sessions/s-1/log') {
      return sendJson(200, {
        session: { id: 's-1' },
        events: [{ type: 'message', payload: 'hello' }],
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
      });
    }
    if (url === '/api/wiki/missing' || url === '/wiki/missing') {
      return sendJson(404, { error: 'Wiki page not found' });
    }

    sendJson(404, { error: `no fixture for ${req.method} ${url}` });
  });

  await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve));
  return server;
}

describe('drone-swarm CLI against a coordinator-dialect fixture', () => {
  let server: Server;
  const port = 4573;

  beforeAll(async () => {
    server = await startFixture(port);
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
      const code = await main([
        '--coordinator',
        `http://127.0.0.1:${port}`,
        'session',
        'list',
        '--status',
        'ended',
      ]);
      expect(code).toBe(0);
      const parsed = JSON.parse(out.join('\n'));
      expect(parsed.count).toBe(1);
      expect(parsed.sessions[0].id).toBe('s-1');
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
      const code = await main([
        '--coordinator',
        `http://127.0.0.1:${port}`,
        'session',
        'log',
        's-1',
      ]);
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
      const code = await main([
        '--coordinator',
        `http://127.0.0.1:${port}`,
        'session',
        'process',
        's-1',
      ]);
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
      const code = await main([
        '--coordinator',
        `http://127.0.0.1:${port}`,
        'session',
        'processed',
        's-1',
        '--summary',
        'done',
        '--notes',
        'ok',
      ]);
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
        await main([
          '--coordinator',
          `http://127.0.0.1:${port}`,
          'wiki',
          'read',
          'my-page',
        ])
      ).toBe(0);
      expect(JSON.parse(out[0]).title).toBe('My Page');

      out.length = 0;
      expect(
        await main([
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
        ])
      ).toBe(0);
      const written = JSON.parse(out[0]);
      expect(written.written.title).toBe('T');
      expect(written.written.tags).toEqual(['a', 'b']);

      out.length = 0;
      expect(
        await main([
          '--coordinator',
          `http://127.0.0.1:${port}`,
          'wiki',
          'search',
          'pipeline',
        ])
      ).toBe(0);
      expect(JSON.parse(out[0]).results).toHaveLength(1);

      out.length = 0;
      const errSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => undefined);
      try {
        expect(
          await main([
            '--coordinator',
            `http://127.0.0.1:${port}`,
            'wiki',
            'read',
            'missing',
          ])
        ).toBe(1);
        expect(errSpy).toHaveBeenCalled();
      } finally {
        errSpy.mockRestore();
      }
    } finally {
      console.log = originalLog;
    }
  });
});

describe('drone-swarm CLI against a beacon-dialect fixture', () => {
  let server: Server;
  const port = 4574;

  beforeAll(async () => {
    server = await startFixture(port);
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
        await main([
          '--beacon',
          `http://127.0.0.1:${port}`,
          'wiki',
          'read',
          'my-page',
        ])
      ).toBe(0);
      expect(JSON.parse(out[0]).id).toBe('my-page');

      out.length = 0;
      expect(
        await main([
          '--beacon',
          `http://127.0.0.1:${port}`,
          'wiki',
          'search',
          'pipeline',
        ])
      ).toBe(0);
      expect(JSON.parse(out[0]).results).toHaveLength(1);
    } finally {
      console.log = originalLog;
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
