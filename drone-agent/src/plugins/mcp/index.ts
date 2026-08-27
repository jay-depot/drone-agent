import { isRecord } from '../../shared/type-guards.js';
import os from 'node:os';
import type {
  DroneLlmCapability,
  DroneMcpRoot,
  DroneMcpServerState,
  DronePersonaCapability,
  DronePlugin,
  DroneToolJsonSchema,
  DroneToolJsonSchemaProperty,
  DroneToolDefinition,
} from 'drone-core';
import {
  createMcpClientConnection,
  splitToolResultBlocks,
  type McpClientConnection,
  type McpToolMeta,
} from './client.js';
import { getOrCreateServerDescription } from './server-description.js';

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
    const llmCapability = registration.request<DroneLlmCapability>('llm');
    const personaCap = registration.request<DronePersonaCapability>('persona');

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

    async function listAndMountTools(
      serverId: string,
      connection: McpClientConnection,
      serverConfig: { allowedTools?: string[] },
      logMessage: string
    ): Promise<void> {
      const tools = await connection.listTools();
      const allowlist = serverConfig.allowedTools;
      const allowedToolSet = allowlist ? new Set(allowlist) : undefined;

      // Generate server description via LLM (if available)
      const serverDescription = await getOrCreateServerDescription(
        serverId,
        tools.map(t => ({ name: t.name, description: t.description })),
        llmCapability,
        registration.logger
      );

      // Create a fresh tool map for this server
      const toolMap = new Map<
        string,
        { definition: DroneToolDefinition; mounted: boolean }
      >();
      const usedNames = new Set<string>();
      for (const tool of tools) {
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
        toolMap.set(tool.name, { definition: toolDef, mounted: false });
        // Register the tool with the engine (unmounted) so it appears in runtime__list_tools
        registration.registerTool(toolDef);
      }
      serverToolMaps.set(serverId, toolMap);
      serverUsedNames.set(serverId, usedNames);
      serverAllowlists.set(serverId, allowedToolSet);

      const allowlistedCount = allowedToolSet
        ? tools.filter((t: McpToolMeta) => allowedToolSet.has(t.name)).length
        : tools.length;

      connection.state.filteredToolCount = tools.length - allowlistedCount;
      connection.state.mountedToolCount = 0;

      registerResourcePromptTools(serverId, connection);
      setServerState(connection.state);

      registration.logger.info(
        `mcp server ${logMessage}: ${serverId} (discovered ${connection.state.discoveredToolCount} tool(s), mounted ${connection.state.mountedToolCount})`
      );
    }

    async function handleToolsListChanged(
      serverId: string,
      connection: McpClientConnection
    ): Promise<void> {
      const toolMap = serverToolMaps.get(serverId);
      if (!toolMap) return;
      const usedNames = serverUsedNames.get(serverId) ?? new Set<string>();

      const oldToolNames = new Set(toolMap.keys());

      const tools = await connection.listTools();
      const newToolNames = new Set(tools.map(t => t.name));

      // Remove tools that no longer exist on the server
      for (const oldName of oldToolNames) {
        if (!newToolNames.has(oldName)) {
          const entry = toolMap.get(oldName);
          if (entry?.mounted) {
            entry.mounted = false;
            registration.unregisterTool(`mcp__${entry.definition.name}`);
          }
          toolMap.delete(oldName);
          if (entry) {
            usedNames.delete(entry.definition.name);
          }
        }
      }
      // Add new tools
      for (const tool of tools) {
        if (!oldToolNames.has(tool.name)) {
          const mountedName = `${serverId}__${sanitizeToolSegment(tool.name, usedNames)}`;
          const toolDef: DroneToolDefinition = {
            name: mountedName,
            description:
              tool.description ??
              `MCP tool ${tool.name} from server ${serverId}.`,
            inputSchema: toDroneInputSchema(tool.inputSchema),
            execute: async toolInput => {
              const result = await connection.callTool(tool.name, toolInput);
              return JSON.stringify(
                { serverId, tool: tool.name, result },
                null,
                2
              );
            },
          };
          toolMap.set(tool.name, { definition: toolDef, mounted: false });
          // Register the new tool with the engine (unmounted)
          registration.registerTool(toolDef);
        }
      }

      connection.state.discoveredToolCount = tools.length;
      connection.state.mountedToolCount = Array.from(toolMap.values()).filter(
        e => e.mounted
      ).length;
      setServerState(connection.state);

      registration.logger.info(
        `mcp server ${serverId} tools list changed (discovered ${connection.state.discoveredToolCount}, mounted ${connection.state.mountedToolCount})`
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
            void handleToolsListChanged(serverId, connection);
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
          // Clear the existing cache and rebuild from scratch
          const oldMap = serverToolMaps.get(serverId);
          if (oldMap) {
            for (const [, entry] of oldMap) {
              // Remove from engine registry (whether mounted or not)
              registration.unregisterTool(`mcp__${entry.definition.name}`);
            }
          }
          await listAndMountTools(
            serverId,
            connection,
            serverConfig,
            'reconnected'
          );
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
            logger: registration.logger,
            roots,
          });
          connections.set(serverId, connection);
          setServerState(connection.state);

          await listAndMountTools(serverId, connection, serverConfig, 'ready');

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
      for (const connection of connections.values()) {
        await connection.disconnect();
        setServerState(connection.state);
      }
    });
  },
};
