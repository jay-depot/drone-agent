import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isNoResponse } from '../chat-format.js';
import { unescapePrefix, applyPrefix } from './prefix.js';
import {
  ControlApiClient,
  GatewayHttpError,
  GatewayUnreachableError,
} from './client.js';
import {
  spawnOnce,
  SpawnOnceFailureError,
  SpawnOnceTimeoutError,
} from './spawn-once.js';
import {
  parseInjectArgs,
  usageText,
  type InjectInvocation,
  type InjectCommonOptions,
} from './args.js';

const DEFAULT_CONFIG_PATH = path.join(
  os.homedir(),
  '.drone-gateway',
  'config.json'
);

interface ResolvedTarget {
  host: string;
  port: number;
  token?: string;
}

/**
 * Resolve the control API target: explicit flags win, then environment, then
 * the gateway config file's `controlApi` block, then built-in defaults.
 */
export async function resolveControlApi(
  opts: InjectCommonOptions
): Promise<ResolvedTarget> {
  const fileCfg: Partial<ResolvedTarget> = {};
  const configPath = opts.configPath ?? DEFAULT_CONFIG_PATH;
  try {
    const raw = JSON.parse(await readFile(configPath, 'utf-8')) as {
      controlApi?: Record<string, unknown>;
    };
    const ca = raw.controlApi ?? {};
    if (typeof ca.host === 'string') fileCfg.host = ca.host;
    if (typeof ca.port === 'number') fileCfg.port = ca.port;
    if (typeof ca.token === 'string') fileCfg.token = ca.token;
  } catch {
    // No config file → defaults plus flag/env overrides.
  }

  return {
    host: opts.host ?? fileCfg.host ?? '127.0.0.1',
    port: opts.port ?? fileCfg.port ?? 8090,
    token: opts.token ?? process.env.DRONE_GATEWAY_TOKEN ?? fileCfg.token,
  };
}

async function readText(source: {
  positional?: string;
  file?: string;
}): Promise<string> {
  if (source.positional !== undefined) return source.positional;
  if (source.file === '-') return readStdin();
  return readFile(source.file as string, 'utf-8');
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', c => (data += c));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function emitJson(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

export async function runInjectCli(argv: string[]): Promise<void> {
  let invocation: InjectInvocation;
  try {
    invocation = parseInjectArgs(argv);
  } catch (err) {
    process.stderr.write(
      `${err instanceof Error ? err.message : String(err)}\n`
    );
    process.exitCode = 1;
    return;
  }
  if (invocation.kind === 'help') {
    process.stdout.write(usageText() + '\n');
    return;
  }
  const target = await resolveControlApi(invocation.options);
  const client = new ControlApiClient(target);
  try {
    if (invocation.kind === 'inject-message') {
      await runInjectMessage(invocation, client);
    } else {
      await runRunAgent(invocation, client);
    }
  } catch (err) {
    if (err instanceof GatewayUnreachableError) {
      process.stderr.write(`${err.message}\n`);
    } else if (err instanceof GatewayHttpError) {
      process.stderr.write(
        `Gateway rejected the injection (${err.status}): ${err.message}\n`
      );
    } else if (
      err instanceof SpawnOnceTimeoutError ||
      err instanceof SpawnOnceFailureError
    ) {
      process.stderr.write(`${err.message}\n`);
    } else {
      process.stderr.write(
        `${err instanceof Error ? err.message : String(err)}\n`
      );
    }
    process.exitCode = 1;
  }
}

async function runInjectMessage(
  inv: Extract<InjectInvocation, { kind: 'inject-message' }>,
  client: ControlApiClient
): Promise<void> {
  const raw = await readText({ positional: inv.text, file: inv.file });
  const text = applyPrefix(unescapePrefix(inv.options.prefix ?? ''), raw);
  await client.inject(inv.options.adapterId, inv.options.conversationId, text);
  if (inv.options.json) {
    emitJson({
      ok: true,
      injected: true,
      adapterId: inv.options.adapterId,
      conversationId: inv.options.conversationId,
      text,
    });
  } else {
    process.stdout.write(`${text}\n`);
  }
}

async function runRunAgent(
  inv: Extract<InjectInvocation, { kind: 'run-agent' }>,
  client: ControlApiClient
): Promise<void> {
  const task = await readText({ positional: inv.task, file: inv.taskFile });
  const finalMessage = await spawnOnce({
    task,
    personaId: inv.persona,
    workingDir: inv.workingDir,
    model: inv.model,
    agentPath: inv.agentPath,
    timeoutMs: inv.timeoutSeconds * 1000,
  });

  if (inv.noResponseSentinel && isNoResponse(finalMessage)) {
    process.stderr.write(
      'agent declined to respond (<<NO_RESPONSE>>); nothing injected\n'
    );
    if (inv.options.json)
      emitJson({ ok: true, injected: false, suppressed: true });
    return;
  }

  if (finalMessage.trim() === '') {
    process.stderr.write('agent produced no final message; nothing injected\n');
    if (inv.options.json)
      emitJson({ ok: true, injected: false, suppressed: false });
    return;
  }

  const text = applyPrefix(
    unescapePrefix(inv.options.prefix ?? ''),
    finalMessage
  );
  await client.inject(inv.options.adapterId, inv.options.conversationId, text);
  if (inv.options.json) {
    emitJson({
      ok: true,
      injected: true,
      adapterId: inv.options.adapterId,
      conversationId: inv.options.conversationId,
      result: text,
    });
  } else {
    process.stdout.write(`${text}\n`);
  }
}
