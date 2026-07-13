import { isRecord } from '../../shared/type-guards.js';
import type {
  DroneLlmCapability,
  DroneMcpServerState,
  DronePersonaCapability,
  DronePlugin,
  DroneToolJsonSchema,
  DroneToolJsonSchemaProperty,
  DroneToolDefinition,
} from 'drone-core';
import { ToolMountingCache } from 'drone-core';
import {
  createMcpClientConnection,
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
    dependencies: [
      { id: 'llm', optional: true },
      { id: 'persona', optional: true },
    ],
  },
  register: async registration => {
    const mcpConfig = registration.getConfig().mcp;
    const connections = new Map<string, McpClientConnection>();
    const serverStates = new Map<string, DroneMcpServerState>();
    const serverCaches = new Map<string, ToolMountingCache>();
    const serverAllowlists = new Map<string, Set<string> | undefined>();
    const metaToolNames = new Set<string>();
    const llmCapability = registration.request<DroneLlmCapability>('llm');
    const personaCap = registration.request<DronePersonaCapability>('persona');

    function setServerState(state: DroneMcpServerState): void {
      serverStates.set(state.id, { ...state });
    }

    function registerMetaTool(
      name: string,
      description: string,
      inputSchema: DroneToolJsonSchema | undefined,
      execute: (input: Record<string, unknown>) => Promise<string>
    ): void {
      if (metaToolNames.has(name)) {
        return;
      }
      metaToolNames.add(name);
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
      registerMetaTool(
        `${serverId}__list_resources`,
        `List MCP resources for server ${serverId}.`,
        { type: 'object', additionalProperties: false },
        async () => {
          const resources = await connection.listResources();
          return JSON.stringify({ serverId, resources }, null, 2);
        }
      );

      registerMetaTool(
        `${serverId}__read_resource`,
        `Read an MCP resource by URI from server ${serverId}. Accepts both concrete resource URIs and URIs produced by substituting variables into a resource template from ${serverId}__list_resource_templates.`,
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
              `mcp__${serverId}__read_resource requires a non-empty uri string.`
            );
          }
          const result = await connection.readResource(input.uri);
          return JSON.stringify({ serverId, uri: input.uri, result }, null, 2);
        }
      );

      registerMetaTool(
        `${serverId}__list_resource_templates`,
        `List MCP resource templates for server ${serverId}. Each template has a uriTemplate (RFC 6570) with variables to substitute, then read with ${serverId}__read_resource.`,
        { type: 'object', additionalProperties: false },
        async () => {
          const templates = await connection.listResourceTemplates();
          return JSON.stringify({ serverId, templates }, null, 2);
        }
      );

      registerMetaTool(
        `${serverId}__list_prompts`,
        `List MCP prompts for server ${serverId}.`,
        { type: 'object', additionalProperties: false },
        async () => {
          const prompts = await connection.listPrompts();
          return JSON.stringify({ serverId, prompts }, null, 2);
        }
      );

      registerMetaTool(
        `${serverId}__get_prompt`,
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
              `mcp__${serverId}__get_prompt requires a non-empty name string.`
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

    function mountMetaTools(
      serverId: string,
      connection: McpClientConnection,
      serverDescription?: string
    ): void {
      const listToolsDescription = serverDescription
        ? `List all available tools for MCP server ${serverId}. Returns tool names and descriptions. Use ${serverId}__mount_tool to mount a tool before calling it.\n\nServer summary: ${serverDescription}`
        : `List all available tools for MCP server ${serverId}. Returns tool names and descriptions. Use ${serverId}__mount_tool to mount a tool before calling it.`;

      registerMetaTool(
        `${serverId}__list_tools`,
        listToolsDescription,
        { type: 'object', additionalProperties: false },
        async () => {
          const cache = serverCaches.get(serverId);
          if (!cache) {
            return JSON.stringify({ serverId, tools: [] }, null, 2);
          }
          let tools = cache.listAvailable();
          // Filter through persona capability if available
          if (personaCap) {
            const descriptors = tools.map(t => ({
              name: t.name,
              description: t.description,
              inputSchema: undefined,
              defaultHidden: false,
            }));
            const filtered = personaCap.getFilteredTools(descriptors);
            const filteredNames = new Set(filtered.map(t => t.name));
            tools = tools.filter(t => filteredNames.has(t.name));
          }
          return JSON.stringify(
            { serverId, toolCount: tools.length, tools },
            null,
            2
          );
        }
      );

      registerMetaTool(
        `${serverId}__mount_tool`,
        `Mount a specific tool from MCP server ${serverId} so it becomes available as a native tool. Use ${serverId}__list_tools to see available tools. Once mounted, the tool will appear in your tool list with its full schema.`,
        {
          type: 'object',
          properties: {
            tool: {
              type: 'string',
              description: `The name of the tool to mount (as shown by ${serverId}__list_tools).`,
            },
          },
          required: ['tool'],
          additionalProperties: false,
        },
        async input => {
          if (
            typeof input.tool !== 'string' ||
            input.tool.trim().length === 0
          ) {
            throw new Error(
              `${serverId}__mount_tool requires a non-empty tool string.`
            );
          }
          const toolName = input.tool;
          const cache = serverCaches.get(serverId);
          if (!cache) {
            throw new Error(`MCP server ${serverId} has no tool cache.`);
          }

          // Check if tool exists in cache
          const available = cache.listAvailable();
          const toolMeta = available.find(t => t.name === toolName);
          if (!toolMeta) {
            const availableNames = available.map(t => t.name).join(', ');
            throw new Error(
              `Tool '${toolName}' not found on MCP server ${serverId}. Available tools: ${availableNames}`
            );
          }

          // Enforce allowlist
          const allowedToolSet = serverAllowlists.get(serverId);
          if (allowedToolSet && !allowedToolSet.has(toolName)) {
            throw new Error(
              `Tool '${toolName}' is not in the allowedTools list for MCP server ${serverId}.`
            );
          }

          // Check if already mounted
          if (cache.isMounted(toolName)) {
            const mountedName = `${serverId}__${sanitizeToolSegment(toolName)}`;
            return JSON.stringify(
              { serverId, tool: toolName, mountedName, alreadyMounted: true },
              null,
              2
            );
          }

          // Mount via cache
          cache.mountTool(toolName, registration);
          connection.state.mountedToolCount = cache.exportMounted().length;
          setServerState(connection.state);

          const mountedName = `${serverId}__${sanitizeToolSegment(toolName)}`;
          return JSON.stringify(
            { serverId, tool: toolName, mountedName, mounted: true },
            null,
            2
          );
        }
      );

      registerMetaTool(
        `${serverId}__unmount_tool`,
        `Unmount a previously mounted tool from MCP server ${serverId}. This removes the tool from your active tool list to reduce clutter.`,
        {
          type: 'object',
          properties: {
            tool: {
              type: 'string',
              description: `The name of the tool to unmount (as shown by ${serverId}__list_tools, not the mounted name).`,
            },
          },
          required: ['tool'],
          additionalProperties: false,
        },
        async input => {
          if (
            typeof input.tool !== 'string' ||
            input.tool.trim().length === 0
          ) {
            throw new Error(
              `${serverId}__unmount_tool requires a non-empty tool string.`
            );
          }
          const toolName = input.tool;
          const cache = serverCaches.get(serverId);
          if (!cache) {
            return JSON.stringify(
              { serverId, tool: toolName, wasMounted: false },
              null,
              2
            );
          }

          if (!cache.isMounted(toolName)) {
            return JSON.stringify(
              { serverId, tool: toolName, wasMounted: false },
              null,
              2
            );
          }

          cache.unmountTool(toolName, registration);
          connection.state.mountedToolCount = cache.exportMounted().length;
          setServerState(connection.state);

          const mountedName = `${serverId}__${sanitizeToolSegment(toolName)}`;
          return JSON.stringify(
            { serverId, tool: toolName, mountedName, unmounted: true },
            null,
            2
          );
        }
      );
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

      // Create a fresh cache for this server
      const cache = new ToolMountingCache('mcp');
      for (const tool of tools) {
        const mountedName = `${serverId}__${sanitizeToolSegment(tool.name)}`;
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
        cache.addTool(tool.name, toolDef);
      }
      serverCaches.set(serverId, cache);
      serverAllowlists.set(serverId, allowedToolSet);

      const allowlistedCount = allowedToolSet
        ? tools.filter((t: McpToolMeta) => allowedToolSet.has(t.name)).length
        : tools.length;

      connection.state.filteredToolCount = tools.length - allowlistedCount;
      connection.state.mountedToolCount = 0;

      mountMetaTools(serverId, connection, serverDescription);
      mountResourcePromptTools(serverId, connection);
      setServerState(connection.state);

      registration.logger.info(
        `mcp server ${logMessage}: ${serverId} (discovered ${connection.state.discoveredToolCount} tool(s), mounted ${connection.state.mountedToolCount})`
      );
    }

    async function handleToolsListChanged(
      serverId: string,
      connection: McpClientConnection
    ): Promise<void> {
      const cache = serverCaches.get(serverId);
      if (!cache) return;

      const oldToolNames = new Set(cache.listAvailable().map(t => t.name));

      const tools = await connection.listTools();
      const newToolNames = new Set(tools.map(t => t.name));

      // Remove tools that no longer exist on the server
      for (const oldName of oldToolNames) {
        if (!newToolNames.has(oldName)) {
          cache.unmountTool(oldName, registration);
          cache.removeTool(oldName);
        }
      }

      // Add new tools
      for (const tool of tools) {
        if (!oldToolNames.has(tool.name)) {
          const mountedName = `${serverId}__${sanitizeToolSegment(tool.name)}`;
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
          cache.addTool(tool.name, toolDef);
        }
      }

      connection.state.discoveredToolCount = tools.length;
      connection.state.mountedToolCount = cache.exportMounted().length;
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

      for (const [serverId, serverConfig] of configuredServers) {
        let connection: McpClientConnection | undefined;
        const onNotification = (method: string, _params: unknown): void => {
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
          const oldCache = serverCaches.get(serverId);
          if (oldCache) {
            for (const tool of oldCache.exportMounted()) {
              oldCache.unmountTool(tool.name, registration);
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
            defaultRetryCount: mcpConfig.retryCount,
            defaultRetryDelayMs: mcpConfig.retryDelayMs,
            defaultMaxListPages: mcpConfig.maxListPages,
            defaultMaxListItems: mcpConfig.maxListItems,
            defaultCompatibilityMode: mcpConfig.compatibilityMode,
            onNotification,
            onStreamError,
            onReconnected,
            logger: registration.logger,
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
