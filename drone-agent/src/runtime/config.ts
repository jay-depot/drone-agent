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

const CONFIG_DIRECTORY_NAME = '.drone-agent';
const CONFIG_FILE_NAME = 'config.json';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

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

  const language = raw.language;
  if (language !== undefined && typeof language !== 'string') {
    throw new Error(
      `Invalid config in ${source}: lsp.servers.${serverId}.language must be a string.`
    );
  }

  const fileExtensions = raw.fileExtensions;
  if (fileExtensions !== undefined && !isStringArray(fileExtensions)) {
    throw new Error(
      `Invalid config in ${source}: lsp.servers.${serverId}.fileExtensions must be an array of strings.`
    );
  }

  const rootPatterns = raw.rootPatterns;
  if (rootPatterns !== undefined && !isStringArray(rootPatterns)) {
    throw new Error(
      `Invalid config in ${source}: lsp.servers.${serverId}.rootPatterns must be an array of strings.`
    );
  }

  if (raw.transport === 'tcp') {
    if (typeof raw.host !== 'string' || raw.host.trim().length === 0) {
      throw new Error(
        `Invalid config in ${source}: lsp.servers.${serverId}.host must be a non-empty string.`
      );
    }
    if (
      typeof raw.port !== 'number' ||
      !Number.isInteger(raw.port) ||
      raw.port <= 0
    ) {
      throw new Error(
        `Invalid config in ${source}: lsp.servers.${serverId}.port must be a positive integer.`
      );
    }

    return {
      transport: 'tcp',
      language,
      host: raw.host,
      port: raw.port,
      fileExtensions,
      rootPatterns,
    };
  }

  if (raw.transport !== undefined && raw.transport !== 'stdio') {
    throw new Error(
      `Invalid config in ${source}: lsp.servers.${serverId}.transport must be "stdio" or "tcp".`
    );
  }

  if (typeof raw.command !== 'string' || raw.command.trim().length === 0) {
    throw new Error(
      `Invalid config in ${source}: lsp.servers.${serverId}.command must be a non-empty string for stdio servers.`
    );
  }

  const args = raw.args;
  if (args !== undefined && !isStringArray(args)) {
    throw new Error(
      `Invalid config in ${source}: lsp.servers.${serverId}.args must be an array of strings.`
    );
  }

  const autoInstall = raw.autoInstall;
  if (autoInstall !== undefined && typeof autoInstall !== 'boolean') {
    throw new Error(
      `Invalid config in ${source}: lsp.servers.${serverId}.autoInstall must be a boolean.`
    );
  }

  return {
    transport: 'stdio',
    language,
    command: raw.command,
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
    if (typeof raw.url !== 'string' || raw.url.trim().length === 0) {
      throw new Error(
        `Invalid config in ${source}: mcp.servers.${serverId}.url must be a non-empty string.`
      );
    }

    const headers =
      raw.headers !== undefined
        ? parseStringRecord(
            raw.headers,
            source,
            `mcp.servers.${serverId}.headers`,
            true
          )
        : undefined;
    const allowedTools = raw.allowedTools;
    if (allowedTools !== undefined && !isStringArray(allowedTools)) {
      throw new Error(
        `Invalid config in ${source}: mcp.servers.${serverId}.allowedTools must be an array of strings.`
      );
    }

    const requestTimeoutMs = raw.requestTimeoutMs;
    if (
      requestTimeoutMs !== undefined &&
      (typeof requestTimeoutMs !== 'number' ||
        !Number.isFinite(requestTimeoutMs) ||
        requestTimeoutMs <= 0)
    ) {
      throw new Error(
        `Invalid config in ${source}: mcp.servers.${serverId}.requestTimeoutMs must be a positive number.`
      );
    }

    const retryCount = raw.retryCount;
    if (
      retryCount !== undefined &&
      (typeof retryCount !== 'number' ||
        !Number.isInteger(retryCount) ||
        retryCount < 0)
    ) {
      throw new Error(
        `Invalid config in ${source}: mcp.servers.${serverId}.retryCount must be a non-negative integer.`
      );
    }

    const retryDelayMs = raw.retryDelayMs;
    if (
      retryDelayMs !== undefined &&
      (typeof retryDelayMs !== 'number' ||
        !Number.isFinite(retryDelayMs) ||
        retryDelayMs < 0)
    ) {
      throw new Error(
        `Invalid config in ${source}: mcp.servers.${serverId}.retryDelayMs must be a non-negative number.`
      );
    }

    const maxListPages = raw.maxListPages;
    if (
      maxListPages !== undefined &&
      (typeof maxListPages !== 'number' ||
        !Number.isInteger(maxListPages) ||
        maxListPages <= 0)
    ) {
      throw new Error(
        `Invalid config in ${source}: mcp.servers.${serverId}.maxListPages must be a positive integer.`
      );
    }

    const maxListItems = raw.maxListItems;
    if (
      maxListItems !== undefined &&
      (typeof maxListItems !== 'number' ||
        !Number.isInteger(maxListItems) ||
        maxListItems <= 0)
    ) {
      throw new Error(
        `Invalid config in ${source}: mcp.servers.${serverId}.maxListItems must be a positive integer.`
      );
    }

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
        raw.url,
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

  if (typeof raw.command !== 'string' || raw.command.trim().length === 0) {
    throw new Error(
      `Invalid config in ${source}: mcp.servers.${serverId}.command must be a non-empty string for stdio servers.`
    );
  }

  const args = raw.args;
  if (args !== undefined && !isStringArray(args)) {
    throw new Error(
      `Invalid config in ${source}: mcp.servers.${serverId}.args must be an array of strings.`
    );
  }

  const cwd = raw.cwd;
  if (cwd !== undefined && typeof cwd !== 'string') {
    throw new Error(
      `Invalid config in ${source}: mcp.servers.${serverId}.cwd must be a string.`
    );
  }

  const env =
    raw.env !== undefined
      ? parseStringRecord(raw.env, source, `mcp.servers.${serverId}.env`, true)
      : undefined;

  const allowedTools = raw.allowedTools;
  if (allowedTools !== undefined && !isStringArray(allowedTools)) {
    throw new Error(
      `Invalid config in ${source}: mcp.servers.${serverId}.allowedTools must be an array of strings.`
    );
  }

  const requestTimeoutMs = raw.requestTimeoutMs;
  if (
    requestTimeoutMs !== undefined &&
    (typeof requestTimeoutMs !== 'number' ||
      !Number.isFinite(requestTimeoutMs) ||
      requestTimeoutMs <= 0)
  ) {
    throw new Error(
      `Invalid config in ${source}: mcp.servers.${serverId}.requestTimeoutMs must be a positive number.`
    );
  }

  const retryCount = raw.retryCount;
  if (
    retryCount !== undefined &&
    (typeof retryCount !== 'number' ||
      !Number.isInteger(retryCount) ||
      retryCount < 0)
  ) {
    throw new Error(
      `Invalid config in ${source}: mcp.servers.${serverId}.retryCount must be a non-negative integer.`
    );
  }

  const retryDelayMs = raw.retryDelayMs;
  if (
    retryDelayMs !== undefined &&
    (typeof retryDelayMs !== 'number' ||
      !Number.isFinite(retryDelayMs) ||
      retryDelayMs < 0)
  ) {
    throw new Error(
      `Invalid config in ${source}: mcp.servers.${serverId}.retryDelayMs must be a non-negative number.`
    );
  }

  const maxListPages = raw.maxListPages;
  if (
    maxListPages !== undefined &&
    (typeof maxListPages !== 'number' ||
      !Number.isInteger(maxListPages) ||
      maxListPages <= 0)
  ) {
    throw new Error(
      `Invalid config in ${source}: mcp.servers.${serverId}.maxListPages must be a positive integer.`
    );
  }

  const maxListItems = raw.maxListItems;
  if (
    maxListItems !== undefined &&
    (typeof maxListItems !== 'number' ||
      !Number.isInteger(maxListItems) ||
      maxListItems <= 0)
  ) {
    throw new Error(
      `Invalid config in ${source}: mcp.servers.${serverId}.maxListItems must be a positive integer.`
    );
  }

  return {
    transport: 'stdio',
    command: interpolateEnvironmentVariables(
      raw.command,
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
      typeof cwd === 'string'
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
  };
}

function parsePartialConfig(
  raw: unknown,
  source: string
): PartialDroneAgentConfig {
  if (!isRecord(raw)) {
    throw new Error(`Invalid config in ${source}: expected a JSON object.`);
  }

  const parsed: PartialDroneAgentConfig = {};

  if ('enabledPlugins' in raw) {
    if (
      !Array.isArray(raw.enabledPlugins) ||
      raw.enabledPlugins.some(item => typeof item !== 'string')
    ) {
      throw new Error(
        `Invalid config in ${source}: enabledPlugins must be an array of strings.`
      );
    }
    parsed.enabledPlugins = raw.enabledPlugins;
  }

  if ('systemPrompt' in raw) {
    if (typeof raw.systemPrompt !== 'string') {
      throw new Error(
        `Invalid config in ${source}: systemPrompt must be a string.`
      );
    }
    parsed.systemPrompt = raw.systemPrompt;
  }

  if ('ollama' in raw) {
    if (!isRecord(raw.ollama)) {
      throw new Error(`Invalid config in ${source}: ollama must be an object.`);
    }

    const ollama: PartialDroneAgentConfig['ollama'] = {};
    if ('host' in raw.ollama) {
      if (typeof raw.ollama.host !== 'string') {
        throw new Error(
          `Invalid config in ${source}: ollama.host must be a string.`
        );
      }
      ollama.host = raw.ollama.host;
    }
    if ('model' in raw.ollama) {
      if (typeof raw.ollama.model !== 'string') {
        throw new Error(
          `Invalid config in ${source}: ollama.model must be a string.`
        );
      }
      ollama.model = raw.ollama.model;
    }
    parsed.ollama = ollama;
  }

  if ('session' in raw) {
    if (!isRecord(raw.session)) {
      throw new Error(
        `Invalid config in ${source}: session must be an object.`
      );
    }

    const session: PartialDroneAgentConfig['session'] = {};
    if ('contextWindowTokens' in raw.session) {
      if (
        typeof raw.session.contextWindowTokens !== 'number' ||
        !Number.isFinite(raw.session.contextWindowTokens) ||
        raw.session.contextWindowTokens <= 0
      ) {
        throw new Error(
          `Invalid config in ${source}: session.contextWindowTokens must be a positive number.`
        );
      }
      session.contextWindowTokens = raw.session.contextWindowTokens;
    }
    if ('responseReserveTokens' in raw.session) {
      if (
        typeof raw.session.responseReserveTokens !== 'number' ||
        !Number.isFinite(raw.session.responseReserveTokens) ||
        raw.session.responseReserveTokens <= 0
      ) {
        throw new Error(
          `Invalid config in ${source}: session.responseReserveTokens must be a positive number.`
        );
      }
      session.responseReserveTokens = raw.session.responseReserveTokens;
    }
    if ('maxToolIterations' in raw.session) {
      if (
        typeof raw.session.maxToolIterations !== 'number' ||
        !Number.isFinite(raw.session.maxToolIterations) ||
        !Number.isInteger(raw.session.maxToolIterations) ||
        raw.session.maxToolIterations <= 0
      ) {
        throw new Error(
          `Invalid config in ${source}: session.maxToolIterations must be a positive integer.`
        );
      }
      session.maxToolIterations = raw.session.maxToolIterations;
    }
    if ('promptOnToolIterationLimit' in raw.session) {
      if (typeof raw.session.promptOnToolIterationLimit !== 'boolean') {
        throw new Error(
          `Invalid config in ${source}: session.promptOnToolIterationLimit must be a boolean.`
        );
      }
      session.promptOnToolIterationLimit =
        raw.session.promptOnToolIterationLimit;
    }
    parsed.session = session;
  }

  if ('lsp' in raw) {
    if (!isRecord(raw.lsp)) {
      throw new Error(`Invalid config in ${source}: lsp must be an object.`);
    }

    const lsp: PartialDroneAgentConfig['lsp'] = {};

    if ('enabled' in raw.lsp) {
      if (typeof raw.lsp.enabled !== 'boolean') {
        throw new Error(
          `Invalid config in ${source}: lsp.enabled must be a boolean.`
        );
      }
      lsp.enabled = raw.lsp.enabled;
    }

    if ('diagnosticTokenBudget' in raw.lsp) {
      if (
        typeof raw.lsp.diagnosticTokenBudget !== 'number' ||
        !Number.isFinite(raw.lsp.diagnosticTokenBudget) ||
        raw.lsp.diagnosticTokenBudget <= 0
      ) {
        throw new Error(
          `Invalid config in ${source}: lsp.diagnosticTokenBudget must be a positive number.`
        );
      }
      lsp.diagnosticTokenBudget = raw.lsp.diagnosticTokenBudget;
    }

    if ('requestTimeoutMs' in raw.lsp) {
      if (
        typeof raw.lsp.requestTimeoutMs !== 'number' ||
        !Number.isFinite(raw.lsp.requestTimeoutMs) ||
        raw.lsp.requestTimeoutMs <= 0
      ) {
        throw new Error(
          `Invalid config in ${source}: lsp.requestTimeoutMs must be a positive number.`
        );
      }
      lsp.requestTimeoutMs = raw.lsp.requestTimeoutMs;
    }

    if ('preferExternal' in raw.lsp) {
      if (typeof raw.lsp.preferExternal !== 'boolean') {
        throw new Error(
          `Invalid config in ${source}: lsp.preferExternal must be a boolean.`
        );
      }
      lsp.preferExternal = raw.lsp.preferExternal;
    }

    if ('autoInstall' in raw.lsp) {
      if (typeof raw.lsp.autoInstall !== 'boolean') {
        throw new Error(
          `Invalid config in ${source}: lsp.autoInstall must be a boolean.`
        );
      }
      lsp.autoInstall = raw.lsp.autoInstall;
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
      if (typeof raw.mcp.enabled !== 'boolean') {
        throw new Error(
          `Invalid config in ${source}: mcp.enabled must be a boolean.`
        );
      }
      mcp.enabled = raw.mcp.enabled;
    }

    if ('requestTimeoutMs' in raw.mcp) {
      if (
        typeof raw.mcp.requestTimeoutMs !== 'number' ||
        !Number.isFinite(raw.mcp.requestTimeoutMs) ||
        raw.mcp.requestTimeoutMs <= 0
      ) {
        throw new Error(
          `Invalid config in ${source}: mcp.requestTimeoutMs must be a positive number.`
        );
      }
      mcp.requestTimeoutMs = raw.mcp.requestTimeoutMs;
    }

    if ('retryCount' in raw.mcp) {
      if (
        typeof raw.mcp.retryCount !== 'number' ||
        !Number.isInteger(raw.mcp.retryCount) ||
        raw.mcp.retryCount < 0
      ) {
        throw new Error(
          `Invalid config in ${source}: mcp.retryCount must be a non-negative integer.`
        );
      }
      mcp.retryCount = raw.mcp.retryCount;
    }

    if ('retryDelayMs' in raw.mcp) {
      if (
        typeof raw.mcp.retryDelayMs !== 'number' ||
        !Number.isFinite(raw.mcp.retryDelayMs) ||
        raw.mcp.retryDelayMs < 0
      ) {
        throw new Error(
          `Invalid config in ${source}: mcp.retryDelayMs must be a non-negative number.`
        );
      }
      mcp.retryDelayMs = raw.mcp.retryDelayMs;
    }

    if ('maxListPages' in raw.mcp) {
      if (
        typeof raw.mcp.maxListPages !== 'number' ||
        !Number.isInteger(raw.mcp.maxListPages) ||
        raw.mcp.maxListPages <= 0
      ) {
        throw new Error(
          `Invalid config in ${source}: mcp.maxListPages must be a positive integer.`
        );
      }
      mcp.maxListPages = raw.mcp.maxListPages;
    }

    if ('maxListItems' in raw.mcp) {
      if (
        typeof raw.mcp.maxListItems !== 'number' ||
        !Number.isInteger(raw.mcp.maxListItems) ||
        raw.mcp.maxListItems <= 0
      ) {
        throw new Error(
          `Invalid config in ${source}: mcp.maxListItems must be a positive integer.`
        );
      }
      mcp.maxListItems = raw.mcp.maxListItems;
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
    if (raw.activePersona !== null && typeof raw.activePersona !== 'string') {
      throw new Error(
        `Invalid config in ${source}: activePersona must be a string or null.`
      );
    }
    parsed.activePersona = raw.activePersona;
  }

  if ('compaction' in raw) {
    if (!isRecord(raw.compaction)) {
      throw new Error(
        `Invalid config in ${source}: compaction must be an object.`
      );
    }

    const compaction: PartialDroneAgentConfig['compaction'] = {};

    if ('enabled' in raw.compaction) {
      if (typeof raw.compaction.enabled !== 'boolean') {
        throw new Error(
          `Invalid config in ${source}: compaction.enabled must be a boolean.`
        );
      }
      compaction.enabled = raw.compaction.enabled;
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
      if (
        typeof raw.compaction.softThresholdPercent !== 'number' ||
        !Number.isFinite(raw.compaction.softThresholdPercent) ||
        raw.compaction.softThresholdPercent <= 0 ||
        raw.compaction.softThresholdPercent > 100
      ) {
        throw new Error(
          `Invalid config in ${source}: compaction.softThresholdPercent must be a number between 0 and 100.`
        );
      }
      compaction.softThresholdPercent = raw.compaction.softThresholdPercent;
    }

    if ('slicePercent' in raw.compaction) {
      if (
        typeof raw.compaction.slicePercent !== 'number' ||
        !Number.isFinite(raw.compaction.slicePercent) ||
        raw.compaction.slicePercent <= 0 ||
        raw.compaction.slicePercent > 100
      ) {
        throw new Error(
          `Invalid config in ${source}: compaction.slicePercent must be a number between 0 and 100.`
        );
      }
      compaction.slicePercent = raw.compaction.slicePercent;
    }

    if ('minTurnsToCompact' in raw.compaction) {
      if (
        typeof raw.compaction.minTurnsToCompact !== 'number' ||
        !Number.isInteger(raw.compaction.minTurnsToCompact) ||
        raw.compaction.minTurnsToCompact < 1
      ) {
        throw new Error(
          `Invalid config in ${source}: compaction.minTurnsToCompact must be a positive integer.`
        );
      }
      compaction.minTurnsToCompact = raw.compaction.minTurnsToCompact;
    }

    if ('summaryMaxTokens' in raw.compaction) {
      if (
        typeof raw.compaction.summaryMaxTokens !== 'number' ||
        !Number.isFinite(raw.compaction.summaryMaxTokens) ||
        raw.compaction.summaryMaxTokens <= 0
      ) {
        throw new Error(
          `Invalid config in ${source}: compaction.summaryMaxTokens must be a positive number.`
        );
      }
      compaction.summaryMaxTokens = raw.compaction.summaryMaxTokens;
    }

    if ('summaryBudgetPercent' in raw.compaction) {
      if (
        typeof raw.compaction.summaryBudgetPercent !== 'number' ||
        !Number.isFinite(raw.compaction.summaryBudgetPercent) ||
        raw.compaction.summaryBudgetPercent <= 0 ||
        raw.compaction.summaryBudgetPercent > 100
      ) {
        throw new Error(
          `Invalid config in ${source}: compaction.summaryBudgetPercent must be a number between 0 and 100.`
        );
      }
      compaction.summaryBudgetPercent = raw.compaction.summaryBudgetPercent;
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
      if (typeof raw.memory.enabled !== 'boolean') {
        throw new Error(
          `Invalid config in ${source}: memory.enabled must be a boolean.`
        );
      }
      memory.enabled = raw.memory.enabled;
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
      if (typeof raw.log.enabled !== 'boolean') {
        throw new Error(
          `Invalid config in ${source}: log.enabled must be a boolean.`
        );
      }
      log.enabled = raw.log.enabled;
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
      if (typeof raw.promptFile.enabled !== 'boolean') {
        throw new Error(
          `Invalid config in ${source}: promptFile.enabled must be a boolean.`
        );
      }
      promptFile.enabled = raw.promptFile.enabled;
    }

    if ('files' in raw.promptFile) {
      if (!isStringArray(raw.promptFile.files)) {
        throw new Error(
          `Invalid config in ${source}: promptFile.files must be an array of strings.`
        );
      }
      promptFile.files = raw.promptFile.files;
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

async function loadConfigLayer(
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

async function findProjectConfigPath(
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
