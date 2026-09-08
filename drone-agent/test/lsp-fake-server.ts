/**
 * Tiny in-process LSP test server harness. Spawns a Node subprocess that
 * reads framed JSON-RPC messages from stdin, dispatches to a scenario file,
 * and writes responses to stdout.
 *
 * Usage:
 *   const server = await startFakeLspServer({ exitAfterInitialize: true });
 *   server.child; // ChildProcess to feed to createChildTransport
 *   await server.waitForReady();
 *   await server.stop();
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SERVER_SCRIPT = path.join(__dirname, 'lsp-fake-server.mjs');

export type FakeLspScenario = {
  respondToInitialize?: boolean;
  exitAfterInitialize?: boolean;
  exitOnMethod?: string;
  hangOnMethod?: string;
  results?: Record<string, unknown>;
};

export type FakeLspServer = {
  child: ChildProcessWithoutNullStreams;
  scenarioDir: string;
  waitForReady: () => Promise<void>;
  stop: () => Promise<void>;
};

export async function startFakeLspServer(
  scenario: FakeLspScenario = {}
): Promise<FakeLspServer> {
  const scenarioDir = await mkdtemp(path.join(tmpdir(), 'drone-lsp-fake-'));
  const scenarioPath = path.join(scenarioDir, 'scenario.json');
  await writeFile(scenarioPath, JSON.stringify(scenario), 'utf8');

  const child = spawn(process.execPath, [SERVER_SCRIPT, scenarioPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  }) as ChildProcessWithoutNullStreams;

  let readyResolve: (() => void) | undefined;
  const readyPromise = new Promise<void>(resolve => {
    readyResolve = resolve;
  });

  // READY arrives on stderr so the JSON-RPC stdout stream stays clean.
  child.stderr.on('data', chunk => {
    if (readyResolve && chunk.includes(Buffer.from('READY\n'))) {
      readyResolve();
      readyResolve = undefined;
    }
  });

  child.stderr.on('data', chunk => {
    process.stderr.write(`[fake-lsp-server] ${chunk.toString('utf8')}`);
  });

  return {
    child,
    scenarioDir,
    waitForReady: () => readyPromise,
    stop: async () => {
      try {
        child.stdin.end();
        child.kill();
      } catch {
        // Already dead.
      }
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => resolve(), 200);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
      await rm(scenarioDir, { recursive: true, force: true });
    },
  };
}

/** Helpers used by the fake server's child script. Don't call from tests. */
export const __internal = {
  SERVER_SCRIPT,
};
