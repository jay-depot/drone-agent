import { describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  createChildTransport,
  createJsonRpcClient,
  createStderrRingBuffer,
} from '../src/plugins/lsp/transport.js';
import { startFakeLspServer } from './lsp-fake-server.js';

describe('createStderrRingBuffer', () => {
  it('keeps only the last N complete lines', () => {
    const ring = createStderrRingBuffer(3);
    ring.add('one\ntwo\nthree\nfour\n');
    expect(ring.tail()).toEqual(['two', 'three', 'four']);
  });

  it('joins partial lines across chunk boundaries', () => {
    const ring = createStderrRingBuffer(10);
    ring.add('hel');
    ring.add('lo\nwor');
    ring.add('ld\n');
    expect(ring.tail()).toEqual(['hello', 'world']);
  });

  it('includes a trailing partial line in the tail', () => {
    const ring = createStderrRingBuffer(10);
    ring.add('complete\npartial-without-newline');
    expect(ring.tail()).toEqual(['complete', 'partial-without-newline']);
  });

  it('caps capacity including the trailing partial line', () => {
    const ring = createStderrRingBuffer(2);
    ring.add('a\nb\nc\nd');
    expect(ring.tail()).toEqual(['c', 'd']);
  });
});

describe('createChildTransport stream-error routing', () => {
  it('routes a stdin EPIPE into onError instead of killing the process', async () => {
    const fake = await startFakeLspServer({ respondToInitialize: true });
    try {
      await fake.waitForReady();
      const transport = createChildTransport(fake.child);
      const transportIssues: string[] = [];
      const client = createJsonRpcClient({
        transport,
        requestTimeoutMs: 5000,
        onNotification: () => {},
        onTransportIssue: message => {
          transportIssues.push(message);
        },
      });

      // Kill the child, then write. The stdin write after child death must
      // surface as a transport issue (markClosed), never as an unhandled
      // 'error' event that would crash the agent process.
      fake.child.kill('SIGKILL');
      await once(fake.child, 'close');

      await expect(client.request('textDocument/hover', {})).rejects.toThrow();
      expect(transportIssues.length).toBeGreaterThan(0);
      expect(transportIssues[0]).toMatch(/EPIPE|closed|exit/i);
    } finally {
      await fake.stop();
    }
  });

  it('does not emit an unhandled error when the process exits mid-connection', async () => {
    const unhandled: unknown[] = [];
    const handler = (error: unknown): void => {
      unhandled.push(error);
    };
    process.on('unhandledRejection', handler);
    try {
      const fake = await startFakeLspServer({
        respondToInitialize: true,
        exitAfterInitialize: true,
      });
      try {
        await fake.waitForReady();
        const transport = createChildTransport(fake.child);
        const client = createJsonRpcClient({
          transport,
          requestTimeoutMs: 5000,
          onNotification: () => {},
          onTransportIssue: () => {},
        });
        await client.request('initialize', {});
        await once(fake.child, 'close');
        // Drain a microtask turn so a bad rejection would fire.
        await new Promise(resolve => setImmediate(resolve));
        expect(unhandled).toEqual([]);
      } finally {
        await fake.stop();
      }
    } finally {
      process.off('unhandledRejection', handler);
    }
  });

  it('captures stderr into the ring buffer for forensics', async () => {
    const child = spawn(
      process.execPath,
      [
        '-e',
        'setInterval(() => { console.error("forensics-line-one"); console.error("forensics-line-two"); }, 20);',
      ],
      { stdio: 'pipe' }
    );
    const transport = createChildTransport(
      child as Parameters<typeof createChildTransport>[0]
    );
    try {
      await new Promise(resolve => setTimeout(resolve, 200));
      const tail = transport.lastStderrTail();
      expect(tail).toContain('forensics-line-one');
      expect(tail).toContain('forensics-line-two');
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('markClosed rejects pending requests with the close reason', async () => {
    const fake = await startFakeLspServer({
      hangOnMethod: 'textDocument/hover',
    });
    try {
      await fake.waitForReady();
      const transport = createChildTransport(fake.child);
      const client = createJsonRpcClient({
        transport,
        requestTimeoutMs: 10_000,
        onNotification: () => {},
        onTransportIssue: () => {},
      });
      const pendingPromise = client.request('textDocument/hover', {});
      fake.child.kill('SIGKILL');
      await expect(pendingPromise).rejects.toThrow(
        /exited with signal|exited with code/
      );
    } finally {
      await fake.stop();
    }
  });

  it('survives spawn failure (ENOENT) without an unhandled error event', async () => {
    const child = spawn('definitely-not-a-real-binary-xyz', ['--stdio'], {
      stdio: 'pipe',
    }) as never;
    const transport = createChildTransport(
      child as Parameters<typeof createChildTransport>[0]
    );
    const issues: string[] = [];
    const client = createJsonRpcClient({
      transport,
      requestTimeoutMs: 5000,
      onNotification: () => {},
      onTransportIssue: message => {
        issues.push(message);
      },
    });
    await expect(client.request('initialize', {})).rejects.toThrow();
    expect(issues.length).toBeGreaterThan(0);
  });
});

describe('createJsonRpcClient sendMessage write-throw safety', () => {
  it('routes a synchronous transport.write throw into markClosed', async () => {
    const transportIssues: string[] = [];
    const client = createJsonRpcClient({
      transport: {
        write: () => {
          throw new Error('EPIPE: broken pipe');
        },
        close: () => {},
        onData: () => {},
        onClose: () => {},
        onError: () => {},
      },
      requestTimeoutMs: 5000,
      onNotification: () => {},
      onTransportIssue: message => {
        transportIssues.push(message);
      },
    });

    await expect(client.request('initialize', {})).rejects.toThrow(
      'EPIPE: broken pipe'
    );
    expect(transportIssues).toEqual(['EPIPE: broken pipe']);

    // After markClosed, further requests fail with the closed error.
    await expect(client.request('initialize', {})).rejects.toThrow(
      'LSP transport is closed.'
    );
  });

  it('swallows notify-path write throws after routing to markClosed', () => {
    const transportIssues: string[] = [];
    const client = createJsonRpcClient({
      transport: {
        write: () => {
          throw new Error('write failed');
        },
        close: () => {},
        onData: () => {},
        onClose: () => {},
        onError: () => {},
      },
      requestTimeoutMs: 5000,
      onNotification: () => {},
      onTransportIssue: message => {
        transportIssues.push(message);
      },
    });

    expect(() => client.notify('exit', {})).not.toThrow();
    expect(transportIssues).toEqual(['write failed']);
  });
});

describe('unhandledRejection sweep (regression for the EPIPE agent crash)', () => {
  it('never leaves an unhandled rejection when a server dies mid-write', async () => {
    const unhandled: unknown[] = [];
    const handler = (error: unknown): void => {
      unhandled.push(error);
    };
    process.on('unhandledRejection', handler);
    const fake = await startFakeLspServer({ respondToInitialize: true });
    try {
      await fake.waitForReady();
      const transport = createChildTransport(fake.child);
      const client = createJsonRpcClient({
        transport,
        requestTimeoutMs: 5000,
        onNotification: () => {},
        onTransportIssue: () => {},
      });

      const requestPromises = [
        client.request('textDocument/hover', {}).catch(error => error),
        client.request('textDocument/references', {}).catch(error => error),
      ];
      fake.child.kill('SIGKILL');
      const settled = await Promise.all(requestPromises);
      expect(settled.every(result => result instanceof Error)).toBe(true);

      await new Promise(resolve => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', handler);
      await fake.stop();
    }
  });
});

describe('write-throw error propagation preserves Error type', () => {
  it('rejects with an Error instance, not a thrown non-Error', async () => {
    const client = createJsonRpcClient({
      transport: {
        write: () => {
          throw 'plain string throw';
        },
        close: () => {},
        onData: () => {},
        onClose: () => {},
        onError: () => {},
      },
      requestTimeoutMs: 5000,
      onNotification: () => {},
      onTransportIssue: () => {},
    });
    await expect(client.request('initialize', {})).rejects.toBeInstanceOf(
      Error
    );
  });
});

describe('vi integration sanity', () => {
  it('spies work with the transport issue callback', async () => {
    const onTransportIssue = vi.fn();
    const client = createJsonRpcClient({
      transport: {
        write: () => {
          throw new Error('boom');
        },
        close: () => {},
        onData: () => {},
        onClose: () => {},
        onError: () => {},
      },
      requestTimeoutMs: 5000,
      onNotification: () => {},
      onTransportIssue,
    });
    await expect(client.request('x', {})).rejects.toThrow('boom');
    expect(onTransportIssue).toHaveBeenCalledWith('boom');
  });
});
