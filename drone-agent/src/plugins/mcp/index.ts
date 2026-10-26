import { isRecord } from '../../shared/type-guards.js';
import os from 'node:os';
import { withKeyLock } from '../../shared/keyed-lock.js';
import { getCanonicalToolName } from 'drone-core';
import type {
  DroneLlmCapability,
  DroneMcpRoot,
  DroneMcpServerState,
  DronePersonaCapability,
  DronePlugin,
  DroneToolJsonSchema,
  DroneToolJsonSchemaProperty,
  DroneToolDescriptor,
  DroneToolDefinition,
} from 'drone-core';
import {
  createMcpClientConnection,
  splitToolResultBlocks,
  type McpClientConnection,
  type McpToolMeta,
} from './client.js';
import {
  getOrCreateServerDescription,
  readCachedDescriptions,
} from './server-description.js';
import {
  renderServerSection,
  renderStatusSection,
  type McpServerSummary,
} from './prompt-fragments.js';

const TOOL_PROPERTY_TYPES: DroneToolJsonSchemaProperty['type'][] = [
  'string',
  'number',
  'integer',
  'boolean',
  'object',
  'array',
];

function toToolPropertySchema(
  value: unknown
): DroneToolJsonSchemaProperty | undefined {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return undefined;
  }

  const propertyType = value.type;
  if (
    !TOOL_PROPERTY_TYPES.includes(
      propertyType as DroneToolJsonSchemaProperty['type']
    )
  ) {
    return undefined;
  }

  const propertySchema: DroneToolJsonSchemaProperty = {
    type: propertyType as DroneToolJsonSchemaProperty['type'],
  };

  if (typeof value.description === 'string') {
    propertySchema.description = value.description;
  }

  if (propertyType === 'object') {
    if (isRecord(value.properties)) {
      const nested: Record<string, DroneToolJsonSchemaProperty> = {};
      for (const [nestedKey, nestedValue] of Object.entries(value.properties)) {
        const nestedSchema = toToolPropertySchema(nestedValue);
        if (nestedSchema) {
          nested[nestedKey] = nestedSchema;
        }
      }
      if (Object.keys(nested).length > 0) {
        propertySchema.properties = nested;
      }
    }
    if (Array.isArray(value.required)) {
      const required = value.required.filter(item => typeof item === 'string');
      if (required.length > 0) {
        propertySchema.required = required;
      }
    }
    if (typeof value.additionalProperties === 'boolean') {
      propertySchema.additionalProperties = value.additionalProperties;
    }
  }

  if (propertyType === 'array') {
    const itemSchema = toToolPropertySchema(value.items);
    if (itemSchema) {
      propertySchema.items = itemSchema;
    }
  }

  return propertySchema;
}

function toDroneInputSchema(
  rawSchema: unknown
): DroneToolJsonSchema | undefined {
  if (!isRecord(rawSchema) || rawSchema.type !== 'object') {
    return {
      type: 'object',
      additionalProperties: true,
    };
  }

  const properties: Record<string, DroneToolJsonSchemaProperty> = {};
  if (isRecord(rawSchema.properties)) {
    for (const [key, value] of Object.entries(rawSchema.properties)) {
      const propertySchema = toToolPropertySchema(value);
      if (propertySchema) {
        properties[key] = propertySchema;
      }
    }
  }

  const required = Array.isArray(rawSchema.required)
    ? rawSchema.required.filter(item => typeof item === 'string')
    : undefined;
  const additionalProperties =
    typeof rawSchema.additionalProperties === 'boolean'
      ? rawSchema.additionalProperties
      : true;

  return {
    type: 'object',
    properties: Object.keys(properties).length > 0 ? properties : undefined,
    required: required && required.length > 0 ? required : undefined,
    additionalProperties,
  };
}

function sanitizeToolSegment(name: string, usedNames: Set<string>): string {
  const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, '_');
  if (!usedNames.has(sanitized)) {
    usedNames.add(sanitized);
    return sanitized;
  }
  // Collision — append a numeric suffix until unique
  let counter = 1;
  while (usedNames.has(`${sanitized}_${counter}`)) {
    counter++;
  }
  const result = `${sanitized}_${counter}`;
  usedNames.add(result);
  return result;
}

export const mcpPlugin: DronePlugin = {
  metadata: {
    id: 'mcp',
    name: 'MCP',
    version: '0.1.0',
    description:
      'Connects to MCP servers and mounts their tools/resources/prompts.',
    defaultEnabled: true,
    dependencies: [
      { id: 'llm', optional: true },
      { id: 'persona', optional: true },
    ],
  },
  register: async registration => {
    const mcpConfig = registration.getConfig().mcp;
    const sessionConfig = registration.getConfig().session;
    // 10% of context window as byte limit (1 token ≈ 4 bytes), min 1MB
    const defaultMaxResponseSizeBytes = Math.max(
      1024 * 1024,
      Math.round((sessionConfig?.contextWindowTokens ?? 32768) * 4 * 0.1)
    );
    const connections = new Map<string, McpClientConnection>();
    const serverStates = new Map<string, DroneMcpServerState>();
    const serverToolMaps = new Map<
      string,
      Map<string, { definition: DroneToolDefinition; mounted: boolean }>
    >();
    const serverUsedNames = new Map<string, Set<string>>();
    const serverAllowlists = new Map<string, Set<string> | undefined>();
    const serverDescriptions = new Map<string, string>();
    const registeredResourceServers = new Set<string>();
    const llmCapability = registration.request<DroneLlmCapability>('llm');

    function setServerState(state: DroneMcpServerState): void {
      serverStates.set(state.id, { ...state });
    }

    function registerResourcePromptTools(
      serverId: string,
      connection: McpClientConnection
    ): void {
      registration.registerTool({
        name: `${serverId}__list`,
        description:
          `List MCP resources, resource templates, or prompts for server ${serverId}. ` +
          `Use type="resources", type="resource_templates", or type="prompts".`,
        inputSchema: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              enum: ['resources', 'resource_templates', 'prompts'],
              description:
                'What to list: resources, resource_templates, or prompts.',
            },
          },
          required: ['type'],
          additionalProperties: false,
        },
        execute: async input => {
          const listType = input.type as string;
          if (listType === 'resources') {
            const resources = await connection.listResources();
            return JSON.stringify({ serverId, resources }, null, 2);
          }
          if (listType === 'resource_templates') {
            const templates = await connection.listResourceTemplates();
            return JSON.stringify({ serverId, templates }, null, 2);
          }
          if (listType === 'prompts') {
            const prompts = await connection.listPrompts();
            return JSON.stringify({ serverId, prompts }, null, 2);
          }
          throw new Error(`Unknown list type: ${listType}`);
        },
      });

      registration.registerTool({
        name: `${serverId}__get`,
        description:
          `Get an MCP resource or prompt from server ${serverId}. ` +
          `Use type="resource" with a uri to read a resource. ` +
          `Use type="prompt" with a name (and optional arguments) to get a prompt.`,
        inputSchema: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              enum: ['resource', 'prompt'],
              description: 'What to get: resource or prompt.',
            },
            uri: {
              type: 'string',
              description:
                'Resource URI to read (required for type="resource").',
            },
            name: {
              type: 'string',
              description: 'Prompt name to fetch (required for type="prompt").',
            },
            arguments: {
              type: 'object',
              description:
                'Optional prompt argument object (for type="prompt").',
              additionalProperties: true,
            },
          },
          required: ['type'],
          additionalProperties: false,
        },
        execute: async input => {
          const getType = input.type as string;
          if (getType === 'resource') {
            const uri = input.uri as string;
            if (typeof uri !== 'string' || uri.trim().length === 0) {
              throw new Error(
                `mcp__${serverId}__get requires a non-empty uri for type="resource".`
              );
            }
            const result = await connection.readResource(uri);
            return JSON.stringify({ serverId, uri, result }, null, 2);
          }
          if (getType === 'prompt') {
            const name = input.name as string;
            if (typeof name !== 'string' || name.trim().length === 0) {
              throw new Error(
                `mcp__${serverId}__get requires a non-empty name for type="prompt".`
              );
            }
            const args = isRecord(input.arguments)
              ? (input.arguments as Record<string, unknown>)
              : undefined;
            const result = await connection.getPrompt(name, args);
            return JSON.stringify({ serverId, name, result }, null, 2);
          }
          throw new Error(`Unknown get type: ${getType}`);
        },
      });
    }

    /**
     * Idempotent, surgical reconcile of a server's tools against the engine
     * registry. Unregisters only tools that vanished, registers only tools
     * that appeared, and leaves persisting tools untouched so their engine
     * mount state is preserved. Callers serialize via `withKeyLock`.
     */
    async function reconcileServerTools(
      serverId: string,
      connection: McpClientConnection,
      serverConfig: { allowedTools?: string[] },
      logMessage: string
    ): Promise<void> {
      const tools = await connection.listTools();
      const allowlist = serverConfig.allowedTools;
      const allowedToolSet = allowlist ? new Set(allowlist) : undefined;

      const description = await getOrCreateServerDescription(
        serverId,
        tools.map(t => ({ name: t.name, description: t.description })),
        llmCapability,
        registration.logger
      );
      if (description) serverDescriptions.set(serverId, description);

      const oldMap =
        serverToolMaps.get(serverId) ??
        new Map<
          string,
          { definition: DroneToolDefinition; mounted: boolean }
        >();
      const usedNames = serverUsedNames.get(serverId) ?? new Set<string>();
      const newMap = new Map<
        string,
        { definition: DroneToolDefinition; mounted: boolean }
      >();

      const newNames = new Set(tools.map(t => t.name));
      for (const [oldName, entry] of oldMap) {
        if (!newNames.has(oldName)) {
          registration.unregisterTool(`mcp__${entry.definition.name}`);
          usedNames.delete(entry.definition.name);
        }
      }
      for (const tool of tools) {
        const existing = oldMap.get(tool.name);
        if (existing) {
          newMap.set(tool.name, existing);
          continue;
        }
        const mountedName = `${serverId}__${sanitizeToolSegment(tool.name, usedNames)}`;
        const toolDef: DroneToolDefinition = {
          name: mountedName,
          description:
            tool.description ??
            `MCP tool ${tool.name} from server ${serverId}.`,
          inputSchema: toDroneInputSchema(tool.inputSchema),
          execute: async toolInput => {
            const result = await connection.callTool(tool.name, toolInput);
            return splitToolResultBlocks(result);
          },
        };
        registration.registerTool(toolDef);
        newMap.set(tool.name, { definition: toolDef, mounted: false });
      }
      serverToolMaps.set(serverId, newMap);
      serverUsedNames.set(serverId, usedNames);
      serverAllowlists.set(serverId, allowedToolSet);

      const allowlistedCount = allowedToolSet
        ? tools.filter((t: McpToolMeta) => allowedToolSet.has(t.name)).length
        : tools.length;

      connection.state.discoveredToolCount = tools.length;
      connection.state.filteredToolCount = tools.length - allowlistedCount;
      connection.state.mountedToolCount = Array.from(newMap.values()).filter(
        e => e.mounted
      ).length;

      if (!registeredResourceServers.has(serverId)) {
        registerResourcePromptTools(serverId, connection);
        registeredResourceServers.add(serverId);
      }
      setServerState(connection.state);

      registration.logger.info(
        `mcp server ${logMessage}: ${serverId} (discovered ${connection.state.discoveredToolCount} tool(s), mounted ${connection.state.mountedToolCount})`
      );
    }

    function collectServerSummaries(): McpServerSummary[] {
      const personaCap =
        registration.request<DronePersonaCapability>('persona');
      const summaries: McpServerSummary[] = [];
      for (const serverId of Object.keys(mcpConfig.servers)) {
        const state = serverStates.get(serverId);
        if (!state) continue;
        const descriptors: DroneToolDescriptor[] = Array.from(
          serverToolMaps.get(serverId)?.values() ?? []
        ).map(entry => ({
          name: getCanonicalToolName('mcp', entry.definition.name),
          description: entry.definition.description,
          defaultHidden: false,
          alwaysVisible: entry.definition.alwaysVisible,
        }));
        const visible = personaCap
          ? personaCap.getFilteredTools(descriptors)
          : descriptors.filter(d => !d.defaultHidden);
        summaries.push({
          id: serverId,
          state,
          description: serverDescriptions.get(serverId),
          availableToolCount: visible.length,
        });
      }
      return summaries;
    }

    registration.registerPromptFragment({
      key: 'mcp-servers',
      phase: 'header',
      render: async () => renderServerSection(collectServerSummaries()),
    });

    registration.registerPromptFragment({
      key: 'mcp-server-status',
      phase: 'footer',
      render: async () => renderStatusSection(collectServerSummaries()),
    });

    async function handleToolsListChanged(
      serverId: string,
      connection: McpClientConnection,
      serverConfig: { allowedTools?: string[] }
    ): Promise<void> {
      if (!serverToolMaps.has(serverId)) return;
      await withKeyLock(`mcp:${serverId}`, () =>
        reconcileServerTools(
          serverId,
          connection,
          serverConfig,
          'tools list changed'
        )
      );
    }

    // Register server_status once at plugin registration time
    registration.registerTool({
      name: 'server_status',
      description:
        'List MCP server connection state and mounted tool counts for this session.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
      },
      execute: async () =>
        JSON.stringify(
          {
            servers: Array.from(serverStates.values()),
          },
          null,
          2
        ),
    });

    registration.hooks.onPluginsLoaded(async () => {
      if (!mcpConfig.enabled) {
        registration.logger.info('mcp runtime disabled by config');
        return;
      }

      const configuredServers = Object.entries(mcpConfig.servers);
      if (configuredServers.length === 0) {
        registration.logger.info('mcp enabled but no servers configured');
        return;
      }

      const cachedDescriptions = await readCachedDescriptions();
      for (const [serverId, description] of Object.entries(
        cachedDescriptions
      )) {
        if (!serverDescriptions.has(serverId)) {
          serverDescriptions.set(serverId, description);
        }
      }

      const defaultRoots: DroneMcpRoot[] = [
        { uri: `file://${process.cwd()}`, name: 'Project Root' },
        { uri: `file://${os.homedir()}`, name: 'Home Directory' },
      ];
      const roots = [...defaultRoots, ...(mcpConfig.roots ?? [])];

      for (const [serverId, serverConfig] of configuredServers) {
        let connection: McpClientConnection | undefined;
        const onNotification = (method: string, params: unknown): void => {
          if (method === 'notifications/message') {
            const msg = params as {
              level?: string;
              logger?: string;
              data?: unknown;
            };
            const level = msg?.level ?? 'info';
            const loggerName = msg?.logger ? ` [${msg.logger}]` : '';
            const dataStr =
              typeof msg?.data === 'string'
                ? msg.data
                : JSON.stringify(msg?.data);
            const message = `mcp server ${serverId} log${loggerName}: ${dataStr}`;
            switch (level) {
              case 'warning':
                registration.logger.warn(message);
                break;
              case 'error':
                registration.logger.error(message);
                break;
              case 'debug':
              case 'info':
              default:
                registration.logger.info(message);
                break;
            }
            return;
          }
          registration.logger.info(
            `mcp server ${serverId} notification: ${method}`
          );
          if (method === 'notifications/tools/list_changed' && connection) {
            void handleToolsListChanged(serverId, connection, serverConfig);
          }
        };
        const onStreamError = (message: string): void => {
          registration.logger.warn(
            `mcp server ${serverId} stream error: ${message}`
          );
          if (connection) {
            connection.state.streaming = false;
            connection.state.lastStreamError = message;
            setServerState(connection.state);
          }
        };
        const onReconnected = async (): Promise<void> => {
          if (!connection) return;
          await withKeyLock(`mcp:${serverId}`, () =>
            reconcileServerTools(
              serverId,
              connection!,
              serverConfig,
              'reconnected'
            )
          );
        };
        const onStreamOpened = (): void => {
          if (!connection) return;
          connection.state.streaming = true;
          connection.state.lastStreamError = undefined;
          setServerState(connection.state);
        };
        try {
          connection = await createMcpClientConnection({
            serverId,
            config: serverConfig,
            defaultRequestTimeoutMs: mcpConfig.requestTimeoutMs,
            defaultSpawnTimeoutMs: mcpConfig.spawnTimeoutMs,
            defaultRetryCount: mcpConfig.retryCount,
            defaultRetryDelayMs: mcpConfig.retryDelayMs,
            defaultMaxListPages: mcpConfig.maxListPages,
            defaultMaxListItems: mcpConfig.maxListItems,
            defaultCompatibilityMode: mcpConfig.compatibilityMode,
            defaultMaxResponseSizeBytes,
            onNotification,
            onStreamError,
            onReconnected,
            onStreamOpened,
            logger: registration.logger,
            roots,
          });
          connections.set(serverId, connection);
          setServerState(connection.state);

          await withKeyLock(`mcp:${serverId}`, () =>
            reconcileServerTools(serverId, connection!, serverConfig, 'ready')
          );

          registration.logger.info(
            `mcp server ready: ${serverId} (${connection.state.transport}, discovered ${connection.state.discoveredToolCount}, mounted ${connection.state.mountedToolCount} tool(s))`
          );
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          registration.logger.warn(
            `mcp server unavailable: ${serverId} (${message})`
          );
          setServerState({
            id: serverId,
            transport:
              serverConfig.transport === 'streamable_http'
                ? 'streamable_http'
                : 'stdio',
            ownership:
              serverConfig.transport === 'streamable_http'
                ? 'external'
                : 'spawned',
            status: 'error',
            detail:
              serverConfig.transport === 'streamable_http'
                ? serverConfig.url
                : `${serverConfig.command}${
                    serverConfig.args && serverConfig.args.length > 0
                      ? ` ${serverConfig.args.join(' ')}`
                      : ''
                  }`,
            discoveredToolCount: 0,
            mountedToolCount: 0,
            filteredToolCount: 0,
            toolsListTruncated: false,
            resourcesListTruncated: false,
            promptsListTruncated: false,
            compatibilityMode:
              serverConfig.transport === 'streamable_http'
                ? (serverConfig.compatibilityMode ??
                  mcpConfig.compatibilityMode)
                : undefined,
            retryCount: serverConfig.retryCount ?? mcpConfig.retryCount,
            retryAttemptCount: 0,
            lastErrorCategory: 'unknown',
            lastError: message,
          });
        }
      }
    });

    registration.hooks.onShutdown(async () => {
      await Promise.all(
        [...connections.values()].map(connection => connection.disconnect())
      );
      for (const connection of connections.values()) {
        setServerState(connection.state);
      }
    });
  },
};
