import { isRecord } from '../../shared/type-guards.js';
import type {
  DroneMcpServerState,
  DronePlugin,
  DroneToolJsonSchema,
  DroneToolJsonSchemaProperty,
} from 'drone-core';
import {
  createMcpClientConnection,
  type McpClientConnection,
  type McpToolMeta,
} from './client.js';

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

function sanitizeToolSegment(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export const mcpPlugin: DronePlugin = {
  metadata: {
    id: 'mcp',
    name: 'MCP',
    version: '0.1.0',
    description:
      'Connects to MCP servers and mounts their tools/resources/prompts.',
    defaultEnabled: true,
  },
  register: async registration => {
    const mcpConfig = registration.getConfig().mcp;
    const connections = new Map<string, McpClientConnection>();
    const serverStates = new Map<string, DroneMcpServerState>();
    const mountedToolNames = new Set<string>();

    function setServerState(state: DroneMcpServerState): void {
      serverStates.set(state.id, { ...state });
    }

    function registerMountedTool(
      name: string,
      description: string,
      inputSchema: DroneToolJsonSchema | undefined,
      execute: (input: Record<string, unknown>) => Promise<string>
    ): void {
      if (mountedToolNames.has(name)) {
        registration.logger.warn(
          `mcp tool name already mounted, skipping duplicate: ${name}`
        );
        return;
      }

      mountedToolNames.add(name);
      registration.registerTool({
        name,
        description,
        inputSchema,
        execute,
      });
    }

    function mountResourcePromptTools(
      serverId: string,
      connection: McpClientConnection
    ): void {
      registerMountedTool(
        `${serverId}.list_resources`,
        `List MCP resources for server ${serverId}.`,
        { type: 'object', additionalProperties: false },
        async () => {
          const resources = await connection.listResources();
          return JSON.stringify({ serverId, resources }, null, 2);
        }
      );

      registerMountedTool(
        `${serverId}.read_resource`,
        `Read an MCP resource by URI from server ${serverId}.`,
        {
          type: 'object',
          properties: {
            uri: {
              type: 'string',
              description: 'Resource URI to read.',
            },
          },
          required: ['uri'],
          additionalProperties: false,
        },
        async input => {
          if (typeof input.uri !== 'string' || input.uri.trim().length === 0) {
            throw new Error(
              `mcp.${serverId}.read_resource requires a non-empty uri string.`
            );
          }
          const result = await connection.readResource(input.uri);
          return JSON.stringify({ serverId, uri: input.uri, result }, null, 2);
        }
      );

      registerMountedTool(
        `${serverId}.list_prompts`,
        `List MCP prompts for server ${serverId}.`,
        { type: 'object', additionalProperties: false },
        async () => {
          const prompts = await connection.listPrompts();
          return JSON.stringify({ serverId, prompts }, null, 2);
        }
      );

      registerMountedTool(
        `${serverId}.get_prompt`,
        `Get an MCP prompt from server ${serverId}.`,
        {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Prompt name to fetch.',
            },
            arguments: {
              type: 'object',
              description: 'Optional prompt argument object.',
              additionalProperties: true,
            },
          },
          required: ['name'],
          additionalProperties: false,
        },
        async input => {
          if (
            typeof input.name !== 'string' ||
            input.name.trim().length === 0
          ) {
            throw new Error(
              `mcp.${serverId}.get_prompt requires a non-empty name string.`
            );
          }
          const args = isRecord(input.arguments)
            ? (input.arguments as Record<string, unknown>)
            : undefined;
          const result = await connection.getPrompt(input.name, args);
          return JSON.stringify(
            { serverId, name: input.name, result },
            null,
            2
          );
        }
      );
    }

    function mountMcpTools(
      serverId: string,
      connection: McpClientConnection,
      tools: McpToolMeta[]
    ): void {
      for (const tool of tools) {
        const mountedName = `${serverId}.${sanitizeToolSegment(tool.name)}`;
        registerMountedTool(
          mountedName,
          tool.description ?? `MCP tool ${tool.name} from server ${serverId}.`,
          toDroneInputSchema(tool.inputSchema),
          async input => {
            const result = await connection.callTool(tool.name, input);
            return JSON.stringify(
              {
                serverId,
                tool: tool.name,
                result,
              },
              null,
              2
            );
          }
        );
      }
    }

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

      for (const [serverId, serverConfig] of configuredServers) {
        try {
          const connection = await createMcpClientConnection({
            serverId,
            config: serverConfig,
            defaultRequestTimeoutMs: mcpConfig.requestTimeoutMs,
            defaultRetryCount: mcpConfig.retryCount,
            defaultRetryDelayMs: mcpConfig.retryDelayMs,
            defaultMaxListPages: mcpConfig.maxListPages,
            defaultMaxListItems: mcpConfig.maxListItems,
            defaultCompatibilityMode: mcpConfig.compatibilityMode,
            logger: registration.logger,
          });
          connections.set(serverId, connection);
          setServerState(connection.state);

          const tools = await connection.listTools();
          const allowlist = serverConfig.allowedTools;
          const allowedToolSet = allowlist ? new Set(allowlist) : undefined;
          const mountedTools = allowedToolSet
            ? tools.filter((tool: McpToolMeta) => allowedToolSet.has(tool.name))
            : tools;

          connection.state.discoveredToolCount = tools.length;
          connection.state.filteredToolCount =
            tools.length - mountedTools.length;
          connection.state.mountedToolCount = mountedTools.length;

          mountMcpTools(serverId, connection, mountedTools);
          mountResourcePromptTools(serverId, connection);
          setServerState(connection.state);

          registration.logger.info(
            `mcp server ready: ${serverId} (${connection.state.transport}, mounted ${mountedTools.length}/${tools.length} tool(s))`
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
