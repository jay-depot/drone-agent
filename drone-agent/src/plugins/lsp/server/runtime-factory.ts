import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import type { DroneLspServerConfig, DroneLspServerState } from 'drone-core';
import {
  createChildTransport,
  createJsonRpcClient,
  createSocketTransport,
} from '../transport.js';
import { formatServerDetail, getKnownServerSpec } from '../known-servers.js';
import { connectTcpServer } from './helpers.js';
import { normalizeFileExtensions } from '../normalize/index.js';
import type { ServerRuntime } from './types.js';
import type { ResolvedSpawn } from './spawn-resolution.js';

export type RuntimeFactoryHooks = {
  workspaceRoot: string;
  requestTimeoutMs: number;
  /** Seed (or fetch) the state record for a server id. */
  ensureServerState: (serverId: string, seed: DroneLspServerState) => void;
  updateServerState: (
    serverId: string,
    update: Partial<DroneLspServerState>
  ) => void;
  onPublishDiagnostics: (params: unknown) => void;
  /** Live-runtime lookup for spawned transport issue routing. */
  getLiveRuntime: (serverId: string) => ServerRuntime | undefined;
  /** Failure path for a spawned server's transport issue. */
  handleSpawnedTransportIssue: (
    runtime: ServerRuntime,
    message: string
  ) => void;
};

export async function initializeClient(
  runtime: ServerRuntime,
  hooks: RuntimeFactoryHooks
): Promise<void> {
  hooks.updateServerState(runtime.id, {
    status: 'connecting',
    detail: runtime.detail,
    lastError: undefined,
  });

  await runtime.client.request('initialize', {
    processId: process.pid,
    rootUri: pathToFileURL(hooks.workspaceRoot).href,
    capabilities: {
      textDocument: {
        publishDiagnostics: {
          relatedInformation: false,
        },
        hover: {
          contentFormat: ['markdown', 'plaintext'],
        },
        textDocumentSync: {
          didSave: false,
          willSave: false,
          willSaveWaitUntil: false,
        },
      },
    },
    workspaceFolders: [
      {
        uri: pathToFileURL(hooks.workspaceRoot).href,
        name: path.basename(hooks.workspaceRoot),
      },
    ],
  });
  runtime.client.notify('initialized', {});
  hooks.updateServerState(runtime.id, {
    status: 'connected',
    detail: runtime.detail,
    lastError: undefined,
  });
}

export async function createRuntimeFromConfig(
  serverId: string,
  language: string,
  config: DroneLspServerConfig,
  resolved: ResolvedSpawn | null,
  hooks: RuntimeFactoryHooks
): Promise<ServerRuntime> {
  const knownSpec = getKnownServerSpec(language);
  const fileExtensions = normalizeFileExtensions(
    config.fileExtensions ?? knownSpec?.fileExtensions ?? []
  );
  const detail = formatServerDetail(config);
  hooks.ensureServerState(serverId, {
    id: serverId,
    language,
    transport: config.transport === 'tcp' ? 'tcp' : 'stdio',
    ownership: config.transport === 'tcp' ? 'external' : 'spawned',
    status: 'connecting',
    detail,
  });

  if (config.transport === 'tcp') {
    const socket = await connectTcpServer(config, hooks.requestTimeoutMs);
    const client = createJsonRpcClient({
      transport: createSocketTransport(socket),
      requestTimeoutMs: hooks.requestTimeoutMs,
      onNotification: (method, params) => {
        if (method === 'textDocument/publishDiagnostics') {
          hooks.onPublishDiagnostics(params);
        }
      },
      onTransportIssue: message => {
        hooks.updateServerState(serverId, {
          status: 'error',
          lastError: message,
        });
      },
    });

    return {
      id: serverId,
      language,
      transport: 'tcp',
      ownership: 'external',
      detail,
      fileExtensions,
      client,
      documents: new Map(),
      socket,
    };
  }

  if (!resolved) {
    throw new Error(
      `No executable command resolved for ${serverId} (command: ${config.command}).`
    );
  }

  const childProcess = spawn(resolved.command, resolved.args, {
    // Native binaries (e.g., lua-language-server) need to run from
    // their own directory to find support files. Use cacheDir when
    // available, falling back to workspaceRoot for PATH-based servers.
    cwd: resolved.cacheDir ?? hooks.workspaceRoot,
    env: process.env,
    stdio: 'pipe',
  });
  const childTransport = createChildTransport(childProcess);
  const client = createJsonRpcClient({
    transport: childTransport,
    requestTimeoutMs: hooks.requestTimeoutMs,
    onNotification: (method, params) => {
      if (method === 'textDocument/publishDiagnostics') {
        hooks.onPublishDiagnostics(params);
      }
    },
    onTransportIssue: message => {
      const runtime = hooks.getLiveRuntime(serverId);
      if (runtime) {
        hooks.handleSpawnedTransportIssue(runtime, message);
      } else {
        hooks.updateServerState(serverId, {
          status: 'error',
          lastError: message,
        });
      }
    },
  });

  return {
    id: serverId,
    language,
    transport: 'stdio',
    ownership: 'spawned',
    detail,
    fileExtensions,
    client,
    documents: new Map(),
    childProcess,
    childTransport,
  };
}
