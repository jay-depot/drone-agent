---
key: swarm-features-plan-default-personas-session-pipeline-tool-gating
tags:
  []
created: 2026-07-01T18:03:48.714Z
updated: 2026-07-01T18:03:48.714Z
---

# Swarm Features Plan: Default Personas, Session Pipeline & Tool Gating

## Summary

This plan covers three related feature areas for the drone-agent swarm ecosystem:

1. **Default Personas & Skills** — Seed `coordinator-wiki-librarian`, `coordinator-admin` personas and `memory-wiki` skill into every coordinator on first startup
2. **Session Processing Pipeline** — Full session lifecycle management (active → stale → finished → processing → processed) with endpoints for listing, retrieving, and processing sessions
3. **Tool Gating** — A `defaultHidden` flag on tool definitions that causes persona creation tools to automatically exclude those tools from new personas, solving the problem of wiki/principles tools being available to the LLM by default

## Why

The drone-agent swarm is growing in capability, and with that growth comes the need for:
- **Out-of-the-box usability**: New coordinator deployments should have useful personas and skills pre-loaded
- **Automated knowledge management**: Sessions should be processable through a defined pipeline, enabling scheduled wiki ingestion
- **Responsible defaults**: Powerful tools (wiki write, principles store) should be opt-in rather than always available, without violating the project's "model-centric" design principle

---

## Phase 1: Foundation — Core Type Changes

### Step 1.1: Add `defaultHidden` to `DroneToolDefinition`

**File:** `drone-core/src/plugin-system.ts`

Add an optional `defaultHidden?: boolean` field to the `DroneToolDefinition` type:

```typescript
export type DroneToolDefinition = {
  name: string;
  description: string;
  inputSchema?: DroneToolJsonSchema;
  defaultHidden?: boolean;  // NEW: if true, hidden from LLM unless persona explicitly allows
  execute: (input: Record<string, unknown>) => Promise<string>;
};
```

### Step 1.2: Add `defaultHidden` to `DroneToolDescriptor`

**File:** `drone-core/src/session-types.ts`

Add the same field to the descriptor type (the "public" view of a tool sent to the LLM):

```typescript
export type DroneToolDescriptor = {
  name: string;
  description: string;
  inputSchema?: DroneToolJsonSchema;
  defaultHidden?: boolean;  // NEW: propagated from definition
};
```

### Step 1.3: Propagate `defaultHidden` through the engine

**File:** `drone-agent/src/runtime/plugin-engine.ts`

In the `registerTool` method, store the `defaultHidden` flag alongside the tool definition. In the `listTools` method, include it in the returned `DroneToolDescriptor`:

```typescript
// In registerTool:
const toolEntry = { ...tool, canonicalName };
tools.set(canonicalName, toolEntry);

// In listTools:
Array.from(tools.entries()).map(([canonicalName, tool]) => ({
  name: canonicalName,
  description: tool.description,
  inputSchema: tool.inputSchema,
  defaultHidden: tool.defaultHidden,  // NEW
}));
```

### Step 1.4: Add session status constants

**File:** `drone-core/src/session-types.ts` (or a new constants file)

Define the session lifecycle statuses:

```typescript
export const SESSION_STATUSES = {
  ACTIVE: 'active',
  STALE: 'stale',
  FINISHED: 'finished',
  PROCESSING: 'processing',
  PROCESSED: 'processed',
} as const;

export type SessionStatus = typeof SESSION_STATUSES[keyof typeof SESSION_STATUSES];
```

### Step 1.5: Add tool definitions table to coordinator DB

**File:** `drone-coordinator/src/db.ts`

Add a new table for storing tool definitions pushed by agents:

```sql
CREATE TABLE IF NOT EXISTS tool_definitions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  defaultHidden INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL,  -- 'builtin' | 'agent:<agentId>'
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tool_definitions_name ON tool_definitions(name);
```

Add CRUD functions:
- `upsertToolDefinition(name, description, defaultHidden, source)` — INSERT OR REPLACE
- `getToolDefinitions()` — returns all
- `getDefaultHiddenTools()` — returns only tools where `defaultHidden = 1`

### Step 1.6: Pre-seed built-in tool definitions

**File:** `drone-coordinator/src/db.ts` (in `initDatabase()`)

After creating the `tool_definitions` table, seed it with known built-in tools that should be `defaultHidden`:

```typescript
const builtinHiddenTools = [
  { name: 'swarm__wiki_write', description: 'Create or update a wiki page', defaultHidden: true },
  { name: 'swarm__wiki_delete', description: 'Delete a wiki page', defaultHidden: true },
  { name: 'self-improvement__insight', description: 'Record a self-improvement insight', defaultHidden: true },
  { name: 'self-improvement__principles-store', description: 'Store a principle', defaultHidden: true },
  { name: 'self-improvement__principles-delete', description: 'Delete a principle', defaultHidden: true },
  { name: 'memory__store', description: 'Store a value in project memory', defaultHidden: true },
  { name: 'memory__delete', description: 'Delete a memory entry', defaultHidden: true },
  // ... add more as appropriate
];

for (const tool of builtinHiddenTools) {
  upsertToolDefinition(tool.name, tool.description, tool.defaultHidden, 'builtin');
}
```

**Dependencies:** Step 1.5

---

## Phase 2: Tool Gating

### Step 2.1: Persona filtering respects `defaultHidden`

**File:** `drone-agent/src/plugins/persona/index.ts`

Modify `getFilteredTools()` to treat `defaultHidden: true` tools as excluded unless the persona's `allowedTools` explicitly includes them:

```typescript
function getFilteredTools(allTools: DroneToolDescriptor[]): DroneToolDescriptor[] {
  if (!activePersona) {
    // No active persona: hide defaultHidden tools
    return allTools.filter(t => !t.defaultHidden);
  }

  if (!activePersona.allowedTools) {
    // Persona active but no allowedTools filter: hide defaultHidden tools
    return allTools.filter(t => !t.defaultHidden);
  }

  // Persona has explicit allowedTools: apply glob filtering
  const names = allTools.map(t => t.name);
  const filtered = filterByGlobPatterns(names, activePersona.allowedTools);
  const filteredSet = new Set(filtered);
  return allTools.filter(t => filteredSet.has(t.name));
}
```

**Key design decision:** When no persona is active, `defaultHidden` tools are hidden. When a persona is active with explicit `allowedTools`, the persona's patterns take full control (they can re-include hidden tools). This means the default experience is safe, and persona authors explicitly opt into powerful tools.

### Step 2.2: Mark built-in tools as `defaultHidden`

**Files:** Various plugin files in `drone-agent/src/plugins/`

Add `defaultHidden: true` to the tool definitions that should be hidden by default:

| Plugin | Tools to mark |
|--------|--------------|
| `swarm/index.ts` | `wiki_write`, `wiki_delete` |
| `self-improvement/index.ts` | `insight`, `principles-store`, `principles-delete` |
| `memory/index.ts` | `store`, `delete` |
| `exec.ts` | `run` (maybe — discuss) |
| `file.ts` | `write`, `apply_diff` (maybe — discuss) |

**Start conservative:** Only mark the tools that are clearly dangerous or swarm-scoped. `wiki_write`, `wiki_delete`, `insight`, `principles-store`, `principles-delete`, `memory__store`, `memory__delete` are the clear candidates. `exec.run`, `file.write`, `file.apply_diff` are debatable — they're core to the coding use case.

### Step 2.3: Tool definition sync — agent pushes on connect

**File:** `drone-agent/src/plugins/swarm/index.ts`

In the `onPluginsLoaded` hook (after successful beacon registration), push the agent's tool definitions to the beacon:

```typescript
// After registerSwarmSession() and reloadFromBeacon()
const allTools = engine.listTools();
const toolDefs = allTools.map(t => ({
  name: t.name,
  description: t.description,
  defaultHidden: t.defaultHidden ?? false,
}));

// Push to beacon, which proxies to coordinator
await fetch(`${baseUrl}/sync/tools/push`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ tools: toolDefs }),
}).catch(err => {
  registration.logger.warn(`Failed to push tool definitions: ${err}`);
});
```

### Step 2.4: Beacon proxies tool definitions to coordinator

**File:** `drone-beacon/src/routes/sync.ts`

Add a new route:

```typescript
app.post<{ Body: { tools: Array<{ name: string; description: string; defaultHidden: boolean }> } }>(
  '/sync/tools/push', async (request, reply) => {
    const client = getCoordinatorClient();
    if (client) {
      client.pushToolDefinitions(request.body.tools).catch(err => {
        logger.warn(`Failed to proxy tool definitions to coordinator: ${err}`);
      });
    }
    return reply.code(201).send({ count: request.body.tools.length });
  }
);
```

### Step 2.5: Coordinator receives tool definitions

**File:** `drone-coordinator/src/routes/swarm.ts` (or a new `tools.ts` route file)

Add a new route:

```typescript
app.post<{ Body: { tools: Array<{ name: string; description: string; defaultHidden: boolean }> } }>(
  '/sync/tools/push', async (request, reply) => {
    const { tools } = request.body;
    for (const tool of tools) {
      db.upsertToolDefinition(tool.name, tool.description, tool.defaultHidden, 'agent:push');
    }
    return reply.code(201).send({ count: tools.length });
  }
);
```

Also add a `GET /tools/default-hidden` endpoint that returns the list of `defaultHidden` tool names (for the persona wizard to query):

```typescript
app.get('/tools/default-hidden', async (_request, reply) => {
  const tools = db.getDefaultHiddenTools();
  return reply.send({ tools: tools.map(t => t.name) });
});
```

### Step 2.6: Beacon proxies `GET /tools/default-hidden`

**File:** `drone-beacon/src/routes/sync.ts` (or a new route)

```typescript
app.get('/tools/default-hidden', async (_request, reply) => {
  const client = getCoordinatorClient();
  if (!client) return reply.send({ tools: [] });
  const result = await client.getDefaultHiddenTools();
  return reply.send(result);
});
```

### Step 2.7: Persona wizard auto-adds exclusion patterns

**File:** `drone-agent/src/plugins/persona/wizard.ts`

After the LLM generates the persona content and before writing, query the coordinator for `defaultHidden` tools and inject exclusion patterns into the persona's `tools:` frontmatter:

```typescript
// After LLM generates persona content, before writing:
let defaultHiddenTools: string[] = [];

// Try to fetch from coordinator via beacon
if (swarmPluginEnabled) {
  try {
    const res = await fetch(`${beaconUrl}/tools/default-hidden`);
    const data = await res.json();
    defaultHiddenTools = data.tools;
  } catch {
    // Fallback: use local engine's tool list
    const allTools = engine.listTools();
    defaultHiddenTools = allTools
      .filter(t => t.defaultHidden)
      .map(t => t.name);
  }
}

// Generate exclusion patterns
const exclusionPatterns = defaultHiddenTools.map(name => `!${name}`);

// Inject into persona frontmatter
// The persona content already has a `tools:` section from the LLM
// If it has `tools: ['*']`, append exclusions
// If it has specific tools, append exclusions
// If it has no tools section, add `tools: ['*', ...exclusions]`
```

**Important:** The wizard should also handle the case where the persona author explicitly wants to include a `defaultHidden` tool. If the LLM-generated persona already has a `tools:` section that includes a specific tool, the exclusion pattern for that tool should be omitted. The logic is: only exclude tools that aren't already explicitly included.

**Dependencies:** Steps 2.5, 2.6

---

## Phase 3: Session Processing Pipeline

### Step 3.1: Expand `swarm_sessions` status values

**File:** `drone-coordinator/src/db.ts`

Update the `swarm_sessions` table creation to document the expanded status values (the column is already TEXT, so no schema migration needed — just update the default and add validation):

```typescript
// In initDatabase(), update the table creation:
CREATE TABLE IF NOT EXISTS swarm_sessions (
  id TEXT PRIMARY KEY,
  persona_id TEXT,
  beacon_id TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
);
```

Add a helper function for status transitions:

```typescript
export function transitionSessionStatus(
  id: string,
  fromStatus: SessionStatus | SessionStatus[],
  toStatus: SessionStatus,
  metadata?: { summary?: string; notes?: string }
): SwarmSession | { error: string } {
  const session = getSwarmSession(id);
  if (!session) return { error: 'Session not found' };

  const allowedFrom = Array.isArray(fromStatus) ? fromStatus : [fromStatus];
  if (!allowedFrom.includes(session.status as SessionStatus)) {
    return { error: `Cannot transition from '${session.status}' to '${toStatus}'` };
  }

  const now = Date.now();
  const stmt = getDatabase().prepare(`
    UPDATE swarm_sessions
    SET status = @status, updatedAt = @updatedAt
    WHERE id = @id
  `);
  stmt.run({ id, status: toStatus, updatedAt: now });

  return { ...session, status: toStatus, updatedAt: now };
}
```

### Step 3.2: Add `GET /sessions` with filtering, sorting, pagination

**File:** `drone-coordinator/src/routes/swarm.ts`

Add a new route:

```typescript
app.get<{
  Querystring: {
    status?: string;
    sortBy?: 'createdAt' | 'updatedAt';
    sortDirection?: 'ASC' | 'DESC';
    limit?: string;
    offset?: string;
  }
}>('/sessions', async (request, reply) => {
  const { status, sortBy = 'createdAt', sortDirection = 'DESC', limit, offset } = request.query;

  const sessions = db.listSwarmSessions({
    status,
    sortBy,
    sortDirection,
    limit: limit ? Number(limit) : undefined,
    offset: offset ? Number(offset) : undefined,
  });

  return reply.send({ sessions, count: sessions.length });
});
```

Add the corresponding `listSwarmSessions` function to `db.ts`:

```typescript
export function listSwarmSessions(options: {
  status?: string;
  sortBy?: string;
  sortDirection?: string;
  limit?: number;
  offset?: number;
}): SwarmSession[] {
  let query = 'SELECT * FROM swarm_sessions WHERE 1=1';
  const params: unknown[] = [];

  if (options.status) {
    query += ' AND status = ?';
    params.push(options.status);
  }

  const sortCol = options.sortBy === 'updatedAt' ? 'updatedAt' : 'createdAt';
  const sortDir = options.sortDirection === 'ASC' ? 'ASC' : 'DESC';
  query += ` ORDER BY ${sortCol} ${sortDir}`;

  if (options.limit) {
    query += ' LIMIT ?';
    params.push(options.limit);
  }
  if (options.offset) {
    query += ' OFFSET ?';
    params.push(options.offset);
  }

  const stmt = getDatabase().prepare(query);
  return stmt.all(...params) as SwarmSession[];
}
```

### Step 3.3: Add `GET /sessions/:id/log` — full session reconstruction

**File:** `drone-coordinator/src/routes/swarm.ts`

Add a new route that reconstructs the full conversation from events, resolving blob references:

```typescript
app.get<{ Params: { id: string } }>('/sessions/:id/log', async (request, reply) => {
  const session = db.getSwarmSession(request.params.id);
  if (!session) return reply.code(404).send({ error: 'Session not found' });

  // Get all events for this session
  const events = db.getSwarmEvents(request.params.id);

  // Resolve blob references in payloads
  const resolvedEvents = events.map(evt => {
    let payload = evt.payload;
    if (payload && payload.startsWith('blob:')) {
      try {
        payload = retrieveLargePayload(payload);
      } catch {
        payload = null; // blob file missing
      }
    }
    return {
      ...evt,
      payload, // now resolved to actual content
    };
  });

  // Reconstruct into a structured conversation log
  const conversationLog = reconstructConversationLog(resolvedEvents);

  return reply.send({
    session: {
      id: session.id,
      personaId: session.personaId,
      beaconId: session.beaconId,
      status: session.status,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    },
    events: resolvedEvents,
    conversation: conversationLog,
  });
});
```

Add a `reconstructConversationLog` helper that groups events by `correlationId` and orders them chronologically:

```typescript
function reconstructConversationLog(events: SwarmEvent[]): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  let currentTurn: ConversationTurn | null = null;

  for (const evt of events) {
    if (!evt.payload) continue;

    let parsed: DroneConversationEvent;
    try {
      parsed = JSON.parse(evt.payload);
    } catch {
      continue;
    }

    if (parsed.kind === 'userMessage') {
      currentTurn = { correlationId: evt.correlationId, messages: [] };
      turns.push(currentTurn);
    }

    if (currentTurn) {
      currentTurn.messages.push({
        kind: parsed.kind,
        content: 'content' in parsed ? parsed.content : undefined,
        name: 'name' in parsed ? parsed.name : undefined,
        arguments: 'arguments' in parsed ? parsed.arguments : undefined,
      });
    }
  }

  return turns;
}
```

### Step 3.4: Add `POST /sessions/:id/process` — mark as processing

**File:** `drone-coordinator/src/routes/swarm.ts`

```typescript
app.post<{ Params: { id: string } }>('/sessions/:id/process', async (request, reply) => {
  const result = db.transitionSessionStatus(
    request.params.id,
    ['active', 'stale', 'finished'],  // allowed from statuses
    'processing'
  );

  if ('error' in result) {
    const statusCode = result.error === 'Session not found' ? 404 : 409;
    return reply.code(statusCode).send(result);
  }

  // Return the session log for processing
  // (Reuse the log reconstruction from Step 3.3)
  const events = db.getSwarmEvents(request.params.id);
  const resolvedEvents = events.map(evt => {
    let payload = evt.payload;
    if (payload && payload.startsWith('blob:')) {
      try { payload = retrieveLargePayload(payload); } catch { payload = null; }
    }
    return { ...evt, payload };
  });

  return reply.send({
    session: result,
    events: resolvedEvents,
  });
});
```

### Step 3.5: Add `POST /sessions/:id/processed` — mark as processed

**File:** `drone-coordinator/src/routes/swarm.ts`

```typescript
app.post<{
  Params: { id: string };
  Body: { summary?: string; notes?: string };
}>('/sessions/:id/processed', async (request, reply) => {
  const result = db.transitionSessionStatus(
    request.params.id,
    'processing',  // only allowed from 'processing'
    'processed',
    { summary: request.body.summary, notes: request.body.notes }
  );

  if ('error' in result) {
    const statusCode = result.error === 'Session not found' ? 404 : 409;
    return reply.code(statusCode).send(result);
  }

  return reply.send({ session: result });
});
```

### Step 3.6: Stale session detection (background job)

**File:** `drone-coordinator/src/index.ts` (or a new `stale-detector.ts`)

Add a periodic background job that checks for sessions with no recent activity:

```typescript
// In the startup sequence, after initDatabase():
const STALE_THRESHOLD_MS = 48 * 60 * 60 * 1000; // 48 hours

const staleDetectionInterval = setInterval(() => {
  const staleSessions = db.getStaleSessions(STALE_THRESHOLD_MS);
  for (const session of staleSessions) {
    db.transitionSessionStatus(session.id, 'active', 'stale');
    logger.info(`Session ${session.id} marked as stale (no activity >48h)`);
  }
}, 60 * 60 * 1000); // check every hour
```

Add `getStaleSessions` to `db.ts`:

```typescript
export function getStaleSessions(thresholdMs: number): SwarmSession[] {
  const cutoff = Date.now() - thresholdMs;
  const stmt = getDatabase().prepare(`
    SELECT * FROM swarm_sessions
    WHERE status = 'active' AND updatedAt < ?
  `);
  return stmt.all(cutoff) as SwarmSession[];
}
```

**Dependencies:** Step 3.1

### Step 3.7: Beacon proxies session endpoints

**File:** `drone-beacon/src/routes/sync.ts`

Add proxy routes for the new session endpoints so agents can reach them through the beacon:

```typescript
// GET /sessions — list sessions
app.get('/sessions', async (request, reply) => {
  const client = getCoordinatorClient();
  if (!client) return reply.code(503).send({ error: 'Coordinator not connected' });
  const result = await client.getSessions(request.query);
  return reply.send(result);
});

// GET /sessions/:id/log — get session log
app.get<{ Params: { id: string } }>('/sessions/:id/log', async (request, reply) => {
  const client = getCoordinatorClient();
  if (!client) return reply.code(503).send({ error: 'Coordinator not connected' });
  const result = await client.getSessionLog(request.params.id);
  return reply.send(result);
});

// POST /sessions/:id/process — mark as processing
app.post<{ Params: { id: string } }>('/sessions/:id/process', async (request, reply) => {
  const client = getCoordinatorClient();
  if (!client) return reply.code(503).send({ error: 'Coordinator not connected' });
  const result = await client.processSession(request.params.id);
  return reply.send(result);
});

// POST /sessions/:id/processed — mark as processed
app.post<{ Params: { id: string }; Body: { summary?: string; notes?: string } }>(
  '/sessions/:id/processed', async (request, reply) => {
    const client = getCoordinatorClient();
    if (!client) return reply.code(503).send({ error: 'Coordinator not connected' });
    const result = await client.completeSessionProcessing(request.params.id, request.body);
    return reply.send(result);
  }
);
```

### Step 3.8: Add swarm tools for session pipeline

**File:** `drone-agent/src/plugins/swarm/index.ts`

Register new tools that agents can use to interact with the session pipeline:

```typescript
// session_list — list sessions with filters
registration.registerTool({
  name: 'session_list',
  description: 'List swarm sessions with optional status filter and sorting.',
  inputSchema: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['active', 'stale', 'finished', 'processing', 'processed'], description: 'Filter by status' },
      sortBy: { type: 'string', enum: ['createdAt', 'updatedAt'], description: 'Sort field' },
      sortDirection: { type: 'string', enum: ['ASC', 'DESC'], description: 'Sort direction' },
      limit: { type: 'number', description: 'Max results' },
      offset: { type: 'number', description: 'Pagination offset' },
    },
  },
  execute: async params => { /* GET /sessions?status=... */ },
  defaultHidden: false, // useful for discovery
});

// session_get_log — get full session log
registration.registerTool({
  name: 'session_get_log',
  description: 'Get the full conversation log for a session, suitable for ingestion.',
  inputSchema: {
    type: 'object',
    properties: {
      sessionId: { type: 'string', description: 'The session ID' },
    },
    required: ['sessionId'],
  },
  execute: async params => { /* GET /sessions/:id/log */ },
  defaultHidden: false, // needed by wiki-librarian
});

// session_mark_processed — mark session as processed
registration.registerTool({
  name: 'session_mark_processed',
  description: 'Mark a session as processed after successful ingestion.',
  inputSchema: {
    type: 'object',
    properties: {
      sessionId: { type: 'string', description: 'The session ID' },
      summary: { type: 'string', description: 'Optional summary of what was ingested' },
      notes: { type: 'string', description: 'Optional notes about the processing' },
    },
    required: ['sessionId'],
  },
  execute: async params => { /* POST /sessions/:id/processed */ },
  defaultHidden: true, // only wiki-librarian should use this
});
```

**Dependencies:** Step 3.7

---

## Phase 4: Default Assets

### Step 4.1: Create the `memory-wiki` skill

**File:** `skill-library/memory-wiki.md` (template) and seeded into coordinator

The skill should describe:

```markdown
---
name: memory-wiki
description: A description of the memory wiki's structure, how to explore it, and the proper way to ingest conversation history into it.
recall:
  - the user wants to understand the wiki structure
  - the user wants to ingest a session into the wiki
  - the user wants to explore the wiki
  - the user wants to know the difference between wiki and project memory
---

# Memory Wiki

## Structure

Wiki pages are stored as `.md` files with YAML frontmatter:

```yaml
---
id: my-page
title: My Page
scope: beacon  # or 'coordinator'
tags:
  - reference
sources:
  - session-abc123
---
```

Pages support `[[wiki links]]` for cross-references. The wiki enforces a "no downward links" rule: coordinator pages cannot link to beacon pages.

## Exploration

- `wiki_list` — list all pages
- `wiki_search` — search by keyword
- `wiki_read` — read a specific page
- `wiki_lint` — check for broken links, downward links, orphan pages

## Ingestion Workflow

1. Use `session_list` to find finished sessions
2. Use `session_get_log` to retrieve the full conversation
3. Analyze the conversation for key insights, decisions, patterns
4. Create or update wiki pages with `wiki_write`
5. Include the session ID in the `sources` field
6. Call `session_mark_processed` when done

## Wiki vs Project Memory

- **Wiki**: Persistent, structured, shared across the swarm. Use for documentation, architecture decisions, patterns, reference material.
- **Project Memory** (`memory__store`): Quick facts, local context, ephemeral notes. Use for temporary information that only this agent needs.
```

### Step 4.2: Create the `coordinator-wiki-librarian` persona

**File:** Seeded into coordinator's persona table

```markdown
---
name: coordinator-wiki-librarian
description: Suggested persona for scheduled and manual memory wiki maintenance sessions
color: #4488ff
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
---

# Coordinator Wiki Librarian

You are a knowledge management specialist for the drone-agent swarm. Your purpose is to maintain the swarm's memory wiki by ingesting conversation history, organizing knowledge, and ensuring the wiki remains accurate and well-structured.

## Your Tools

You have access to:
- **Wiki tools** (`wiki_read`, `wiki_write`, `wiki_search`, `wiki_list`, `wiki_lint`) — for reading and writing wiki pages
- **Session tools** (`session_list`, `session_get_log`, `session_mark_processed`) — for finding and processing sessions
- **Search tools** (`search__text`) — for searching text
- **Skill recall** (`skills__recall`) — for loading the memory-wiki skill
- **Memory read tools** (`memory__recall`, `memory__search`, `memory__list`) — for reading project memory
- **File read tools** (`file__read`, `file__list`, `file__glob`) — for reading files

You do NOT have access to:
- Shell execution (`exec.*`)
- File writing (`file.write`, `file.apply_diff`)
- Git operations (`git.*`)
- Self-improvement tools (`self-improvement.*`)
- Memory writing/deletion (`memory.store`, `memory.delete`)
- Wiki deletion (`swarm__wiki_delete`)

## Your Workflow

When asked to process a session:
1. Call `skills.recall({"id": "memory-wiki"})` to load the wiki skill
2. Use `session_list` to find finished sessions
3. Use `session_get_log` to retrieve the full conversation
4. Analyze the conversation for key insights, decisions, patterns
5. Create or update wiki pages with `wiki_write`
6. Call `session_mark_processed` when done
```

### Step 4.3: Create the `coordinator-admin` persona

**File:** Seeded into coordinator's persona table

```markdown
---
name: coordinator-admin
description: Persona with an overview of the drone framework's internals preloaded. Use for setup/maintenance questions and tasks.
color: #ff8844
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
---

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
- **Skills** provide the LLM with instructions on how to perform tasks. Skills are loaded via `skills.recall()`.
- **Wiki** is a shared knowledge base of markdown pages with YAML frontmatter, stored on the beacon/coordinator filesystem.
- **Migration tool** (`drone-migrate`) promotes/demotes assets between scopes (project ↔ user ↔ beacon ↔ coordinator).
- **Self-improvement** system records insights and derives principles that are injected into the system prompt.

## Your Tools

You have read-only access to most systems plus the ability to run the migration tool. You cannot execute shell commands, write files, or modify the wiki.

## Common Tasks

- "How do I set up TLS?" — Explain the `--https` flag and certificate auto-generation
- "What's the difference between beacon and coordinator scopes?" — Explain scope hierarchy
- "How do I migrate a persona from local to swarm?" — Explain the migration tool
- "Show me the current config" — Use `config__get` and `config__list_layers`
- "List all personas" — Use `persona__list`
```

### Step 4.4: Seed defaults on coordinator startup

**File:** `drone-coordinator/src/index.ts`

Add a `seedDefaults()` function that runs after `initDatabase()`:

```typescript
async function seedDefaults(db: Database, configDir: string): Promise<void> {
  // Check if default personas exist
  const existingPersonas = db.listPersonas();
  const existingPersonaIds = new Set(existingPersonas.map(p => p.id));

  if (!existingPersonaIds.has('coordinator-wiki-librarian')) {
    const personaContent = `...`; // content from Step 4.2
    db.createPersona({
      id: 'coordinator-wiki-librarian',
      name: 'Coordinator Wiki Librarian',
      description: 'Suggested persona for scheduled and manual memory wiki maintenance sessions',
      systemPrompt: personaContent,
      scope: 'coordinator',
    });
    logger.info('Seeded default persona: coordinator-wiki-librarian');
  }

  if (!existingPersonaIds.has('coordinator-admin')) {
    const personaContent = `...`; // content from Step 4.3
    db.createPersona({
      id: 'coordinator-admin',
      name: 'Coordinator Admin',
      description: 'Persona with an overview of the drone framework internals preloaded',
      systemPrompt: personaContent,
      scope: 'coordinator',
    });
    logger.info('Seeded default persona: coordinator-admin');
  }

  // Check if default skills exist
  const existingSkills = db.listSkills();
  const existingSkillIds = new Set(existingSkills.map(s => s.id));

  if (!existingSkillIds.has('memory-wiki')) {
    const skillContent = `...`; // content from Step 4.1
    db.createSkill({
      id: 'memory-wiki',
      name: 'Memory Wiki',
      description: 'A description of the memory wiki structure, exploration, and ingestion workflow',
      body: skillContent,
      scope: 'coordinator',
    });
    logger.info('Seeded default skill: memory-wiki');
  }
}
```

**Important:** The seed only runs if the items don't exist. If a user has customized or deleted them, they won't be re-created. This is the "leave them alone so the user can customize them" behavior.

**Dependencies:** Steps 4.1, 4.2, 4.3

---

## Phase 5: Coordinator Client Updates

### Step 5.1: Add methods to coordinator client

**File:** `drone-beacon/src/coordinator-client.ts`

Add methods for the new endpoints:

```typescript
export class CoordinatorClient {
  // ... existing methods ...

  async pushToolDefinitions(tools: Array<{ name: string; description: string; defaultHidden: boolean }>): Promise<void> {
    await this.fetch('/sync/tools/push', {
      method: 'POST',
      body: JSON.stringify({ tools }),
    });
  }

  async getDefaultHiddenTools(): Promise<{ tools: string[] }> {
    return this.fetch('/tools/default-hidden');
  }

  async getSessions(query: Record<string, string>): Promise<{ sessions: any[]; count: number }> {
    const params = new URLSearchParams(query).toString();
    return this.fetch(`/sessions?${params}`);
  }

  async getSessionLog(sessionId: string): Promise<any> {
    return this.fetch(`/sessions/${sessionId}/log`);
  }

  async processSession(sessionId: string): Promise<any> {
    return this.fetch(`/sessions/${sessionId}/process`, { method: 'POST' });
  }

  async completeSessionProcessing(sessionId: string, body: { summary?: string; notes?: string }): Promise<any> {
    return this.fetch(`/sessions/${sessionId}/processed`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }
}
```

---

## Validation Criteria

1. **All LSP checks pass** across all modified packages (`drone-core`, `drone-agent`, `drone-beacon`, `drone-coordinator`)
2. **`pnpm typecheck`** passes with no errors
3. **`pnpm lint`** passes with no errors
4. **`pnpm test`** passes — all existing tests continue to pass
5. **New tests exist** for:
   - `defaultHidden` filtering in persona plugin
   - Session status transitions in coordinator DB
   - Session log reconstruction
   - Default seeding idempotency (seeding twice doesn't duplicate)
   - Tool definition sync round-trip
6. **Manual verification:**
   - Start a fresh coordinator → verify `coordinator-wiki-librarian`, `coordinator-admin`, and `memory-wiki` are present
   - Connect an agent → verify tool definitions are pushed to coordinator
   - Create a new persona via `persona__create` → verify `defaultHidden` tools are excluded
   - Run a session through the full lifecycle: active → finished → processing → processed
   - Verify stale detection marks old sessions after threshold

---

## Dependencies Between Steps

```
Phase 1 (Foundation)
  ├── 1.1 defaultHidden on DroneToolDefinition
  ├── 1.2 defaultHidden on DroneToolDescriptor
  ├── 1.3 Engine propagation
  ├── 1.4 Session status constants
  ├── 1.5 Tool definitions table
  └── 1.6 Pre-seed built-in tools
       │
       ▼
Phase 2 (Tool Gating)
  ├── 2.1 Persona filtering respects defaultHidden  ← depends on 1.1, 1.2, 1.3
  ├── 2.2 Mark built-in tools as defaultHidden      ← depends on 1.1
  ├── 2.3 Agent pushes tool defs on connect          ← depends on 1.5
  ├── 2.4 Beacon proxies tool defs                  ← depends on 1.5
  ├── 2.5 Coordinator receives tool defs            ← depends on 1.5
  ├── 2.6 Beacon proxies GET /tools/default-hidden   ← depends on 2.5
  └── 2.7 Persona wizard auto-adds exclusions        ← depends on 2.6
       │
       ▼
Phase 3 (Session Pipeline)
  ├── 3.1 Expand status values                       ← depends on 1.4
  ├── 3.2 GET /sessions with filtering              ← depends on 3.1
  ├── 3.3 GET /sessions/:id/log                     ← depends on 3.1
  ├── 3.4 POST /sessions/:id/process               ← depends on 3.1, 3.3
  ├── 3.5 POST /sessions/:id/processed             ← depends on 3.1
  ├── 3.6 Stale detection background job            ← depends on 3.1
  ├── 3.7 Beacon proxies session endpoints          ← depends on 3.2-3.5
  └── 3.8 Swarm tools for session pipeline          ← depends on 3.7
       │
       ▼
Phase 4 (Default Assets)
  ├── 4.1 memory-wiki skill content
  ├── 4.2 coordinator-wiki-librarian persona content
  ├── 4.3 coordinator-admin persona content
  └── 4.4 Seed on coordinator startup               ← depends on 4.1, 4.2, 4.3
       │
       ▼
Phase 5 (Coordinator Client)
  └── 5.1 Add methods to CoordinatorClient          ← depends on 2.5, 3.7
```

**Recommended execution order:** Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5

Within each phase, steps can be parallelized where they have no inter-dependencies (e.g., 1.1 and 1.2 can be done together; 4.1, 4.2, 4.3 can be done in parallel).
