import { readFile, access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { logger } from '../logger.js';
import { validateConversationId } from './files.js';
import type {
  GatewayConfig,
  ResolvedServiceAdapter,
  ResolvedConversation,
  ControlSurfaceSpec,
  ControlApiConfig,
} from '../types.js';
import {
  SPAWNING_SURFACES,
  SURFACES_REQUIRING_COORDINATOR,
  resolveSurfaceSpawnMode,
} from '../surfaces/requirements.js';

const MAX_WORKING_DIR_LENGTH = 4096;

/**
 * Sanitize a surface `workingDir`: expand `~`/`~/` via the home directory,
 * require an absolute result within the length cap. Anything invalid is
 * warned about and dropped so the surface falls back to the mode default.
 */
function sanitizeWorkingDir(
  value: unknown,
  log: (msg: string) => void
): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') {
    log('workingDir is not a non-empty string; ignoring');
    return undefined;
  }
  let expanded = value;
  if (expanded === '~') {
    expanded = os.homedir();
  } else if (expanded.startsWith('~/')) {
    expanded = path.join(os.homedir(), expanded.slice(2));
  }
  if (!path.isAbsolute(expanded)) {
    log('workingDir must be an absolute path; ignoring');
    return undefined;
  }
  if (expanded.length > MAX_WORKING_DIR_LENGTH) {
    log(`workingDir exceeds ${MAX_WORKING_DIR_LENGTH} chars; ignoring`);
    return undefined;
  }
  return path.normalize(expanded);
}

/**
 * Sanitize a non-negative number (a timeout or debounce in ms). `0` is valid
 * and disables the feature. Anything else is warned about and dropped.
 */
function sanitizeNonNegativeNumber(
  value: unknown,
  label: string,
  log: (msg: string) => void
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    log(`${label} must be a non-negative number; ignoring`);
    return undefined;
  }
  return value;
}

/**
 * Sanitize a control surface's `config` bag. `targetBeaconId` is only
 * meaningful on a spawning surface and, when present there, must be a
 * non-empty string (a hard error otherwise — it selects the spawn mode).
 * On a non-spawning surface it is warned about and dropped. `workingDir`
 * must be an absolute path; `lifecycle.idleTimeoutMs` and `batch.debounceMs`
 * must be non-negative numbers. Invalid values for those are warned about
 * and dropped.
 */
function sanitizeSurfaceConfig(
  type: string,
  config: Record<string, unknown> | undefined,
  adapterId: string,
  file: string,
  convId: string
): Record<string, unknown> | undefined {
  if (!config) return config;

  const warn = (msg: string) =>
    logger.warn(
      { adapterId, file, convId },
      `Control surface ${msg} in "${file}"`
    );

  const rest: Record<string, unknown> = { ...config };

  const override = rest.targetBeaconId;
  if (override !== undefined) {
    if (!SPAWNING_SURFACES.has(type)) {
      warn(`type "${type}" does not spawn agents; ignoring its targetBeaconId`);
      delete rest.targetBeaconId;
    } else if (typeof override !== 'string' || override.trim() === '') {
      throw new Error(
        `Control surface type "${type}" in "${file}" (conversation ` +
          `"${convId}", adapter "${adapterId}") has an invalid targetBeaconId ` +
          `(expected a non-empty string).`
      );
    }
  }

  const workingDir = rest.workingDir;
  if (workingDir !== undefined) {
    const sanitized = sanitizeWorkingDir(workingDir, warn);
    if (sanitized === undefined) delete rest.workingDir;
    else rest.workingDir = sanitized;
  }

  const lifecycle = rest.lifecycle;
  if (lifecycle !== undefined) {
    if (
      typeof lifecycle !== 'object' ||
      lifecycle === null ||
      Array.isArray(lifecycle)
    ) {
      warn('lifecycle is not an object; ignoring');
      delete rest.lifecycle;
    } else {
      const bag = { ...(lifecycle as Record<string, unknown>) };
      if (bag.idleTimeoutMs !== undefined) {
        const sanitized = sanitizeNonNegativeNumber(
          bag.idleTimeoutMs,
          'idleTimeoutMs',
          warn
        );
        if (sanitized === undefined) delete bag.idleTimeoutMs;
        else bag.idleTimeoutMs = sanitized;
      }
      rest.lifecycle = bag;
    }
  }

  const batch = rest.batch;
  if (batch !== undefined) {
    if (typeof batch !== 'object' || batch === null || Array.isArray(batch)) {
      warn('batch is not an object; ignoring');
      delete rest.batch;
    } else {
      const bag = { ...(batch as Record<string, unknown>) };
      if (bag.debounceMs !== undefined) {
        const sanitized = sanitizeNonNegativeNumber(
          bag.debounceMs,
          'debounceMs',
          warn
        );
        if (sanitized === undefined) delete bag.debounceMs;
        else bag.debounceMs = sanitized;
      }
      rest.batch = bag;
    }
  }

  return rest;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/**
 * Parse the optional `controlApi` block. Disabled unless explicitly enabled;
 * a non-loopback host while enabled is warned about (the API is otherwise
 * unauthenticated and should carry a token).
 */
function parseControlApi(
  raw: unknown,
  warn: (msg: string) => void
): ControlApiConfig {
  const defaults: ControlApiConfig = {
    enabled: false,
    host: '127.0.0.1',
    port: 8090,
  };
  if (raw === undefined) return defaults;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    warn('controlApi is not an object; ignoring');
    return defaults;
  }
  const bag = raw as Record<string, unknown>;

  let enabled = defaults.enabled;
  if (bag.enabled !== undefined) {
    if (typeof bag.enabled !== 'boolean') {
      warn('controlApi.enabled must be a boolean; ignoring');
    } else {
      enabled = bag.enabled;
    }
  }

  let host = defaults.host;
  if (bag.host !== undefined) {
    if (typeof bag.host !== 'string' || bag.host.trim() === '') {
      warn('controlApi.host must be a non-empty string; using default');
    } else {
      host = bag.host;
    }
  }
  if (enabled && !LOOPBACK_HOSTS.has(host)) {
    warn(
      `controlApi.host "${host}" is not loopback; configure controlApi.token — ` +
        `the API is otherwise unauthenticated`
    );
  }

  let port = defaults.port;
  if (bag.port !== undefined) {
    if (
      typeof bag.port !== 'number' ||
      !Number.isInteger(bag.port) ||
      bag.port < 1 ||
      bag.port > 65535
    ) {
      warn('controlApi.port must be an integer in 1–65535; using default');
    } else {
      port = bag.port;
    }
  }

  let token: string | undefined;
  if (bag.token !== undefined) {
    if (typeof bag.token !== 'string' || bag.token.trim() === '') {
      warn('controlApi.token must be a non-empty string; ignoring');
    } else {
      token = bag.token;
    }
  }

  return { enabled, host, port, token };
}

/**
 * Load and validate the full gateway configuration from a folder hierarchy.
 *
 * Layout:
 *   <configDir>/
 *     config.json              # gateway-level settings
 *     adapters/
 *       <adapterId>/
 *         adapter.json         # adapter settings + conversations inline (legacy)
 *         conversations/
 *           <convId>.json      # one file per conversation
 *           _default_.json     # wildcard catch-all (convId = "*")
 *
 * The `configPath` argument points to the gateway config.json file.
 * The adapters/ directory is expected alongside it.
 */
export async function loadGatewayConfig(
  configPath: string
): Promise<GatewayConfig> {
  const configDir = path.dirname(configPath);

  try {
    await access(configPath, fsConstants.F_OK);
  } catch {
    logger.error(`Config file not found: ${configPath}`);
    throw new Error(
      `Config file not found: ${configPath}\n` +
        `Create a config file at this path or use --config to specify one.\n` +
        `See the drone-gateway documentation for config format.`
    );
  }

  // Read gateway-level config
  const raw = await readFile(configPath, 'utf-8');
  let gatewayConfig: Record<string, unknown>;
  try {
    gatewayConfig = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in config file: ${err}`, { cause: err });
  }

  // The spawn backend is now chosen per control surface (inferred from a
  // surface's config.targetBeaconId). These gateway-wide keys are removed.
  for (const removed of ['spawnBackend', 'targetBeaconId'] as const) {
    if (gatewayConfig[removed] !== undefined) {
      throw new Error(
        `Removed config field "${removed}": the spawn backend is now chosen ` +
          `per control surface. A spawning surface that sets ` +
          `controlSurfaces[].config.targetBeaconId spawns via the coordinator; ` +
          `any other spawning surface spawns locally. Delete "${removed}" from config.json.`
      );
    }
  }

  // coordinatorUrl is optional at this point; it becomes required if any
  // loaded surface needs the coordinator (enforced after adapters load).
  const coordinatorUrl = gatewayConfig.coordinatorUrl as string | undefined;
  if (coordinatorUrl !== undefined && typeof coordinatorUrl !== 'string') {
    throw new Error('Config field coordinatorUrl must be a string.');
  }

  // Validate the gateway-wide default idle timeout (inert in local mode).
  const idleTimeoutMs = sanitizeNonNegativeNumber(
    gatewayConfig.idleTimeoutMs,
    'idleTimeoutMs',
    msg => logger.warn(`Config field ${msg}.`)
  );

  // Validate the gateway-wide default batch debounce (ms).
  const rawBatch = gatewayConfig.batch as { debounceMs?: unknown } | undefined;
  const batchDebounceMs = sanitizeNonNegativeNumber(
    rawBatch?.debounceMs,
    'batch.debounceMs',
    msg => logger.warn(`Config field ${msg}.`)
  );

  // Build the base config
  const config: GatewayConfig = {
    coordinatorUrl: coordinatorUrl ?? '',
    coordinatorToken: gatewayConfig.coordinatorToken as string | undefined,
    idleTimeoutMs,
    batch:
      batchDebounceMs !== undefined
        ? { debounceMs: batchDebounceMs }
        : undefined,
    agentPath: gatewayConfig.agentPath as string | undefined,
    controlApi: parseControlApi(gatewayConfig.controlApi, msg =>
      logger.warn(`Config field ${msg}.`)
    ),
    serviceAdapters: [],
  };

  // Load adapters from the adapters/ directory
  const adaptersDir = path.join(configDir, 'adapters');
  try {
    await access(adaptersDir, fsConstants.F_OK);
  } catch {
    logger.warn(`No adapters/ directory found at ${adaptersDir}`);
    return config;
  }

  const adapterDirs = await readdir(adaptersDir, { withFileTypes: true });
  const adapterIds = adapterDirs
    .filter(dirent => dirent.isDirectory())
    .map(dirent => dirent.name);

  for (const adapterId of adapterIds) {
    const adapter = await loadAdapter(adaptersDir, adapterId);
    if (adapter) {
      config.serviceAdapters.push(adapter);
    }
  }

  // coordinatorUrl is required when any loaded surface needs the coordinator:
  // a coordinator-mode spawner (config.targetBeaconId present) or a surface in
  // SURFACES_REQUIRING_COORDINATOR. An unused coordinatorUrl is accepted.
  if (!coordinatorUrl && anySurfaceNeedsCoordinator(config.serviceAdapters)) {
    throw new Error(
      'Config missing required field: coordinatorUrl. At least one control ' +
        'surface requires the coordinator (a coordinator-mode spawner or a ' +
        'swarm-console surface).'
    );
  }

  return config;
}

/**
 * True when any loaded surface needs a coordinator connection: a
 * coordinator-mode spawner (inferred from `config.targetBeaconId`) or a
 * surface type in SURFACES_REQUIRING_COORDINATOR.
 */
function anySurfaceNeedsCoordinator(
  adapters: ResolvedServiceAdapter[]
): boolean {
  for (const adapter of adapters) {
    for (const conv of adapter.conversations.values()) {
      for (const spec of conv.surfaces) {
        if (SURFACES_REQUIRING_COORDINATOR.has(spec.type)) return true;
        if (resolveSurfaceSpawnMode(spec) === 'coordinator') return true;
      }
    }
  }
  return false;
}

async function loadAdapter(
  adaptersDir: string,
  adapterId: string
): Promise<ResolvedServiceAdapter | null> {
  const adapterDir = path.join(adaptersDir, adapterId);
  const adapterJsonPath = path.join(adapterDir, 'adapter.json');

  try {
    await access(adapterJsonPath, fsConstants.F_OK);
  } catch {
    logger.warn(`Skipping adapter "${adapterId}": no adapter.json found`);
    return null;
  }

  let adapterData: Record<string, unknown>;
  try {
    const raw = await readFile(adapterJsonPath, 'utf-8');
    adapterData = JSON.parse(raw);
  } catch (err) {
    logger.error(
      { adapterId, err },
      `Failed to parse adapter.json for "${adapterId}"`
    );
    return null;
  }

  const type = adapterData.type as string | undefined;
  if (!type || typeof type !== 'string') {
    logger.error(
      { adapterId },
      `Adapter "${adapterId}" missing required field: type`
    );
    return null;
  }

  // Build config (everything except id and type)
  const { type: _type, ...restConfig } = adapterData;

  // Load conversations
  const conversations = new Map<string, ResolvedConversation>();
  const convDir = path.join(adapterDir, 'conversations');

  try {
    await access(convDir, fsConstants.F_OK);
  } catch {
    return {
      id: adapterId,
      type,
      config: restConfig as Record<string, unknown>,
      conversations,
    };
  }

  const convFiles = await readdir(convDir);
  for (const file of convFiles) {
    if (!file.endsWith('.json')) continue;

    const filePath = path.join(convDir, file);
    let convData: Record<string, unknown>;
    try {
      const raw = await readFile(filePath, 'utf-8');
      convData = JSON.parse(raw);
    } catch (err) {
      logger.warn(
        { adapterId, file, err },
        `Failed to parse conversation file "${file}"`
      );
      continue;
    }

    // Read canonical conversationId from the file (not the filename)
    const convId = convData.conversationId as string | undefined;
    if (!convId || typeof convId !== 'string') {
      logger.warn(
        { adapterId, file },
        `Conversation file "${file}" missing or invalid conversationId field`
      );
      continue;
    }

    // Validate
    const validationError = validateConversationId(convId);
    if (validationError) {
      logger.warn(
        { adapterId, file, convId, validationError },
        `Invalid conversationId in "${file}"`
      );
      continue;
    }

    // Read control surfaces
    const rawSurfaces = convData.controlSurfaces;
    if (rawSurfaces !== undefined && !Array.isArray(rawSurfaces)) {
      logger.warn(
        { adapterId, file, convId },
        `Conversation "${convId}" controlSurfaces is not an array; ignoring it`
      );
    }
    const surfaceEntries = Array.isArray(rawSurfaces) ? rawSurfaces : [];

    const specs: ControlSurfaceSpec[] = [];
    for (const raw of surfaceEntries) {
      const spec = raw as Record<string, unknown>;
      if (!spec.type || typeof spec.type !== 'string') {
        logger.warn(
          { adapterId, file, convId },
          `Control surface in "${file}" missing type field`
        );
        continue;
      }
      specs.push({
        type: spec.type as string,
        personaId: spec.personaId as string | undefined,
        config: sanitizeSurfaceConfig(
          spec.type as string,
          spec.config as Record<string, unknown> | undefined,
          adapterId,
          file,
          convId
        ),
      });
    }

    const injectionEnabled = parseInjection(convData, adapterId, file, convId);

    if (specs.length === 0 && !injectionEnabled) {
      logger.warn(
        { adapterId, file, convId },
        `Conversation "${convId}" has no controlSurfaces and no injection opt-in; skipping`
      );
      continue;
    }

    conversations.set(convId, {
      allowedSenders: parseAllowedSenders(convData, adapterId, file),
      surfaces: specs,
      injectionEnabled,
    });
  }

  return {
    id: adapterId,
    type,
    config: restConfig as Record<string, unknown>,
    conversations,
  };
}

/**
 * Reads the optional `allowedSenders` field from a conversation file. It must
 * be an array of strings; anything else is warned about and ignored (so the
 * conversation falls back to allowing every sender).
 */
function parseAllowedSenders(
  convData: Record<string, unknown>,
  adapterId: string,
  file: string
): string[] | undefined {
  const raw = convData.allowedSenders;
  if (raw === undefined) return undefined;
  if (
    !Array.isArray(raw) ||
    !raw.every(entry => typeof entry === 'string') ||
    raw.length === 0
  ) {
    logger.warn(
      { adapterId, file },
      `Conversation file "${file}" has an invalid allowedSenders field (expected a non-empty array of strings); ignoring it`
    );
    return undefined;
  }
  return raw as string[];
}

/**
 * Reads the optional `injection.enabled` opt-in from a conversation file. It
 * must be a boolean `true`; anything else is warned about and ignored. The
 * wildcard conversation is never an injection target.
 */
function parseInjection(
  convData: Record<string, unknown>,
  adapterId: string,
  file: string,
  convId: string
): boolean {
  const raw = convData.injection;
  if (raw === undefined) return false;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    logger.warn(
      { adapterId, file, convId },
      'injection is not an object; ignoring'
    );
    return false;
  }
  const enabled = (raw as Record<string, unknown>).enabled;
  if (enabled === undefined) return false;
  if (typeof enabled !== 'boolean') {
    logger.warn(
      { adapterId, file, convId },
      'injection.enabled must be a boolean; ignoring'
    );
    return false;
  }
  if (!enabled) return false;
  if (convId === '*') {
    logger.warn(
      { adapterId, file, convId },
      'injection.enabled is not allowed on the wildcard conversation; ignoring'
    );
    return false;
  }
  return true;
}
