import fs from 'node:fs/promises';

/**
 * Session-end trigger fired when a swarm session transitions to ended at the
 * beacon (proxy route) or coordinator. Strictly one of two variants.
 */
export type SessionEndTrigger =
  | {
      type: 'command';
      command: string;
      /** Kill timeout for the spawned hook command. Defaults to 300000. */
      commandTimeoutMs?: number;
    }
  | { type: 'spawn'; persona: string; beaconId?: string };

/**
 * Beacon spawn working-directory roots. `paths` are literal absolute paths
 * and/or `*` glob entries (globs expand to concrete immediate-child dirs at
 * load and on periodic re-scan). `default` must be one of the expanded roots;
 * it is validated at load and falls back to the first expanded root with a
 * warning if not present.
 */
export interface SpawnRootsConfig {
  paths: string[];
  default: string;
}

export type EmbeddingBackendId = 'onnx' | 'ollama';

/**
 * Beacon-global embedding selection. `model` is a canonical model id from the
 * drone-core registry, never a backend-specific tag.
 */
export interface EmbeddingConfig {
  backend: EmbeddingBackendId;
  model: string;
  ollama?: { host?: string };
  onnx?: { dtype?: string; device?: string; cacheDir?: string };
}

/**
 * Beacon-global swarm-memory ranking.
 *
 * Ranking is a property of the corpus rather than of the asking agent, so
 * these knobs live here instead of in `.drone-agent/config.json`. The agent
 * keeps only conversation-shaped settings (`enabled`, `window`).
 */
export interface RankingConfig {
  /** Maximum entries returned per retrieval. */
  topK: number;
  /**
   * Minimum score for an entry to be returned.
   *
   * Applied AFTER fusion, so a page whose cosine alone falls short can still
   * qualify on keyword coverage.
   */
  minScore: number;
  /** Additive boost for a page whose content matches the query's terms. */
  keywordBoost: number;
  /** Static per-project relevance anchors applied as additive score boosts. */
  anchors?: {
    tags: string[];
    boostPerTag: number;
    boostTitle: number;
  };
}

/**
 * Beacon-global wiki index schedule. Controls how often the merged wiki is
 * re-indexed, how much the sweep paces its fetches, and how write bursts
 * coalesce into one re-index.
 */
export interface WikiIndexConfig {
  sweepIntervalMs: number;
  pacingMs: number;
  writeReindexDebounceMs: number;
}

export function defaultWikiIndexConfig(): WikiIndexConfig {
  return {
    sweepIntervalMs: 5 * 60 * 1000,
    pacingMs: 50,
    writeReindexDebounceMs: 5000,
  };
}

/**
 * Default ranking, matching the values the agent used to hold so that moving
 * ranking to the beacon does not silently change result ordering.
 */
export function defaultRankingConfig(): RankingConfig {
  return {
    topK: 5,
    minScore: 0.35,
    keywordBoost: 0.08,
    anchors: { tags: [], boostPerTag: 0.08, boostTitle: 0.05 },
  };
}

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
  autoApproveBeacons?: boolean;
  sessionEnd?: SessionEndTrigger;
  spawnRoots?: SpawnRootsConfig;
  embedding?: EmbeddingConfig;
  ranking?: RankingConfig;
  wikiIndex?: WikiIndexConfig;
  [key: string]: unknown;
}

const ALLOWED_KEYS: ReadonlySet<string> = new Set([
  'port',
  'host',
  'webPort',
  'webHost',
  'dbPath',
  'useHttps',
  'autoApproveBeacons',
  'sessionEnd',
  'spawnRoots',
  'embedding',
  'ranking',
  'wikiIndex',
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
    if (
      sessionEnd.commandTimeoutMs !== undefined &&
      (typeof sessionEnd.commandTimeoutMs !== 'number' ||
        !Number.isFinite(sessionEnd.commandTimeoutMs) ||
        sessionEnd.commandTimeoutMs <= 0)
    ) {
      errors.push('"sessionEnd.commandTimeoutMs" must be a positive number');
    }
    for (const key of Object.keys(sessionEnd)) {
      if (key !== 'type' && key !== 'command' && key !== 'commandTimeoutMs') {
        errors.push(`unknown key "sessionEnd.${key}" for type "command"`);
      }
    }
    return {
      type: 'command',
      command: sessionEnd.command as string,
      ...(sessionEnd.commandTimeoutMs !== undefined
        ? { commandTimeoutMs: sessionEnd.commandTimeoutMs as number }
        : {}),
    };
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

function validateSpawnRoots(
  spawnRoots: unknown,
  errors: string[]
): SpawnRootsConfig | undefined {
  if (!isPlainObject(spawnRoots)) {
    errors.push('"spawnRoots" must be an object');
    return undefined;
  }
  if (
    !Array.isArray(spawnRoots.paths) ||
    spawnRoots.paths.length === 0 ||
    !spawnRoots.paths.every(p => typeof p === 'string' && p.trim().length > 0)
  ) {
    errors.push(
      '"spawnRoots.paths" must be a non-empty array of non-empty strings'
    );
  }
  if (typeof spawnRoots.default !== 'string' || !spawnRoots.default.trim()) {
    errors.push('"spawnRoots.default" must be a non-empty string');
  }
  for (const key of Object.keys(spawnRoots)) {
    if (key !== 'paths' && key !== 'default') {
      errors.push(`unknown key "spawnRoots.${key}"`);
    }
  }
  return {
    paths: (spawnRoots.paths as string[]) ?? [],
    default: (spawnRoots.default as string) ?? '',
  };
}

const EMBEDDING_BACKENDS: ReadonlySet<string> = new Set(['onnx', 'ollama']);

function validateEmbeddingSubBlock(
  value: unknown,
  key: string,
  errors: string[]
): void {
  if (value === undefined) {
    return;
  }
  if (!isPlainObject(value)) {
    errors.push(`"embedding.${key}" must be an object`);
  }
}

function validateEmbedding(embedding: unknown, errors: string[]): void {
  if (!isPlainObject(embedding)) {
    errors.push('"embedding" must be an object');
    return;
  }
  if (
    typeof embedding.backend !== 'string' ||
    !EMBEDDING_BACKENDS.has(embedding.backend)
  ) {
    errors.push('"embedding.backend" must be "onnx" or "ollama"');
  }
  if (typeof embedding.model !== 'string' || !embedding.model.trim()) {
    errors.push('"embedding.model" must be a non-empty string');
  }
  for (const key of Object.keys(embedding)) {
    if (
      key !== 'backend' &&
      key !== 'model' &&
      key !== 'ollama' &&
      key !== 'onnx'
    ) {
      errors.push(`unknown key "embedding.${key}"`);
    }
  }
  validateEmbeddingSubBlock(embedding.ollama, 'ollama', errors);
  validateEmbeddingSubBlock(embedding.onnx, 'onnx', errors);
}

const RANKING_NUMERIC_KEYS = ['topK', 'minScore', 'keywordBoost'] as const;

function validateRankingAnchors(value: unknown, errors: string[]): void {
  if (value === undefined) return;
  if (!isPlainObject(value)) {
    errors.push('"ranking.anchors" must be an object');
    return;
  }
  for (const key of Object.keys(value)) {
    if (key !== 'tags' && key !== 'boostPerTag' && key !== 'boostTitle') {
      errors.push(`unknown key "ranking.anchors.${key}"`);
    }
  }
  if (
    value.tags !== undefined &&
    (!Array.isArray(value.tags) ||
      !value.tags.every(t => typeof t === 'string'))
  ) {
    errors.push('"ranking.anchors.tags" must be an array of strings');
  }
  for (const key of ['boostPerTag', 'boostTitle'] as const) {
    if (
      value[key] !== undefined &&
      (typeof value[key] !== 'number' || !Number.isFinite(value[key]))
    ) {
      errors.push(`"ranking.anchors.${key}" must be a finite number`);
    }
  }
}

function validateRanking(ranking: unknown, errors: string[]): void {
  if (!isPlainObject(ranking)) {
    errors.push('"ranking" must be an object');
    return;
  }
  for (const key of Object.keys(ranking)) {
    if (
      key !== 'anchors' &&
      !(RANKING_NUMERIC_KEYS as readonly string[]).includes(key)
    ) {
      errors.push(`unknown key "ranking.${key}"`);
    }
  }
  for (const key of RANKING_NUMERIC_KEYS) {
    if (
      ranking[key] !== undefined &&
      (typeof ranking[key] !== 'number' ||
        !Number.isFinite(ranking[key] as number))
    ) {
      errors.push(`"ranking.${key}" must be a finite number`);
    }
  }
  validateRankingAnchors(ranking.anchors, errors);
}

const WIKI_INDEX_NUMERIC_KEYS = [
  'sweepIntervalMs',
  'pacingMs',
  'writeReindexDebounceMs',
] as const;

function validateWikiIndex(wikiIndex: unknown, errors: string[]): void {
  if (!isPlainObject(wikiIndex)) {
    errors.push('"wikiIndex" must be an object');
    return;
  }
  for (const key of Object.keys(wikiIndex)) {
    if (!(WIKI_INDEX_NUMERIC_KEYS as readonly string[]).includes(key)) {
      errors.push(`unknown key "wikiIndex.${key}"`);
    }
  }
  for (const key of WIKI_INDEX_NUMERIC_KEYS) {
    if (
      wikiIndex[key] !== undefined &&
      (typeof wikiIndex[key] !== 'number' ||
        !Number.isFinite(wikiIndex[key] as number))
    ) {
      errors.push(`"wikiIndex.${key}" must be a finite number`);
    }
  }
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
  if (
    value.autoApproveBeacons !== undefined &&
    typeof value.autoApproveBeacons !== 'boolean'
  ) {
    errors.push('"autoApproveBeacons" must be a boolean');
  }
  if (value.sessionEnd !== undefined) {
    validateSessionEnd(value.sessionEnd, errors);
  }
  if (value.spawnRoots !== undefined) {
    validateSpawnRoots(value.spawnRoots, errors);
  }
  if (value.embedding !== undefined) {
    validateEmbedding(value.embedding, errors);
  }
  if (value.ranking !== undefined) {
    validateRanking(value.ranking, errors);
  }
  if (value.wikiIndex !== undefined) {
    validateWikiIndex(value.wikiIndex, errors);
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
