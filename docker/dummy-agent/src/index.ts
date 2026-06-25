/**
 * Dummy Agent for Integration Testing
 *
 * A minimal agent container that:
 * - Connects to beacon via HTTP
 * - Accepts commands via HTTP
 * - Reports tool calls, messages, session state for verification
 * - Uses the echo LLM provider
 */

import { createServer, IncomingMessage, ServerResponse } from 'node:http';

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3459;
const BEACON_HOST = process.env.BEACON_HOST || 'localhost';
const BEACON_PORT = process.env.BEACON_PORT ? parseInt(process.env.BEACON_PORT, 10) : 3457;
const AGENT_ID = process.env.AGENT_ID || `dummy-${Date.now()}`;
const LLM_ECHO_URL = process.env.LLM_ECHO_URL || 'http://localhost:3458';

interface AgentState {
  status: 'connected' | 'disconnected' | 'busy' | 'idle';
  persona?: string;
  lastActivity: Date;
  toolCalls: ToolCall[];
  messages: Message[];
}

interface ToolCall {
  tool: string;
  args: object;
  timestamp: Date;
  result?: string;
}

interface Message {
  id: string;
  from: string;
  to: string;
  body: object;
  delivered: boolean;
  readAt?: Date;
  createdAt: Date;
}

const state: AgentState = {
  status: 'disconnected',
  lastActivity: new Date(),
  toolCalls: [],
  messages: [],
};

const logger = {
  info: (...args: unknown[]) => console.log(`[INFO]`, ...args),
  error: (...args: unknown[]) => console.error(`[ERROR]`, ...args),
};

/**
 * Register this agent with the beacon
 */
async function registerWithBeacon(): Promise<void> {
  try {
    const response = await fetch(`http://${BEACON_HOST}:${BEACON_PORT}/agents/${AGENT_ID}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: AGENT_ID,
        capabilities: ['file', 'memory', 'exec', 'git'],
      }),
    });

    if (response.ok) {
      state.status = 'connected';
      state.lastActivity = new Date();
      logger.info(`Registered with beacon as ${AGENT_ID}`);
    } else {
      logger.error(`Failed to register with beacon: ${response.status}`);
    }
  } catch (error) {
    logger.error(`Failed to register with beacon:`, error);
  }
}

/**
 * Unregister this agent from the beacon
 */
async function unregisterFromBeacon(): Promise<void> {
  try {
    const response = await fetch(`http://${BEACON_HOST}:${BEACON_PORT}/agents/${AGENT_ID}`, {
      method: 'DELETE',
    });

    if (response.ok) {
      state.status = 'disconnected';
      logger.info(`Unregistered from beacon`);
    }
  } catch (error) {
    logger.error(`Failed to unregister from beacon:`, error);
  }
}

/**
 * Get messages from beacon
 */
async function fetchMessages(): Promise<void> {
  try {
    const response = await fetch(`http://${BEACON_HOST}:${BEACON_PORT}/agents/${AGENT_ID}/messages`);
    if (response.ok) {
      const messages = await response.json();
      state.messages = messages;
      state.lastActivity = new Date();
    }
  } catch (error) {
    logger.error(`Failed to fetch messages:`, error);
  }
}

/**
 * Echo LLM call - forward to echo LLM and return response
 */
async function callEchoLlm(prompt: string): Promise<string> {
  try {
    const response = await fetch(`${LLM_ECHO_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'echo-model',
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (response.ok) {
      const data = await response.json();
      return data.choices?.[0]?.message?.content ?? 'No response';
    }
    return `Error: ${response.status}`;
  } catch (error) {
    return `Error: ${error}`;
  }
}

/**
 * Handle HTTP requests
 */
async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = req.url ?? '/';
  const method = req.method ?? 'GET';

  // Set CORS headers
  res.setHeader('Content-Type', 'application/json');

  try {
    // Health check
    if (url === '/health' && method === 'GET') {
      res.writeHead(200);
      res.end(JSON.stringify({ status: 'ok', agentId: AGENT_ID }));
      return;
    }

    // Get agent status
    if (url === '/status' && method === 'GET') {
      res.writeHead(200);
      res.end(JSON.stringify({
        status: state.status,
        persona: state.persona,
        lastActivity: state.lastActivity.toISOString(),
      }));
      return;
    }

    // Get tool calls
    if (url === '/tool-calls' && method === 'GET') {
      res.writeHead(200);
      res.end(JSON.stringify(state.toolCalls));
      return;
    }

    // Clear tool calls
    if (url === '/tool-calls' && method === 'DELETE') {
      state.toolCalls = [];
      res.writeHead(200);
      res.end(JSON.stringify({ cleared: true }));
      return;
    }

    // Get messages
    if (url === '/messages' && method === 'GET') {
      res.writeHead(200);
      res.end(JSON.stringify(state.messages));
      return;
    }

    // Execute a task (calls echo LLM)
    if (url === '/execute' && method === 'POST') {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
      }
      const { task } = JSON.parse(body);
      
      state.status = 'busy';
      const result = await callEchoLlm(task);
      
      state.toolCalls.push({
        tool: 'echo-llm',
        args: { prompt: task },
        timestamp: new Date(),
        result,
      });
      
      state.status = 'idle';
      state.lastActivity = new Date();
      
      res.writeHead(200);
      res.end(JSON.stringify({ result }));
      return;
    }

    // Trigger message fetch
    if (url === '/fetch-messages' && method === 'POST') {
      await fetchMessages();
      res.writeHead(200);
      res.end(JSON.stringify({ fetched: state.messages.length }));
      return;
    }

    // 404
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
  } catch (error) {
    res.writeHead(500);
    res.end(JSON.stringify({ error: String(error) }));
  }
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  logger.info(`Starting dummy agent ${AGENT_ID}`);
  logger.info(`Beacon: ${BEACON_HOST}:${BEACON_PORT}`);
  logger.info(`Echo LLM: ${LLM_ECHO_URL}`);

  // Register with beacon
  await registerWithBeacon();

  // Create HTTP server
  const server = createServer(handleRequest);

  server.listen(PORT, () => {
    logger.info(`Dummy agent listening on port ${PORT}`);
  });

  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    logger.info('Shutting down...');
    await unregisterFromBeacon();
    server.close(() => {
      process.exit(0);
    });
  });
}

main().catch((error) => {
  logger.error('Failed to start:', error);
  process.exit(1);
});