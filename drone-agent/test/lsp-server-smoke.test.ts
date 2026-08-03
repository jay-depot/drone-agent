/**
 * LSP Server Smoke Tests (slow / integration)
 *
 * Downloads real LSP server tarballs, installs them (including npm
 * dependencies), spawns the server, sends an LSP `initialize` request,
 * and verifies the server responds without error.
 *
 * These tests require network access and (for npm-type servers) a working
 * `npm` on PATH. They are excluded from the default test run — run with:
 *
 *   RUN_LSP_SMOKE_TESTS=true npx vitest run -- drone-agent/test/lsp-server-smoke.test.ts
 *
 * or via the integration config:
 *
 *   RUN_INTEGRATION_TESTS=true pnpm test:integration
 */

import { describe, it, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ensureServerInstalled,
  type InstallerSpec,
} from '../src/plugins/lsp/installer.js';
import {
  createChildTransport,
  createJsonRpcClient,
  type JsonRpcClient,
} from '../src/plugins/lsp/transport.js';
import { KNOWN_SERVER_SPECS } from '../src/plugins/lsp/known-servers.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function silentLogger() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

function specFromKnown(id: string): InstallerSpec {
  const known = KNOWN_SERVER_SPECS.find(s => s.id === id);
  if (!known) throw new Error(`Unknown server: ${id}`);
  if (!known.install) throw new Error(`No install spec for ${id}`);
  return {
    id: known.id,
    command: known.command,
    args: known.args,
    install: known.install,
  };
}

async function initializeServer(
  spec: InstallerSpec,
  workspaceRoot: string
): Promise<{ child: ChildProcessWithoutNullStreams; client: JsonRpcClient }> {
  const resolution = await ensureServerInstalled(spec, {
    logger: silentLogger(),
  });

  const child = spawn(resolution.command, resolution.args, {
    // Native binaries like lua-language-server need to run from their
    // own directory to find support files.
    cwd: resolution.cacheDir ?? workspaceRoot,
    stdio: 'pipe',
    env: process.env,
  });

  const client = createJsonRpcClient({
    transport: createChildTransport(child),
    requestTimeoutMs: 15000,
    onNotification: () => {},
    onTransportIssue: () => {},
  });

  await client.request('initialize', {
    processId: process.pid,
    rootUri: `file://${workspaceRoot}`,
    capabilities: {
      textDocument: {
        publishDiagnostics: { relatedInformation: false },
        hover: { contentFormat: ['markdown', 'plaintext'] },
        textDocumentSync: {
          didSave: false,
          willSave: false,
          willSaveWaitUntil: false,
        },
      },
    },
    workspaceFolders: [
      { uri: `file://${workspaceRoot}`, name: 'test' },
    ],
  });

  client.notify('initialized', {});

  return { child, client };
}

async function shutdownServer(
  child: ChildProcessWithoutNullStreams,
  client: JsonRpcClient
): Promise<void> {
  try {
    await client.request('shutdown');
  } catch {
    // ignore
  }
  try {
    client.notify('exit');
  } catch {
    // ignore
  }
  client.disconnect('test teardown');
  child.kill();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const runSmoke =
  process.env.RUN_LSP_SMOKE_TESTS === 'true' ||
  process.env.RUN_INTEGRATION_TESTS === 'true';

const testIf = runSmoke ? it : it.skip;
const describeIf = runSmoke ? describe : describe.skip;

describeIf('LSP server smoke tests', () => {
  let workspaceRoot: string;

  beforeAll(async () => {
    workspaceRoot = await mkdtemp(path.join(tmpdir(), 'drone-lsp-smoke-'));
  });

  afterAll(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  // ── npm-based servers ──────────────────────────────────────────────

  testIf(
    'yaml-language-server: installs, starts, and responds to initialize',
    async () => {
      const spec = specFromKnown('yaml-language-server');
      const { child, client } = await initializeServer(spec, workspaceRoot);
      await shutdownServer(child, client);
    },
    120_000
  );

  testIf(
    'json-language-server: installs, starts, and responds to initialize',
    async () => {
      const spec = specFromKnown('json-language-server');
      const { child, client } = await initializeServer(spec, workspaceRoot);
      await shutdownServer(child, client);
    },
    120_000
  );

  testIf(
    'dockerfile-language-server: installs, starts, and responds to initialize',
    async () => {
      const spec = specFromKnown('dockerfile-language-server');
      const { child, client } = await initializeServer(spec, workspaceRoot);
      await shutdownServer(child, client);
    },
    120_000
  );

  testIf(
    'css-language-server: installs, starts, and responds to initialize',
    async () => {
      const spec = specFromKnown('css-language-server');
      const { child, client } = await initializeServer(spec, workspaceRoot);
      await shutdownServer(child, client);
    },
    120_000
  );

  testIf(
    'html-language-server: installs, starts, and responds to initialize',
    async () => {
      const spec = specFromKnown('html-language-server');
      const { child, client } = await initializeServer(spec, workspaceRoot);
      await shutdownServer(child, client);
    },
    120_000
  );

  testIf(
    'bash-language-server: installs, starts, and responds to initialize',
    async () => {
      const spec = specFromKnown('bash-language-server');
      const { child, client } = await initializeServer(spec, workspaceRoot);
      await shutdownServer(child, client);
    },
    120_000
  );

  testIf(
    'taplo: installs, starts, and responds to initialize',
    async () => {
      const spec = specFromKnown('taplo');
      const { child, client } = await initializeServer(spec, workspaceRoot);
      await shutdownServer(child, client);
    },
    120_000
  );

  // ── Binary (github-release) servers ────────────────────────────────

  testIf(
    'rust-analyzer: installs, starts, and responds to initialize',
    async () => {
      const spec = specFromKnown('rust-analyzer');
      const { child, client } = await initializeServer(spec, workspaceRoot);
      await shutdownServer(child, client);
    },
    120_000
  );

  testIf(
    'lua-language-server: installs, starts, and responds to initialize',
    async () => {
      const spec = specFromKnown('lua-language-server');
      const { child, client } = await initializeServer(spec, workspaceRoot);
      await shutdownServer(child, client);
    },
    120_000
  );
});
