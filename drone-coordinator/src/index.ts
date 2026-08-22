import fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCors from '@fastify/cors';
import '@fastify/websocket';
import {
  loadConfigFile,
  mergeConfig,
  type ServerConfigFile,
  type SessionEndTrigger,
} from 'drone-swarm-common';
import os from 'node:os';
import path from 'path';
import { fileURLToPath } from 'url';
import { pathToFileURL } from 'url';
import { existsSync } from 'fs';
import {
  initDatabase,
  closeDatabase,
  approveBeaconById,
  listBeaconTrust,
  listBeacons,
  listAllAgentLocations,
  listSwarmSessions,
  markStaleSessions,
  getWebToken,
  generateWebToken,
  initWebToken,
  createPersona,
  createSkill,
  listPersonas,
  listSkills,
} from './db/index.js';
import { initStorage } from './storage.js';
import { registerRoutes } from './routes/index.js';
import { setCoordinatorFingerprint } from './routes/health.js';
import { logger } from './logger.js';
import {
  loadOrCreateTlsIdentity,
  getTlsOptions,
  setTlsLogger,
} from 'drone-swarm-common/tls';
import { setKnowledgeBaseDir } from 'drone-swarm-common/wiki-storage';
import {
  addSubscriber,
  removeSubscriber,
  subscribeToSession,
  unsubscribeFromSession,
  publishInitialState,
} from './ws-pubsub.js';
import { createWebAuthMiddleware, isLocalRequest } from './web-auth.js';
import { configureSessionEndHook } from './session-end.js';

const DEFAULT_PORT = 3456;
const DEFAULT_HOST = '0.0.0.0';
const DEFAULT_WEB_PORT = 8080;
const DEFAULT_WEB_HOST = '127.0.0.1';
const DEFAULT_COMMAND_TIMEOUT_MS = 30000;
const DEFAULT_CONFIG_DIR = path.join(os.homedir(), '.drone-coordinator');
const DEFAULT_DB_FILENAME = 'drone-coordinator.db';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface Config {
  port: number;
  host: string;
  webPort: number;
  webHost: string;
  configDir: string;
  dbPath: string;
  useHttps: boolean;
  sessionEnd?: SessionEndTrigger;
  command:
    | 'serve'
    | 'approve-beacon'
    | 'list-beacons'
    | 'show-web-token'
    | 'generate-web-token'
    | 'show-fingerprint';
  beaconId?: string;
}

async function parseArgs(): Promise<Config> {
  const args = process.argv.slice(2);
  let fileConfig: ServerConfigFile | undefined;
  const flagOverrides: {
    port?: number;
    host?: string;
    webPort?: number;
    webHost?: string;
    dbPath?: string;
  } = {};
  const config: Config = {
    port: DEFAULT_PORT,
    host: DEFAULT_HOST,
    webPort: DEFAULT_WEB_PORT,
    webHost: DEFAULT_WEB_HOST,
    configDir: DEFAULT_CONFIG_DIR,
    dbPath: path.join(DEFAULT_CONFIG_DIR, DEFAULT_DB_FILENAME),
    useHttps: process.env.COORDINATOR_HTTPS === 'true',
    command: 'serve',
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--port' && i + 1 < args.length) {
      config.port = parseInt(args[++i], 10);
      flagOverrides.port = config.port;
    } else if (arg === '--host' && i + 1 < args.length) {
      config.host = args[++i];
      flagOverrides.host = config.host;
    } else if (arg === '--web-port' && i + 1 < args.length) {
      config.webPort = parseInt(args[++i], 10);
      flagOverrides.webPort = config.webPort;
    } else if (arg === '--web-host' && i + 1 < args.length) {
      config.webHost = args[++i];
      flagOverrides.webHost = config.webHost;
    } else if (arg === '--db' && i + 1 < args.length) {
      config.dbPath = args[++i];
      flagOverrides.dbPath = config.dbPath;
    } else if (arg === '--config-dir' && i + 1 < args.length) {
      config.configDir = args[++i];
      config.dbPath = path.join(config.configDir, DEFAULT_DB_FILENAME);
      flagOverrides.dbPath = config.dbPath;
    } else if (arg === '--config-file' && i + 1 < args.length) {
      const filePath = args[++i];
      try {
        fileConfig = await loadConfigFile(filePath);
      } catch (err) {
        console.error(String(err));
        process.exit(1);
      }
    } else if (arg === '--https') {
      config.useHttps = true;
    } else if (arg === '--no-https') {
      config.useHttps = false;
    } else if (arg === '--approve-beacon' && i + 1 < args.length) {
      config.command = 'approve-beacon';
      config.beaconId = args[++i];
    } else if (arg === 'approve-beacon') {
      config.command = 'approve-beacon';
    } else if (arg === 'list-beacons') {
      config.command = 'list-beacons';
    } else if (arg === '--show-web-token') {
      config.command = 'show-web-token';
    } else if (arg === '--generate-web-token') {
      config.command = 'generate-web-token';
    } else if (arg === '--show-fingerprint') {
      config.command = 'show-fingerprint';
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        `\ndrone-coordinator [options]\n\nCommands:\n  serve                Start the coordinator server (default)\n  approve-beacon <id>  Approve a pending beacon by its ID\n  list-beacons         List all registered beacons and their trust status\n  --show-web-token     Print the current web UI access token\n  --generate-web-token Generate a new web UI access token\n  --show-fingerprint   Print the coordinator's TLS certificate fingerprint\n\nOptions:\n  --port <n>           Port to listen on (default: ${DEFAULT_PORT})\n  --host <h>           Host to bind to (default: ${DEFAULT_HOST})\n  --web-port <n>       HTTP port for web UI (default: ${DEFAULT_WEB_PORT})\n  --web-host <h>       Host for web UI port (default: ${DEFAULT_WEB_HOST})\n\n  --config-file <path> Load settings from a JSON config file (flags override file values)\n  --config-dir <dir>   Configuration directory (default: ${DEFAULT_CONFIG_DIR})\n  --db <path>          Path to SQLite database (default: <config-dir>/${DEFAULT_DB_FILENAME})\n  --https              Enable HTTPS (default: ${process.env.COORDINATOR_HTTPS === 'true' ? 'enabled' : 'disabled'}, or set COORDINATOR_HTTPS=true)\n  --no-https           Disable HTTPS\n  --help               Show this help message\n      `
      );
      process.exit(0);
    }
  }

  if (fileConfig) {
    const merged = mergeConfig<ServerConfigFile>(fileConfig, flagOverrides);
    config.port = (merged.port as number) ?? config.port;
    config.host = (merged.host as string) ?? config.host;
    config.webPort = (merged.webPort as number) ?? config.webPort;
    config.webHost = (merged.webHost as string) ?? config.webHost;
    config.dbPath = (merged.dbPath as string) ?? config.dbPath;
    if (merged.sessionEnd !== undefined) {
      config.sessionEnd = merged.sessionEnd as SessionEndTrigger;
    }
  }

  return config;
}

async function handleShowFingerprint(config: Config) {
  const tlsIdentity = await loadOrCreateTlsIdentity(
    config.configDir,
    'coordinator'
  );
  console.log(tlsIdentity.fingerprint);
  process.exit(0);
}

async function handleApproveBeacon(config: Config) {
  if (!config.beaconId) {
    console.error('Error: --approve-beacon requires a beacon ID argument');
    console.log('Usage: drone-coordinator --approve-beacon <id>');
    process.exit(1);
  }

  initDatabase(config.dbPath);

  const trust = approveBeaconById(config.beaconId);
  if (!trust) {
    console.error('Error: Beacon trust not found or already approved');
    closeDatabase();
    process.exit(1);
  }

  console.log(
    `Successfully approved beacon: ${trust.name} (${trust.beaconId})`
  );
  closeDatabase();
  process.exit(0);
}

async function handleListBeacons(config: Config) {
  initDatabase(config.dbPath);

  const trustList = listBeaconTrust();
  const beaconList = listBeacons();

  if (trustList.length === 0 && beaconList.length === 0) {
    console.log('No beacons registered');
    closeDatabase();
    process.exit(0);
  }

  // Merge: trust entries first, then beacons without trust records
  const allBeacons = [
    ...trustList.map(t => ({
      name: t.name,
      beaconId: t.beaconId,
      host: t.host,
      port: t.port,
      status: t.status,
      approvedAt: t.approvedAt,
    })),
    ...beaconList
      .filter(b => !trustList.some(t => t.beaconId === b.id))
      .map(b => ({
        name: b.name,
        beaconId: b.id,
        host: b.host,
        port: b.port,
        status: 'unknown' as const,
        approvedAt: null,
      })),
  ];

  console.log('Registered beacons:');
  console.log('------------------');
  for (const beacon of allBeacons) {
    console.log(`${beacon.name} (${beacon.beaconId})`);
    console.log(`  Host: ${beacon.host}:${beacon.port}`);
    console.log(`  Status: ${beacon.status}`);
    if (beacon.approvedAt) {
      console.log(`  Approved: ${new Date(beacon.approvedAt).toISOString()}`);
    }
    console.log('');
  }

  closeDatabase();
  process.exit(0);
}

async function handleShowWebToken(config: Config) {
  initDatabase(config.dbPath);
  const token = getWebToken();
  if (!token) {
    console.log('No web token found. Generating one...');
    const newToken = generateWebToken();
    console.log(newToken);
  } else {
    console.log(token);
  }
  closeDatabase();
  process.exit(0);
}

async function handleGenerateWebToken(config: Config) {
  initDatabase(config.dbPath);
  const token = generateWebToken();
  console.log(token);
  closeDatabase();
  process.exit(0);
}

function resolveUiDistPath(): string {
  const monorepoPath = path.resolve(
    __dirname,
    '../../drone-coordinator-ui/dist'
  );
  if (existsSync(monorepoPath)) {
    return monorepoPath;
  }
  const nodeModulesPath = path.resolve(
    __dirname,
    '../node_modules/drone-coordinator-ui/dist'
  );
  if (existsSync(nodeModulesPath)) {
    return nodeModulesPath;
  }
  const envPath = process.env.UI_DIST_PATH;
  if (envPath && existsSync(envPath)) {
    return envPath;
  }
  return monorepoPath;
}

/**
 * Build a Fastify app instance with CORS, optional auth middleware, and API routes.
 * This is the testable core of the server, without UI-serving glue.
 */
export async function buildApp(opts?: {
  getToken?: () => string | null;
  https?: { cert: Buffer; key: Buffer };
}): Promise<FastifyInstance> {
  const app = fastify({
    logger: { level: process.env.LOG_LEVEL || 'info' },
    ...(opts?.https ? { https: { allowHTTP1: true, ...opts.https } } : {}),
  });

  await app.register(fastifyCors, {
    origin: process.env.NODE_ENV === 'development' ? true : false,
  });

  // Register auth middleware for the web port
  if (opts?.getToken) {
    app.addHook('onRequest', createWebAuthMiddleware(opts.getToken));
  }

  // Register API routes
  await registerRoutes(app);

  return app;
}

/**
 * Attach UI-serving routes to a Fastify app: WebSocket, static files, and SPA fallback.
 */
async function attachUi(
  app: FastifyInstance,
  uiDistPath: string,
  opts?: { getToken?: () => string | null }
): Promise<void> {
  await app.register(import('@fastify/websocket'));

  // WebSocket endpoint for real-time events
  app.get('/ws', { websocket: true }, (socket, req) => {
    // For web port: also check token from query parameter
    // (WebSocket upgrade requests can't easily set custom headers from browser)
    if (opts?.getToken) {
      // Skip token check for local/Tailscale connections (consistent with onRequest hook)
      if (!isLocalRequest(req)) {
        const url = new URL(
          req.url,
          `http://${req.headers.host || 'localhost'}`
        );
        const queryToken = url.searchParams.get('token');
        const token = opts.getToken();
        if (token && queryToken !== token) {
          // Token required but not provided or invalid via query param.
          // The onRequest hook already checked the Authorization header,
          // so if we got here without a valid header, check query param.
          // If neither is valid, close the connection.
          const authHeader = req.headers.authorization;
          const headerToken = authHeader?.startsWith('Bearer ')
            ? authHeader.slice(7)
            : null;
          if (headerToken !== token && queryToken !== token) {
            socket.close(4001, 'Unauthorized');
            return;
          }
        }
      }
    }

    const sub = addSubscriber(socket);

    try {
      const beacons = listBeacons();
      const agentLocations = listAllAgentLocations();
      const swarmSessions = listSwarmSessions({ status: 'active' });
      const sessions = swarmSessions.map(s => {
        const beacon = beacons.find(b => b.id === s.beaconId);
        return {
          id: s.id,
          beaconId: s.beaconId,
          agentId: s.id,
          personaId: s.personaId,
          connectedAt: s.createdAt,
          disconnectedAt: null,
          durationMs: null,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
          beaconName: beacon?.name ?? s.beaconId,
          beaconHost: beacon?.host,
          beaconPort: beacon?.port,
        };
      });

      publishInitialState(socket, {
        beacons,
        agentLocations,
        sessions,
      });
    } catch (err) {
      logger.warn(`Failed to build initial state: ${err}`);
    }

    socket.on('message', (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'subscribe' && msg.sessionId) {
          subscribeToSession(sub, msg.sessionId);
        } else if (msg.type === 'unsubscribe' && msg.sessionId) {
          unsubscribeFromSession(sub, msg.sessionId);
        }
      } catch {
        // Ignore malformed messages
      }
    });

    const interval = setInterval(() => {
      try {
        socket.send(JSON.stringify({ type: 'ping' }));
      } catch {
        clearInterval(interval);
      }
    }, 30000);

    socket.on('close', () => {
      clearInterval(interval);
      removeSubscriber(sub);
    });
  });

  // Serve the UI static files — only under /assets/
  await app.register(fastifyStatic, {
    root: path.join(uiDistPath, 'assets'),
    prefix: '/assets/',
    wildcard: false,
  });

  // Serve the root index.html
  app.get('/', async (_request, reply) => {
    return reply.sendFile('index.html', path.resolve(uiDistPath));
  });

  // SPA fallback
  app.setNotFoundHandler(async (request, reply) => {
    if (
      request.url.startsWith('/api') ||
      request.url.startsWith('/ws') ||
      request.url.startsWith('/health')
    ) {
      return reply.code(404).send({ error: 'Not found' });
    }
    return reply.sendFile('index.html', path.resolve(uiDistPath));
  });
}

export async function main() {
  const config = await parseArgs();

  if (config.command === 'approve-beacon') {
    await handleApproveBeacon(config);
    return;
  }

  if (config.command === 'list-beacons') {
    await handleListBeacons(config);
    return;
  }

  if (config.command === 'show-web-token') {
    await handleShowWebToken(config);
    return;
  }

  if (config.command === 'generate-web-token') {
    await handleGenerateWebToken(config);
    return;
  }

  if (config.command === 'show-fingerprint') {
    await handleShowFingerprint(config);
    return;
  }

  if (config.sessionEnd) {
    if (config.sessionEnd.type === 'spawn' && !config.sessionEnd.beaconId) {
      console.error(
        'Config error: sessionEnd spawn trigger requires "beaconId" at the coordinator layer'
      );
      process.exit(1);
    }
    configureSessionEndHook({
      trigger: config.sessionEnd,
      commandTimeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
    });
    logger.info('Session-end hook configured');
  }

  const protocol = config.useHttps ? 'https' : 'http';
  logger.info(`Starting drone-coordinator on ${config.host}:${config.port}`);
  logger.info(`Web UI on ${config.webHost}:${config.webPort} (HTTP)`);
  logger.info(`Database path: ${config.dbPath}`);
  logger.info(`Protocol: ${protocol.toUpperCase()}`);

  // Seed default personas and skills (only if they don't exist)
  initDatabase(config.dbPath);
  seedDefaults();
  await initStorage(config.configDir);

  // Initialize wiki storage under config dir
  setKnowledgeBaseDir(path.join(config.configDir, 'knowledge-base'));

  // Initialize web token (auto-generates on first startup)
  initWebToken();

  // Set TLS logger
  setTlsLogger(logger);

  let tlsOptions: { cert: Buffer; key: Buffer } | undefined;
  if (config.useHttps) {
    const tlsIdentity = await loadOrCreateTlsIdentity(
      config.configDir,
      'coordinator'
    );
    tlsOptions = getTlsOptions(tlsIdentity);
    setCoordinatorFingerprint(tlsIdentity.fingerprint);
    logger.info(`TLS certificate fingerprint: ${tlsIdentity.fingerprint}`);
  }

  const uiDistPath = resolveUiDistPath();
  logger.info(`Serving UI from: ${uiDistPath}`);

  // Primary server (with TLS if configured)
  const app = await buildApp(tlsOptions ? { https: tlsOptions } : undefined);
  await attachUi(app, uiDistPath);

  // Web server (HTTP only, no TLS, with auth for non-local connections)
  const webApp = await buildApp({ getToken: () => getWebToken() });
  await attachUi(webApp, uiDistPath, { getToken: () => getWebToken() });

  // Check for stale sessions every hour (mark sessions inactive > 24 hours)
  const staleCheckInterval = setInterval(
    () => {
      markStaleSessions(24 * 60 * 60 * 1000);
    },
    60 * 60 * 1000
  );

  const shutdown = async () => {
    logger.info('Shutting down...');
    clearInterval(staleCheckInterval);
    await Promise.all([app.close(), webApp.close()]);
    closeDatabase();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    await Promise.all([
      app.listen({
        port: config.port,
        host: config.host,
      }),
      webApp.listen({
        port: config.webPort,
        host: config.webHost,
      }),
    ]);
    logger.info(
      `Coordinator listening on ${protocol}://${config.host}:${config.port}`
    );
    logger.info(
      `Web UI listening on http://${config.webHost}:${config.webPort}`
    );
  } catch (err) {
    logger.error(err);
    process.exit(1);
  }
}

/**
 * Seed default personas and skills into the coordinator database.
 * Only creates items that don't already exist, so user customizations are preserved.
 */
function seedDefaults(): void {
  const existingPersonas = listPersonas();
  const existingPersonaIds = new Set(existingPersonas.map(p => p.id));

  if (!existingPersonaIds.has('coordinator-wiki-librarian')) {
    createPersona({
      id: 'coordinator-wiki-librarian',
      name: 'Coordinator Wiki Librarian',
      description:
        'Suggested persona for scheduled and manual memory wiki maintenance sessions',
      systemPrompt: `---
name: coordinator-wiki-librarian
description: Suggested persona for scheduled and manual memory wiki maintenance sessions
color: '#4488ff'
tools:
  - wiki_*
  - session_*
  - search__*
  - skills__recall
  - memory__recall
  - memory__search
  - memory__list
  - file__read
  - file__list
  - file__glob
  - !exec.*
  - !file.write
  - !file.apply_diff
  - !git.*
  - !self-improvement.*
  - !memory.store
  - !memory.delete
  - !swarm__wiki_delete
skills:
  - memory-wiki
toolCallLimit: 50

# Coordinator Wiki Librarian

You are a knowledge management specialist for the drone-agent swarm. Your purpose is to maintain the swarm's memory wiki by ingesting conversation history, organizing knowledge, and ensuring the wiki remains accurate and well-structured.

## Your Tools

You have access to:
- **Wiki tools** (wiki_read, wiki_write, wiki_search, wiki_list, wiki_lint) — for reading and writing wiki pages
- **Session tools** (session_list, session_get_log, session_mark_processed) — for finding and processing sessions
- **Search tools** (search__text) — for searching text
- **Skill recall** (skills__recall) — for loading the memory-wiki skill
- **Memory read tools** (memory__recall, memory__search, memory__list) — for reading project memory
- **File read tools** (file__read, file__list, file__glob) — for reading files

You do NOT have access to:
- Shell execution (exec.*)
- File writing (file.write, file.apply_diff)
- Git operations (git.*)
- Self-improvement tools (self-improvement.*)
- Memory writing/deletion (memory.store, memory.delete)
- Wiki deletion (swarm__wiki_delete)

## Your Workflow

When asked to process a session:
1. Call skills.recall({"id": "memory-wiki"}) to load the wiki skill
2. Use session_list to find finished sessions
3. Use session_get_log to retrieve the full conversation
4. Analyze the conversation for key insights, decisions, patterns
5. Create or update wiki pages with wiki_write
6. Call session_mark_processed when done`,
    });
    logger.info('Seeded default persona: coordinator-wiki-librarian');
  }

  if (!existingPersonaIds.has('coordinator-admin')) {
    createPersona({
      id: 'coordinator-admin',
      name: 'Coordinator Admin',
      description:
        'Persona with an overview of the drone framework internals preloaded. Use for setup/maintenance questions and tasks.',
      systemPrompt: `---
name: coordinator-admin
description: Persona with an overview of the drone framework internals preloaded. Use for setup/maintenance questions and tasks.
color: '#ff8844'
tools:
  - config__*
  - startup__*
  - persona__*
  - skills__*
  - wiki_read
  - wiki_search
  - wiki_list
  - wiki_lint
  - session_list
  - session_get_log
  - memory__*
  - search__*
  - file__read
  - file__list
  - file__glob
  - !exec.*
  - !file.write
  - !file.apply_diff
  - !git.*
  - !self-improvement.*
  - !swarm__wiki_write
  - !swarm__wiki_delete
  - !session_mark_processed
toolCallLimit: 30

# Coordinator Admin

You are a drone-agent swarm administration specialist. You have deep knowledge of the drone framework's architecture and can help with setup, configuration, and maintenance questions.

## Architecture Overview

The drone ecosystem has four layers:

1. **drone-agent** — The CLI/TUI coding agent. Runs plugins, connects to LLM providers, manages sessions. Can work standalone or as part of a swarm.
2. **drone-beacon** — Local coordination hub. Runs on each host, provides host-wide personas/skills/memory, inter-agent messaging, agent spawning.
3. **drone-coordinator** — Global control plane. Manages swarm sessions, knowledge, wiki, insights/principles across all beacons. Source of truth for swarm-scoped assets.
4. **drone-gateway** (future) — Chat API integration layer.

## Config Cascade

Config is resolved in this order (last wins):
1. System defaults (precedence 0)
2. Coordinator config (precedence 50)
3. Beacon config (precedence 75)
4. User config (~/.drone-agent/config.json)
5. Project config (<project>/.drone-agent/config.json)

## Key Concepts

- **Personas** define an agent's identity, system prompt, and tool access. Personas can be scoped to user, project, beacon, or coordinator.
- **Skills** provide the LLM with instructions on how to perform tasks. Skills are loaded via skills.recall().
- **Wiki** is a shared knowledge base of markdown pages with YAML frontmatter, stored on the beacon/coordinator filesystem.
- **Migration tool** (drone-migrate) promotes/demotes assets between scopes (project ↔ user ↔ beacon ↔ coordinator).
- **Self-improvement** system records insights and derives principles that are injected into the system prompt.

## Your Tools

You have read-only access to most systems plus the ability to run the migration tool. You cannot execute shell commands, write files, or modify the wiki.

## Common Tasks

- "How do I set up TLS?" — Explain the --https flag and certificate auto-generation
- "What's the difference between beacon and coordinator scopes?" — Explain scope hierarchy
- "How do I migrate a persona from local to swarm?" — Explain the migration tool
- "Show me the current config" — Use config__get and config__list_layers
- "List all personas" — Use persona__list`,
    });
    logger.info('Seeded default persona: coordinator-admin');
  }

  const existingSkills = listSkills();
  const existingSkillIds = new Set(existingSkills.map(s => s.id));

  if (!existingSkillIds.has('memory-wiki')) {
    createSkill({
      id: 'memory-wiki',
      name: 'Memory Wiki',
      description:
        'A description of the memory wiki structure, exploration, and ingestion workflow',
      trigger:
        'the user wants to understand the wiki structure, ingest a session into the wiki, explore the wiki, or know the difference between wiki and project memory',
      body: `# Memory Wiki

## Structure

Wiki pages are stored as .md files with YAML frontmatter:

\`\`\`yaml
---
id: my-page
title: My Page
scope: beacon  # or 'coordinator'
tags:
  - reference
sources:
  - session-abc123
---
\`\`\`

Pages support [[wiki links]] for cross-references. The wiki enforces a "no downward links" rule: coordinator pages cannot link to beacon pages.

## Exploration

- wiki_list — list all pages
- wiki_search — search by keyword
- wiki_read — read a specific page
- wiki_lint — check for broken links, downward links, orphan pages

## Ingestion Workflow

1. Use session_list to find finished sessions
2. Use session_get_log to retrieve the full conversation
3. Analyze the conversation for key insights, decisions, patterns
4. Create or update wiki pages with wiki_write
5. Include the session ID in the sources field
6. Call session_mark_processed when done

## Wiki vs Project Memory

- **Wiki**: Persistent, structured, shared across the swarm. Use for documentation, architecture decisions, patterns, reference material.
- **Project Memory** (memory__store): Quick facts, local context, ephemeral notes. Use for temporary information that only this agent needs.`,
    });
    logger.info('Seeded default skill: memory-wiki');
  }
}

// Entry guard: only run main() if invoked directly
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  void main();
}
