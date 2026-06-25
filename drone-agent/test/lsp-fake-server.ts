/**
 * Tiny in-process LSP test server. Spawns a Node subprocess that reads
 * framed JSON-RPC messages from stdin, dispatches to a route table, and
 * writes responses to stdout. Tests can swap the response per-method,
 * track incoming requests, and assert on the wire format the LSP plugin
 * produces.
 *
 * Usage:
 *   const server = await startFakeLspServer();
 *   server.onRequest('textDocument/hover', () => ({ contents: 'hi' }));
 *   await server.notifyInitialized();
 *   const response = await server.lastRequestBody('textDocument/hover');
 *   await server.stop();
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type Handler = (params: unknown) => unknown;

const SERVER_SCRIPT = path.join(__dirname, 'lsp-fake-server.mjs');

export type FakeLspServer = {
  child: ChildProcessWithoutNullStreams;
  /** Register or replace a handler for a JSON-RPC method. */
  onRequest: (method: string, handler: Handler | object) => void;
  /** Remove a handler; subsequent calls receive an empty result. */
  offRequest: (method: string) => void;
  /** Get the most recent request body (params + id + method) for a method. */
  lastRequestBody: (method: string) => unknown | undefined;
  /** Wait for the server to log that it received an `initialized` notification. */
  waitForInitialized: () => Promise<void>;
  /** Stop the server and close the pipes. */
  stop: () => Promise<void>;
  /** Direct access for low-level assertions (e.g. raw frame inspection). */
  rawStdout: () => Buffer;
};

export async function startFakeLspServer(): Promise<FakeLspServer> {
  const child = spawn(process.execPath, [SERVER_SCRIPT], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });

  let resolveInitialized: (() => void) | undefined;
  const initializedPromise = new Promise<void>(resolve => {
    resolveInitialized = resolve;
  });

  const handlers = new Map<string, Handler>();
  const lastBodies = new Map<string, unknown>();
  let stdoutBuffer = Buffer.alloc(0);

  child.stdout.on('data', chunk => {
    stdoutBuffer = Buffer.concat([stdoutBuffer, chunk]);
    // Detect the "READY\n" prelude the script emits after parsing stdin
    // is set up.
    if (resolveInitialized && stdoutBuffer.includes(Buffer.from('READY\n'))) {
      resolveInitialized();
      resolveInitialized = undefined;
    }
  });

  child.on('error', () => {
    // Surface errors to callers; the most common failure is the script
    // path being wrong. Tests should call `.stop()` and check the
    // recorded frames.
  });

  // Forward the script's stderr so test failures aren't silent.
  child.stderr.on('data', chunk => {
    process.stderr.write(`[fake-lsp-server] ${chunk.toString('utf8')}`);
  });

  await initializedPromise;

  return {
    child,
    onRequest: (method, handler) => {
      const wrapped: Handler =
        typeof handler === 'function' ? (handler as Handler) : () => handler;
      handlers.set(method, wrapped);
    },
    offRequest: method => {
      handlers.delete(method);
    },
    lastRequestBody: method => lastBodies.get(method),
    waitForInitialized: () => initializedPromise,
    rawStdout: () => stdoutBuffer,
    stop: async () => {
      handlers.clear();
      lastBodies.clear();
      try {
        child.stdin.end();
        child.kill();
      } catch {
        // ignore
      }
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => resolve(), 200);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}

/**
 * Helpers used by the fake server's child script. Don't call from tests.
 */
export const __internal = {
  SERVER_SCRIPT,
};
