import { access, readFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  applyAgentConfigLayer,
  createDefaultAgentConfig,
  type DroneConfigLayer,
  type DroneMcpServerConfig,
  type DroneLspServerConfig,
  type DroneResolvedConfig,
  type PartialDroneAgentConfig,
} from 'drone-core';
import { isRecord, isStringArray } from '../shared/type-guards.js';

// ── Validation helpers ────────────────────────────────────────────────

function validateString(
  raw: unknown,
  _key: string,
  source: string,
  keyPath: string
): string {
  if (typeof raw !== 'string') {
    throw new Error(
      `Invalid config in ${source}: ${keyPath} must be a string.`
    );
  }
  return raw;
}

function validateNonEmptyString(
  raw: unknown,
  _key: string,
  source: string,
  keyPath: string
): string {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new Error(
      `Invalid config in ${source}: ${keyPath} must be a non-empty string.`
    );
  }
  return raw;
}

function validateBoolean(
  raw: unknown,
  _key: string,
  source: string,
  keyPath: string
): boolean {
  if (typeof raw !== 'boolean') {
    throw new Error(
      `Invalid config in ${source}: ${keyPath} must be a boolean.`
    );
  }
  return raw;
}

function validatePositiveNumber(
  raw: unknown,
  _key: string,
  source: string,
  keyPath: string
): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
    throw new Error(
      `Invalid config in ${source}: ${keyPath} must be a positive number.`
    );
  }
  return raw;
}

function validatePositiveInteger(
  raw: unknown,
  _key: string,
  source: string,
  keyPath: string
): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) {
    throw new Error(
      `Invalid config in ${source}: ${keyPath} must be a positive integer.`
    );
  }
  return raw;
}

function validateNonNegativeInteger(
  raw: unknown,
  _key: string,
  source: string,
  keyPath: string
): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
    throw new Error(
      `Invalid config in ${source}: ${keyPath} must be a non-negative integer.`
    );
  }
  return raw;
}

function validateNonNegativeNumber(
  raw: unknown,
  _key: string,
  source: string,
  keyPath: string
): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) {
    throw new Error(
      `Invalid config in ${source}: ${keyPath} must be a non-negative number.`
    );
  }
  return raw;
}

function validatePercent(
  raw: unknown,
  _key: string,
  source: string,
  keyPath: string
): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0 || raw > 100) {
    throw new Error(
      `Invalid config in ${source}: ${keyPath} must be a number between 0 and 100.`
    );
  }
  return raw;
}

function validateStringArray(
  raw: unknown,
  _key: string,
  source: string,
  keyPath: string
): string[] {
  if (!Array.isArray(raw) || raw.some(item => typeof item !== 'string')) {
    throw new Error(
      `Invalid config in ${source}: ${keyPath} must be an array of strings.`
    );
  }
  return raw;
}

function validateStringOrNull(
  raw: unknown,
  _key: string,
  source: string,
  keyPath: string
): string | null {
  if (raw !== null && typeof raw !== 'string') {
    throw new Error(
      `Invalid config in ${source}: ${keyPath} must be a string or null.`
    );
  }
  return raw;
}

export const CONFIG_DIRECTORY_NAME = '.drone-agent';
export const CONFIG_FILE_NAME = 'config.json';

function interpolateEnvironmentVariables(
  value: string,
  source: string,
  keyPath: string
): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, variableName: string) => {
    const resolved = process.env[variableName];
    if (resolved === undefined) {
      throw new Error(
        `Invalid config in ${source}: ${keyPath} references unset environment variable ${variableName}.`
      );
    }

    return resolved;
  });
}

function parseStringRecord(
  raw: unknown,
  source: string,
  keyPath: string,
  allowInterpolation: boolean
): Record<string, string> {
  if (!isRecord(raw)) {
    throw new Error(
      `Invalid config in ${source}: ${keyPath} must be an object.`
    );
  }

  const record: Record<string, string> = {};
  for (const [recordKey, recordValue] of Object.entries(raw)) {
    if (typeof recordValue !== 'string') {
      throw new Error(
        `Invalid config in ${source}: ${keyPath}.${recordKey} must be a string.`
      );
    }

    record[recordKey] = allowInterpolation
      ? interpolateEnvironmentVariables(
          recordValue,
          source,
          `${keyPath}.${recordKey}`
        )
      : recordValue;
  }

  return record;
}

function parseLspServerConfig(
  serverId: string,
  raw: unknown,
  source: string
): DroneLspServerConfig {
  if (!isRecord(raw)) {
    throw new Error(
      `Invalid config in ${source}: lsp.servers.${serverId} must be an object.`
    );
  }

  const language = raw.language !== undefined
    ? validateString(raw.language, 'language', source, `lsp.servers.${serverId}.language`)
    : undefined;

  const fileExtensions = raw.fileExtensions !== undefined
    ? validateStringArray(raw.fileExtensions, 'fileExtensions', source, `lsp.servers.${serverId}.fileExtensions`)
    : undefined;

  const rootPatterns = raw.rootPatterns !== undefined
    ? validateStringArray(raw.rootPatterns, 'rootPatterns', source, `lsp.servers.${serverId}.rootPatterns`)
    : undefined;

  if (raw.transport === 'tcp') {
    const host = validateNonEmptyString(raw.host, 'host', source, `lsp.servers.${serverId}.host`);
    const port = validatePositiveInteger(raw.port, 'port', source, `lsp.servers.${serverId}.port`);
    return {
      transport: 'tcp',
      language,
      host,
      port,
      fileExtensions,
      rootPatterns,
    };
  }

  if (raw.transport !== undefined && raw.transport !== 'stdio') {
    throw new Error(
      `Invalid config in ${source}: lsp.servers.${serverId}.transport must be "stdio" or "tcp".`
    );
  }

  const command = validateNonEmptyString(raw.command, 'command', source, `lsp.servers.${serverId}.command`);

  const args = raw.args !== undefined
    ? validateStringArray(raw.args, 'args', source, `lsp.servers.${serverId}.args`)
    : undefined;

  const autoInstall = raw.autoInstall !== undefined
    ? validateBoolean(raw.autoInstall, 'autoInstall', source, `lsp.servers.${serverId}.autoInstall`)
    : undefined;

  return {
    transport: 'stdio',
    language,
    command,
    args,
    autoInstall,
    fileExtensions,
    rootPatterns,
  };
}

function parseMcpServerConfig(
  serverId: string,
  raw: unknown,
  source: string
): DroneMcpServerConfig {
  if (!isRecord(raw)) {
    throw new Error(
      `Invalid config in ${source}: mcp.servers.${serverId} must be an object.`
    );
  }

  if (raw.transport === 'streamable_http') {
    const url = validateNonEmptyString(raw.url, 'url', source, `mcp.servers.${serverId}.url`);

    const headers =
      raw.headers !== undefined
        ? parseStringRecord(
            raw.headers,
            source,
            `mcp.servers.${serverId}.headers`,
            true
          )
        : undefined;

    const allowedTools = raw.allowedTools !== undefined
      ? validateStringArray(raw.allowedTools, 'allowedTools', source, `mcp.servers.${serverId}.allowedTools`)
      : undefined;

    const requestTimeoutMs = raw.requestTimeoutMs !== undefined
      ? validatePositiveNumber(raw.requestTimeoutMs, 'requestTimeoutMs', source, `mcp.servers.${serverId}.requestTimeoutMs`)
      : undefined;

    const retryCount = raw.retryCount !== undefined
      ? validateNonNegativeInteger(raw.retryCount, 'retryCount', source, `mcp.servers.${serverId}.retryCount`)
      : undefined;

    const retryDelayMs = raw.retryDelayMs !== undefined
      ? validateNonNegativeNumber(raw.retryDelayMs, 'retryDelayMs', source, `mcp.servers.${serverId}.retryDelayMs`)
      : undefined;

    const maxListPages = raw.maxListPages !== undefined
      ? validatePositiveInteger(raw.maxListPages, 'maxListPages', source, `mcp.servers.${serverId}.maxListPages`)
      : undefined;

    const maxListItems = raw.maxListItems !== undefined
      ? validatePositiveInteger(raw.maxListItems, 'maxListItems', source, `mcp.servers.${serverId}.maxListItems`)
      : undefined;

    const compatibilityMode = raw.compatibilityMode;
    if (
      compatibilityMode !== undefined &&
      compatibilityMode !== 'strict' &&
      compatibilityMode !== 'permissive'
    ) {
      throw new Error(
        `Invalid config in ${source}: mcp.servers.${serverId}.compatibilityMode must be "strict" or "permissive".`
      );
    }

    return {
      transport: 'streamable_http',
      url: interpolateEnvironmentVariables(
        url,
        source,
        `mcp.servers.${serverId}.url`
      ),
      headers,
      allowedTools,
      requestTimeoutMs,
      retryCount,
      retryDelayMs,
      maxListPages,
      maxListItems,
      compatibilityMode,
    };
  }

  if (raw.transport !== undefined && raw.transport !== 'stdio') {
    throw new Error(
      `Invalid config in ${source}: mcp.servers.${serverId}.transport must be "stdio" or "streamable_http".`
    );
  }

  const command = validateNonEmptyString(raw.command, 'command', source, `mcp.servers.${serverId}.command`);

  const args = raw.args !== undefined
    ? validateStringArray(raw.args, 'args', source, `mcp.servers.${serverId}.args`)
    : undefined;

  const cwd = raw.cwd !== undefined
    ? validateString(raw.cwd, 'cwd', source, `mcp.servers.${serverId}.cwd`)
    : undefined;

  const env =
    raw.env !== undefined
      ? parseStringRecord(raw.env, source, `mcp.servers.${serverId}.env`, true)
      : undefined;

  const allowedTools = raw.allowedTools !== undefined
    ? validateStringArray(raw.allowedTools, 'allowedTools', source, `mcp.servers.${serverId}.allowedTools`)
    : undefined;

  const requestTimeoutMs = raw.requestTimeoutMs !== undefined
    ? validatePositiveNumber(raw.requestTimeoutMs, 'requestTimeoutMs', source, `mcp.servers.${serverId}.requestTimeoutMs`)
    : undefined;

  const retryCount = raw.retryCount !== undefined
    ? validateNonNegativeInteger(raw.retryCount, 'retryCount', source, `mcp.servers.${serverId}.retryCount`)
    : undefined;

  const retryDelayMs = raw.retryDelayMs !== undefined
    ? validateNonNegativeNumber(raw.retryDelayMs, 'retryDelayMs', source, `mcp.servers.${serverId}.retryDelayMs`)
    : undefined;

  const maxListPages = raw.maxListPages !== undefined
    ? validatePositiveInteger(raw.maxListPages, 'maxListPages', source, `mcp.servers.${serverId}.maxListPages`)
    : undefined;

  const maxListItems = raw.maxListItems !== undefined
    ? validatePositiveInteger(raw.maxListItems, 'maxListItems', source, `mcp.servers.${serverId}.maxListItems`)
    : undefined;

  const encoding = raw.encoding;
  if (
    encoding !== undefined &&
    encoding !== 'content-length' &&
    encoding !== 'line-delimited'
  ) {
    throw new Error(
      `Invalid config in ${source}: mcp.servers.${serverId}.encoding must be "content-length" or "line-delimited".`
    );
  }

  return {
    transport: 'stdio',
    command: interpolateEnvironmentVariables(
      command,
      source,
      `mcp.servers.${serverId}.command`
    ),
    args: args?.map((value, index) =>
      interpolateEnvironmentVariables(
        value,
        source,
        `mcp.servers.${serverId}.args.${index}`
      )
    ),
    cwd:
      cwd !== undefined
        ? interpolateEnvironmentVariables(
            cwd,
            source,
            `mcp.servers.${serverId}.cwd`
          )
        : undefined,
    env,
    allowedTools,
    requestTimeoutMs,
    retryCount,
    retryDelayMs,
    maxListPages,
    maxListItems,
    encoding,
  };
}

export function parsePartialConfig(
  raw: unknown,
  source: string
): PartialDroneAgentConfig {
  if (!isRecord(raw)) {
    throw new Error(`Invalid config in ${source}: expected a JSON object.`);
  }

  const parsed: PartialDroneAgentConfig = {};

  if ('enabledPlugins' in raw) {
    parsed.enabledPlugins = validateStringArray(
      raw.enabledPlugins,
      'enabledPlugins',
      source,
      'enabledPlugins'
    );
  }

  if ('systemPrompt' in raw) {
    parsed.systemPrompt = validateString(
      raw.systemPrompt,
      'systemPrompt',
      source,
      'systemPrompt'
    );
  }

  if ('ollama' in raw) {
    if (!isRecord(raw.ollama)) {
      throw new Error(`Invalid config in ${source}: ollama must be an object.`);
    }

    const ollama: PartialDroneAgentConfig['ollama'] = {};
    if ('host' in raw.ollama) {
      ollama.host = validateString(raw.ollama.host, 'host', source, 'ollama.host');
    }
    if ('model' in raw.ollama) {
      ollama.model = validateString(raw.ollama.model, 'model', source, 'ollama.model');
    }
    parsed.ollama = ollama;
  }

  if ('llm' in raw) {
    if (!isRecord(raw.llm)) {
      throw new Error(`Invalid config in ${source}: llm must be an object.`);
    }

    const llm: PartialDroneAgentConfig['llm'] = {};
    if ('provider' in raw.llm) {
      llm.provider = validateString(raw.llm.provider, 'provider', source, 'llm.provider');
    }
    parsed.llm = llm;
  }

  if ('openrouter' in raw) {
    if (!isRecord(raw.openrouter)) {
      throw new Error(`Invalid config in ${source}: openrouter must be an object.`);
    }

    const openrouter: PartialDroneAgentConfig['openrouter'] = {};
    if ('apiKey' in raw.openrouter) {
      openrouter.apiKey = validateString(raw.openrouter.apiKey, 'apiKey', source, 'openrouter.apiKey');
    }
    if ('defaultModel' in raw.openrouter) {
      openrouter.defaultModel = validateString(raw.openrouter.defaultModel, 'defaultModel', source, 'openrouter.defaultModel');
    }
    if ('baseUrl' in raw.openrouter) {
      openrouter.baseUrl = validateString(raw.openrouter.baseUrl, 'baseUrl', source, 'openrouter.baseUrl');
    }
    if ('models' in raw.openrouter) {
      if (!Array.isArray(raw.openrouter.models)) {
        throw new Error(
          `Invalid config in ${source}: openrouter.models must be an array.`
        );
      }
      const models: { id: string; contextWindow: number }[] = [];
      for (let i = 0; i < raw.openrouter.models.length; i++) {
        const entry = raw.openrouter.models[i];
        if (!isRecord(entry)) {
          throw new Error(
            `Invalid config in ${source}: openrouter.models[${i}] must be an object.`
          );
        }
        const modelId = validateNonEmptyString(entry.id, 'id', source, `openrouter.models[${i}].id`);
        const modelCtx = validatePositiveNumber(entry.contextWindow, 'contextWindow', source, `openrouter.models[${i}].contextWindow`);
        models.push({ id: modelId, contextWindow: modelCtx });
      }
      openrouter.models = models;
    }
    parsed.openrouter = openrouter;
  }

  if ('session' in raw) {
    if (!isRecord(raw.session)) {
      throw new Error(
        `Invalid config in ${source}: session must be an object.`
      );
    }

    const session: PartialDroneAgentConfig['session'] = {};
    if ('contextWindowTokens' in raw.session) {
      session.contextWindowTokens = validatePositiveNumber(
        raw.session.contextWindowTokens,
        'contextWindowTokens',
        source,
        'session.contextWindowTokens'
      );
    }
    if ('responseReserveTokens' in raw.session) {
      session.responseReserveTokens = validatePositiveNumber(
        raw.session.responseReserveTokens,
        'responseReserveTokens',
        source,
        'session.responseReserveTokens'
      );
    }
    if ('maxToolIterations' in raw.session) {
      session.maxToolIterations = validatePositiveInteger(
        raw.session.maxToolIterations,
        'maxToolIterations',
        source,
        'session.maxToolIterations'
      );
    }
    if ('promptOnToolIterationLimit' in raw.session) {
      session.promptOnToolIterationLimit = validateBoolean(
        raw.session.promptOnToolIterationLimit,
        'promptOnToolIterationLimit',
        source,
        'session.promptOnToolIterationLimit'
      );
    }
    parsed.session = session;
  }

  if ('lsp' in raw) {
    if (!isRecord(raw.lsp)) {
      throw new Error(`Invalid config in ${source}: lsp must be an object.`);
    }

    const lsp: PartialDroneAgentConfig['lsp'] = {};

    if ('enabled' in raw.lsp) {
      lsp.enabled = validateBoolean(raw.lsp.enabled, 'enabled', source, 'lsp.enabled');
    }

    if ('diagnosticTokenBudget' in raw.lsp) {
      lsp.diagnosticTokenBudget = validatePositiveNumber(
        raw.lsp.diagnosticTokenBudget,
        'diagnosticTokenBudget',
        source,
        'lsp.diagnosticTokenBudget'
      );
    }

    if ('requestTimeoutMs' in raw.lsp) {
      lsp.requestTimeoutMs = validatePositiveNumber(
        raw.lsp.requestTimeoutMs,
        'requestTimeoutMs',
        source,
        'lsp.requestTimeoutMs'
      );
    }

    if ('preferExternal' in raw.lsp) {
      lsp.preferExternal = validateBoolean(raw.lsp.preferExternal, 'preferExternal', source, 'lsp.preferExternal');
    }

    if ('autoInstall' in raw.lsp) {
      lsp.autoInstall = validateBoolean(raw.lsp.autoInstall, 'autoInstall', source, 'lsp.autoInstall');
    }

    if ('servers' in raw.lsp) {
      if (!isRecord(raw.lsp.servers)) {
        throw new Error(
          `Invalid config in ${source}: lsp.servers must be an object.`
        );
      }

      const servers: Record<string, DroneLspServerConfig> = {};
      for (const [serverId, serverConfig] of Object.entries(raw.lsp.servers)) {
        servers[serverId] = parseLspServerConfig(
          serverId,
          serverConfig,
          source
        );
      }
      lsp.servers = servers;
    }

    parsed.lsp = lsp;
  }

  if ('mcp' in raw) {
    if (!isRecord(raw.mcp)) {
      throw new Error(`Invalid config in ${source}: mcp must be an object.`);
    }

    const mcp: PartialDroneAgentConfig['mcp'] = {};

    if ('enabled' in raw.mcp) {
      mcp.enabled = validateBoolean(raw.mcp.enabled, 'enabled', source, 'mcp.enabled');
    }

    if ('requestTimeoutMs' in raw.mcp) {
      mcp.requestTimeoutMs = validatePositiveNumber(
        raw.mcp.requestTimeoutMs,
        'requestTimeoutMs',
        source,
        'mcp.requestTimeoutMs'
      );
    }

    if ('retryCount' in raw.mcp) {
      mcp.retryCount = validateNonNegativeInteger(
        raw.mcp.retryCount,
        'retryCount',
        source,
        'mcp.retryCount'
      );
    }

    if ('retryDelayMs' in raw.mcp) {
      mcp.retryDelayMs = validateNonNegativeNumber(
        raw.mcp.retryDelayMs,
        'retryDelayMs',
        source,
        'mcp.retryDelayMs'
      );
    }

    if ('maxListPages' in raw.mcp) {
      mcp.maxListPages = validatePositiveInteger(
        raw.mcp.maxListPages,
        'maxListPages',
        source,
        'mcp.maxListPages'
      );
    }

    if ('maxListItems' in raw.mcp) {
      mcp.maxListItems = validatePositiveInteger(
        raw.mcp.maxListItems,
        'maxListItems',
        source,
        'mcp.maxListItems'
      );
    }

    if ('compatibilityMode' in raw.mcp) {
      if (
        raw.mcp.compatibilityMode !== 'strict' &&
        raw.mcp.compatibilityMode !== 'permissive'
      ) {
        throw new Error(
          `Invalid config in ${source}: mcp.compatibilityMode must be "strict" or "permissive".`
        );
      }
      mcp.compatibilityMode = raw.mcp.compatibilityMode;
    }

    if ('servers' in raw.mcp) {
      if (!isRecord(raw.mcp.servers)) {
        throw new Error(
          `Invalid config in ${source}: mcp.servers must be an object.`
        );
      }

      const servers: Record<string, DroneMcpServerConfig> = {};
      for (const [serverId, serverConfig] of Object.entries(raw.mcp.servers)) {
        servers[serverId] = parseMcpServerConfig(
          serverId,
          serverConfig,
          source
        );
      }
      mcp.servers = servers;
    }

    parsed.mcp = mcp;
  }

  if ('activePersona' in raw) {
    parsed.activePersona = validateStringOrNull(
      raw.activePersona,
      'activePersona',
      source,
      'activePersona'
    );
  }

  if ('compaction' in raw) {
    if (!isRecord(raw.compaction)) {
      throw new Error(
        `Invalid config in ${source}: compaction must be an object.`
      );
    }

    const compaction: PartialDroneAgentConfig['compaction'] = {};

    if ('enabled' in raw.compaction) {
      compaction.enabled = validateBoolean(raw.compaction.enabled, 'enabled', source, 'compaction.enabled');
    }

    if ('strategy' in raw.compaction) {
      if (raw.compaction.strategy !== 'summary-drop') {
        throw new Error(
          `Invalid config in ${source}: compaction.strategy must be "summary-drop".`
        );
      }
      compaction.strategy = raw.compaction.strategy;
    }

    if ('softThresholdPercent' in raw.compaction) {
      compaction.softThresholdPercent = validatePercent(
        raw.compaction.softThresholdPercent,
        'softThresholdPercent',
        source,
        'compaction.softThresholdPercent'
      );
    }

    if ('slicePercent' in raw.compaction) {
      compaction.slicePercent = validatePercent(
        raw.compaction.slicePercent,
        'slicePercent',
        source,
        'compaction.slicePercent'
      );
    }

    if ('minTurnsToCompact' in raw.compaction) {
      compaction.minTurnsToCompact = validatePositiveInteger(
        raw.compaction.minTurnsToCompact,
        'minTurnsToCompact',
        source,
        'compaction.minTurnsToCompact'
      );
    }

    if ('summaryMaxTokens' in raw.compaction) {
      compaction.summaryMaxTokens = validatePositiveNumber(
        raw.compaction.summaryMaxTokens,
        'summaryMaxTokens',
        source,
        'compaction.summaryMaxTokens'
      );
    }

    if ('summaryBudgetPercent' in raw.compaction) {
      compaction.summaryBudgetPercent = validatePercent(
        raw.compaction.summaryBudgetPercent,
        'summaryBudgetPercent',
        source,
        'compaction.summaryBudgetPercent'
      );
    }

    parsed.compaction = compaction;
  }

  if ('memory' in raw) {
    if (!isRecord(raw.memory)) {
      throw new Error(
        `Invalid config in ${source}: memory must be an object.`
      );
    }

    const memory: PartialDroneAgentConfig['memory'] = {};

    if ('enabled' in raw.memory) {
      memory.enabled = validateBoolean(raw.memory.enabled, 'enabled', source, 'memory.enabled');
    }

    parsed.memory = memory;
  }

  if ('log' in raw) {
    if (!isRecord(raw.log)) {
      throw new Error(
        `Invalid config in ${source}: log must be an object.`
      );
    }

    const log: PartialDroneAgentConfig['log'] = {};

    if ('enabled' in raw.log) {
      log.enabled = validateBoolean(raw.log.enabled, 'enabled', source, 'log.enabled');
    }

    parsed.log = log;
  }

  if ('promptFile' in raw) {
    if (!isRecord(raw.promptFile)) {
      throw new Error(
        `Invalid config in ${source}: promptFile must be an object.`
      );
    }

    const promptFile: PartialDroneAgentConfig['promptFile'] = {};

    if ('enabled' in raw.promptFile) {
      promptFile.enabled = validateBoolean(raw.promptFile.enabled, 'enabled', source, 'promptFile.enabled');
    }

    if ('files' in raw.promptFile) {
      promptFile.files = validateStringArray(raw.promptFile.files, 'files', source, 'promptFile.files');
    }

    parsed.promptFile = promptFile;
  }

  return parsed;
}

async function pathExists(candidatePath: string): Promise<boolean> {
  try {
    await access(candidatePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function loadConfigLayer(
  scope: DroneConfigLayer['scope'],
  filePath: string
): Promise<DroneConfigLayer | null> {
  if (!(await pathExists(filePath))) {
    return null;
  }

  const fileContents = await readFile(filePath, 'utf-8');
  const parsed = parsePartialConfig(JSON.parse(fileContents), filePath);

  return {
    scope,
    path: filePath,
    config: parsed,
  };
}

export async function findProjectConfigPath(
  startDirectory: string
): Promise<string | undefined> {
  let currentDirectory = path.resolve(startDirectory);

  while (true) {
    const candidate = path.join(
      currentDirectory,
      CONFIG_DIRECTORY_NAME,
      CONFIG_FILE_NAME
    );
    if (await pathExists(candidate)) {
      return candidate;
    }

    const parentDirectory = path.dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      return undefined;
    }

    currentDirectory = parentDirectory;
  }
}

export async function loadAgentConfig(
  startDirectory: string
): Promise<DroneResolvedConfig> {
  const layers: DroneConfigLayer[] = [
    {
      scope: 'default',
      config: createDefaultAgentConfig(),
    },
  ];

  const userConfigPath = path.join(
    os.homedir(),
    CONFIG_DIRECTORY_NAME,
    CONFIG_FILE_NAME
  );
  const userLayer = await loadConfigLayer('user', userConfigPath);
  if (userLayer) {
    layers.push(userLayer);
  }

  const projectConfigPath = await findProjectConfigPath(startDirectory);
  if (projectConfigPath) {
    const projectLayer = await loadConfigLayer('project', projectConfigPath);
    if (projectLayer) {
      layers.push(projectLayer);
    }
  }

  let mergedConfig = createDefaultAgentConfig();
  for (const layer of layers) {
    mergedConfig = applyAgentConfigLayer(mergedConfig, layer.config);
  }

  return {
    config: mergedConfig,
    layers,
  };
}
