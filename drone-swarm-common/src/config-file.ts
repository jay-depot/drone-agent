import fs from 'node:fs/promises';

/**
 * Session-end trigger fired when a swarm session transitions to ended at the
 * beacon (proxy route) or coordinator. Strictly one of two variants.
 */
export type SessionEndTrigger =
  | { type: 'command'; command: string }
  | { type: 'spawn'; persona: string; beaconId?: string };

/**
 * Shape of a JSON config file accepted by drone-beacon and drone-coordinator
 * via `--config-file`. Keys are optional so partial files merge over defaults;
 * unknown top-level keys are rejected to catch typos early.
 */
export interface ServerConfigFile {
  port?: number;
  host?: string;
  webPort?: number;
  webHost?: string;
  dbPath?: string;
  useHttps?: boolean;
  sessionEnd?: SessionEndTrigger;
  [key: string]: unknown;
}

const ALLOWED_KEYS: ReadonlySet<string> = new Set([
  'port',
  'host',
  'webPort',
  'webHost',
  'dbPath',
  'useHttps',
  'sessionEnd',
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateSessionEnd(
  sessionEnd: unknown,
  errors: string[]
): SessionEndTrigger | undefined {
  if (!isPlainObject(sessionEnd)) {
    errors.push('"sessionEnd" must be an object');
    return undefined;
  }
  const type = sessionEnd.type;
  if (type === 'command') {
    if (typeof sessionEnd.command !== 'string' || !sessionEnd.command.trim()) {
      errors.push('"sessionEnd.command" must be a non-empty string');
    }
    for (const key of Object.keys(sessionEnd)) {
      if (key !== 'type' && key !== 'command') {
        errors.push(`unknown key "sessionEnd.${key}" for type "command"`);
      }
    }
    return { type: 'command', command: sessionEnd.command as string };
  }
  if (type === 'spawn') {
    if (typeof sessionEnd.persona !== 'string' || !sessionEnd.persona.trim()) {
      errors.push('"sessionEnd.persona" must be a non-empty string');
    }
    if (
      sessionEnd.beaconId !== undefined &&
      typeof sessionEnd.beaconId !== 'string'
    ) {
      errors.push('"sessionEnd.beaconId" must be a string');
    }
    for (const key of Object.keys(sessionEnd)) {
      if (key !== 'type' && key !== 'persona' && key !== 'beaconId') {
        errors.push(`unknown key "sessionEnd.${key}" for type "spawn"`);
      }
    }
    return {
      type: 'spawn',
      persona: sessionEnd.persona as string,
      ...(sessionEnd.beaconId !== undefined
        ? { beaconId: sessionEnd.beaconId as string }
        : {}),
    };
  }
  errors.push('"sessionEnd.type" must be "command" or "spawn"');
  return undefined;
}

/**
 * Validate a parsed config file object, returning a list of error strings
 * (empty when valid).
 */
export function validateConfigFile(value: unknown): string[] {
  if (!isPlainObject(value)) {
    return ['config file must be a JSON object'];
  }
  const errors: string[] = [];
  for (const key of Object.keys(value)) {
    if (!ALLOWED_KEYS.has(key)) {
      errors.push(`unknown key "${key}"`);
    }
  }
  for (const key of ['port', 'webPort'] as const) {
    if (
      value[key] !== undefined &&
      (typeof value[key] !== 'number' || !Number.isFinite(value[key]))
    ) {
      errors.push(`"${key}" must be a finite number`);
    }
  }
  for (const key of ['host', 'webHost', 'dbPath'] as const) {
    if (value[key] !== undefined && typeof value[key] !== 'string') {
      errors.push(`"${key}" must be a string`);
    }
  }
  if (value.useHttps !== undefined && typeof value.useHttps !== 'boolean') {
    errors.push('"useHttps" must be a boolean');
  }
  if (value.sessionEnd !== undefined) {
    validateSessionEnd(value.sessionEnd, errors);
  }
  return errors;
}

/**
 * Load and parse a JSON config file. Throws with a clear, path-prefixed
 * message when the file cannot be read or is not valid JSON; structural
 * validation problems are collected via {@link validateConfigFile} and
 * reported as a single error listing every problem.
 */
export async function loadConfigFile(
  filePath: string
): Promise<ServerConfigFile> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new Error(`Config file ${filePath} does not exist`, { cause: err });
    }
    if (code === 'EISDIR') {
      throw new Error(`Config file ${filePath} is a directory`, { cause: err });
    }
    throw new Error(
      `Config file ${filePath} could not be read: ${code ?? err}`,
      { cause: err }
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Config file ${filePath} is not valid JSON: ${(err as Error).message}`,
      { cause: err }
    );
  }

  const errors = validateConfigFile(parsed);
  if (errors.length > 0) {
    throw new Error(
      `Config file ${filePath} is invalid:\n  - ${errors.join('\n  - ')}`
    );
  }

  return parsed as ServerConfigFile;
}

/**
 * Merge config sources with later arguments winning. Top-level keys are
 * shallow (a file key fully replaces the default for that key), except
 * `sessionEnd`, which deep-merges so partial overrides behave predictably.
 * `undefined` values never override earlier values.
 */
export function mergeConfig<T extends object>(
  ...sources: Array<T | undefined>
): T {
  const result: Record<string, unknown> = {};
  for (const source of sources) {
    if (!source) {
      continue;
    }
    for (const [key, value] of Object.entries(source)) {
      if (value === undefined) {
        continue;
      }
      if (
        key === 'sessionEnd' &&
        key in result &&
        isPlainObject(result[key]) &&
        isPlainObject(value) &&
        (result[key] as Record<string, unknown>).type === value.type
      ) {
        result[key] = {
          ...(result[key] as Record<string, unknown>),
          ...value,
        };
      } else {
        result[key] = value;
      }
    }
  }
  return result as T;
}
