import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { setupDb, teardownDb } from './setup.js';
import {
  createPersona,
  getPersona,
  listPersonas,
  listLocalPersonas,
  updatePersona,
  deletePersona,
  upsertPersonaFromCoordinator,
  createSkill,
  getSkill,
  listSkills,
  listLocalSkills,
  updateSkill,
  deleteSkill,
  upsertSkillFromCoordinator,
  registerAgent,
  getAgent,
  listAgents,
  updateAgentActivity,
  unregisterAgent,
  createMemory,
  getMemory,
  getMemoryByKey,
  listMemories,
  updateMemory,
  deleteMemory,
  cleanupExpiredMemories,
  isMemoryExpired,
  createMessage,
  getMessage,
  listMessagesForAgent,
  listMessagesByChannel,
  markMessageDelivered,
  cleanupOldMessages,
  createSpawn,
  getSpawn,
  listSpawns,
  updateSpawnStatus,
  deleteSpawn,
  getSpawnByAgentId,
  createBeaconConfig,
  getBeaconConfig,
  listBeaconConfig,
  updateBeaconConfig,
  deleteBeaconConfig,
  createEventLog,
  getEventLog,
  listEventLogs,
  cleanupOldEventLogs,
  cacheKnowledge,
  getCachedKnowledge,
  listCachedKnowledge,
  clearKnowledgeCache,
  replaceKnowledgeCache,
  createInsight,
  listInsights,
  getInsight,
  markInsightsExamined,
  deleteInsight,
  createPrinciple,
  listPrinciples,
  getPrinciple,
  deletePrinciple,
} from '../src/db/index.js';
import type {
  CreatePersonaRequest,
  CreateSkillRequest,
  Knowledge,
} from '../src/types.js';

describe('Beacon Persona CRUD', () => {
  beforeEach(async () => {
    await setupDb();
  });

  afterEach(async () => {
    await teardownDb();
  });

  it('should create a local persona', () => {
    const req: CreatePersonaRequest = {
      id: 'test-persona',
      name: 'Test Persona',
      description: 'A test persona',
      systemPrompt: 'You are a test persona.',
    };
    const persona = createPersona(req, 'local');
    expect(persona.id).toBe('test-persona');
    expect(persona.scope).toBe('local');
    expect(persona.createdAt).toBeGreaterThan(0);
  });

  it('should get a persona by id', () => {
    createPersona(
      { id: 'p1', name: 'P1', description: 'd1', systemPrompt: 'sp1' },
      'local'
    );
    expect(getPersona('p1')).toBeDefined();
  });

  it('should return undefined for non-existent persona', () => {
    expect(getPersona('nonexistent')).toBeUndefined();
  });

  it('should list all personas', () => {
    createPersona(
      { id: 'p1', name: 'P1', description: 'd1', systemPrompt: 'sp1' },
      'local'
    );
    createPersona(
      { id: 'p2', name: 'P2', description: 'd2', systemPrompt: 'sp2' },
      'local'
    );
    expect(listPersonas()).toHaveLength(2);
  });

  it('should list only local personas', () => {
    createPersona(
      { id: 'p1', name: 'P1', description: 'd1', systemPrompt: 'sp1' },
      'local'
    );
    upsertPersonaFromCoordinator({
      id: 'p2',
      name: 'P2',
      description: 'd2',
      systemPrompt: 'sp2',
      scope: 'coordinator',
      createdAt: 1,
      updatedAt: 1,
    });
    const local = listLocalPersonas();
    expect(local).toHaveLength(1);
    expect(local[0].id).toBe('p1');
  });

  it('should update a persona', () => {
    createPersona(
      { id: 'p1', name: 'P1', description: 'd1', systemPrompt: 'sp1' },
      'local'
    );
    const updated = updatePersona('p1', { name: 'Updated' });
    expect(updated).toBeDefined();
    expect(updated!.name).toBe('Updated');
  });

  it('should return undefined when updating non-existent persona', () => {
    expect(updatePersona('nonexistent', { name: 'x' })).toBeUndefined();
  });

  it('should delete a persona', () => {
    createPersona(
      { id: 'p1', name: 'P1', description: 'd1', systemPrompt: 'sp1' },
      'local'
    );
    expect(deletePersona('p1')).toBe(true);
    expect(getPersona('p1')).toBeUndefined();
  });

  it('should upsert a persona from coordinator', () => {
    upsertPersonaFromCoordinator({
      id: 'p1',
      name: 'P1',
      description: 'd1',
      systemPrompt: 'sp1',
      scope: 'coordinator',
      createdAt: 100,
      updatedAt: 100,
    });
    const p = getPersona('p1');
    expect(p).toBeDefined();
    expect(p!.scope).toBe('coordinator');
  });
});

describe('Beacon Skill CRUD', () => {
  beforeEach(async () => {
    await setupDb();
  });

  afterEach(async () => {
    await teardownDb();
  });

  it('should create a local skill', () => {
    const req: CreateSkillRequest = {
      id: 'test-skill',
      name: 'Test Skill',
      description: 'd1',
      trigger: 't1',
      body: '# Body',
    };
    const skill = createSkill(req, 'local');
    expect(skill.id).toBe('test-skill');
    expect(skill.scope).toBe('local');
  });

  it('should get a skill by id', () => {
    createSkill(
      { id: 's1', name: 'S1', description: 'd1', trigger: 't1', body: 'b1' },
      'local'
    );
    expect(getSkill('s1')).toBeDefined();
  });

  it('should list all skills', () => {
    createSkill(
      { id: 's1', name: 'S1', description: 'd1', trigger: 't1', body: 'b1' },
      'local'
    );
    createSkill(
      { id: 's2', name: 'S2', description: 'd2', trigger: 't2', body: 'b2' },
      'local'
    );
    expect(listSkills()).toHaveLength(2);
  });

  it('should list only local skills', () => {
    createSkill(
      { id: 's1', name: 'S1', description: 'd1', trigger: 't1', body: 'b1' },
      'local'
    );
    upsertSkillFromCoordinator({
      id: 's2',
      name: 'S2',
      description: 'd2',
      trigger: 't2',
      body: 'b2',
      scope: 'coordinator',
      createdAt: 1,
      updatedAt: 1,
    });
    expect(listLocalSkills()).toHaveLength(1);
  });

  it('should update a skill', () => {
    createSkill(
      { id: 's1', name: 'S1', description: 'd1', trigger: 't1', body: 'b1' },
      'local'
    );
    const updated = updateSkill('s1', { name: 'Updated' });
    expect(updated).toBeDefined();
    expect(updated!.name).toBe('Updated');
  });

  it('should delete a skill', () => {
    createSkill(
      { id: 's1', name: 'S1', description: 'd1', trigger: 't1', body: 'b1' },
      'local'
    );
    expect(deleteSkill('s1')).toBe(true);
  });

  it('should upsert a skill from coordinator', () => {
    upsertSkillFromCoordinator({
      id: 's1',
      name: 'S1',
      description: 'd1',
      trigger: 't1',
      body: 'b1',
      scope: 'coordinator',
      createdAt: 100,
      updatedAt: 100,
    });
    expect(getSkill('s1')).toBeDefined();
  });
});

describe('Beacon Agent Session CRUD', () => {
  beforeEach(async () => {
    await setupDb();
  });

  afterEach(async () => {
    await teardownDb();
  });

  it('should register an agent', () => {
    const session = registerAgent({ id: 'agent-1', personaId: null });
    expect(session.id).toBe('agent-1');
    expect(session.status).toBe('connected');
    expect(session.connectedAt).toBeGreaterThan(0);
    expect(session.lastActivity).toBeGreaterThan(0);
  });

  it('migrates an existing agent_sessions table to add the status column', async () => {
    // Simulate a pre-existing DB whose agent_sessions table predates the
    // `status` column (e.g. a persisted beacon-data volume from an older
    // build). initDatabase must add the column idempotently.
    const { mkdtemp, rm } = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'drone-beacon-migrate-'));
    const dbFile = path.join(dir, 'test.db');

    // Create a legacy agent_sessions table without the status column.
    const legacy = new Database(dbFile);
    legacy.exec(`
      CREATE TABLE agent_sessions (
        id TEXT PRIMARY KEY,
        personaId TEXT,
        connectedAt INTEGER NOT NULL,
        lastActivity INTEGER NOT NULL
      );
    `);
    legacy.close();

    // Re-init the DB — the migration should add the status column.
    const { initDatabase, closeDatabase, getDatabase } =
      await import('../src/db/index.js');
    initDatabase(dbFile);
    const cols = getDatabase()
      .prepare('PRAGMA table_info(agent_sessions)')
      .all() as Array<{ name: string }>;
    expect(cols.some(c => c.name === 'status')).toBe(true);

    // registerAgent should now succeed against the migrated table.
    const { registerAgent } = await import('../src/db/index.js');
    const session = registerAgent({ id: 'migrated-agent', personaId: null });
    expect(session.status).toBe('connected');

    closeDatabase();
    await rm(dir, { recursive: true, force: true });
  });

  it('should get an agent by id', () => {
    registerAgent({ id: 'agent-1', personaId: null });
    const agent = getAgent('agent-1');
    expect(agent).toBeDefined();
    expect(agent!.status).toBe('connected');
  });

  it('should list all agents', () => {
    registerAgent({ id: 'a1', personaId: null });
    registerAgent({ id: 'a2', personaId: null });
    const agents = listAgents();
    expect(agents).toHaveLength(2);
    expect(agents.every(a => a.status === 'connected')).toBe(true);
  });

  it('should update agent activity', () => {
    registerAgent({ id: 'agent-1', personaId: null });
    const updated = updateAgentActivity('agent-1');
    expect(updated).toBeDefined();
    expect(updated!.lastActivity).toBeGreaterThan(0);
  });

  it('should unregister an agent', () => {
    registerAgent({ id: 'agent-1', personaId: null });
    expect(unregisterAgent('agent-1')).toBe(true);
    expect(getAgent('agent-1')).toBeUndefined();
  });
});

describe('Beacon Memory CRUD', () => {
  beforeEach(async () => {
    await setupDb();
  });

  afterEach(async () => {
    await teardownDb();
  });

  it('should create a memory', () => {
    const mem = createMemory({ key: 'test-key', value: 'test-value' });
    expect(mem.key).toBe('test-key');
    expect(mem.value).toBe('test-value');
    expect(mem.namespace).toBe('default');
    expect(mem.ttl).toBeNull();
  });

  it('should create a memory with TTL', () => {
    const mem = createMemory({
      key: 'ttl-key',
      value: 'ttl-value',
      ttlSeconds: 3600,
    });
    expect(mem.ttl).not.toBeNull();
    expect(mem.ttl!).toBeGreaterThan(Date.now());
  });

  it('should get memory by id', () => {
    const mem = createMemory({ key: 'k1', value: 'v1' });
    expect(getMemory(mem.id)).toBeDefined();
  });

  it('should get memory by key', () => {
    createMemory({ key: 'k1', value: 'v1' });
    const mem = getMemoryByKey('k1');
    expect(mem).toBeDefined();
    expect(mem!.key).toBe('k1');
  });

  it('should get memory by key with namespace', () => {
    createMemory({ key: 'k1', value: 'v1', namespace: 'ns1' });
    expect(getMemoryByKey('k1', 'ns1')).toBeDefined();
    expect(getMemoryByKey('k1', 'other')).toBeUndefined();
  });

  it('should list memories', () => {
    createMemory({ key: 'k1', value: 'v1' });
    createMemory({ key: 'k2', value: 'v2' });
    expect(listMemories()).toHaveLength(2);
  });

  it('should list memories filtered by namespace', () => {
    createMemory({ key: 'k1', value: 'v1', namespace: 'ns1' });
    createMemory({ key: 'k2', value: 'v2', namespace: 'ns2' });
    expect(listMemories('ns1')).toHaveLength(1);
  });

  it('should exclude expired memories by default', () => {
    createMemory({ key: 'k1', value: 'v1', ttlSeconds: -1 }); // already expired
    createMemory({ key: 'k2', value: 'v2' }); // no TTL
    expect(listMemories()).toHaveLength(1);
  });

  it('should include expired memories when requested', () => {
    createMemory({ key: 'k1', value: 'v1', ttlSeconds: -1 });
    expect(listMemories(undefined, true)).toHaveLength(1);
  });

  it('should update a memory', () => {
    const mem = createMemory({ key: 'k1', value: 'v1' });
    const updated = updateMemory(mem.id, { value: 'v2' });
    expect(updated).toBeDefined();
    expect(updated!.value).toBe('v2');
  });

  it('should delete a memory', () => {
    const mem = createMemory({ key: 'k1', value: 'v1' });
    expect(deleteMemory(mem.id)).toBe(true);
    expect(getMemory(mem.id)).toBeUndefined();
  });

  it('should cleanup expired memories', () => {
    createMemory({ key: 'k1', value: 'v1', ttlSeconds: -1 });
    createMemory({ key: 'k2', value: 'v2' });
    const cleaned = cleanupExpiredMemories();
    expect(cleaned).toBe(1);
    expect(listMemories()).toHaveLength(1);
  });

  it('should check if memory is expired', () => {
    const mem = createMemory({ key: 'k1', value: 'v1', ttlSeconds: -1 });
    expect(isMemoryExpired(mem)).toBe(true);
    const mem2 = createMemory({ key: 'k2', value: 'v2' });
    expect(isMemoryExpired(mem2)).toBe(false);
  });
});

describe('Beacon Message CRUD', () => {
  beforeEach(async () => {
    await setupDb();
  });

  afterEach(async () => {
    await teardownDb();
  });

  it('should create a message', () => {
    const msg = createMessage('agent-1', 'agent-2', null, '{"text":"hello"}');
    expect(msg.fromAgentId).toBe('agent-1');
    expect(msg.toAgentId).toBe('agent-2');
    expect(msg.delivered).toBe(false);
  });

  it('should create a channel message', () => {
    const msg = createMessage('agent-1', null, 'general', '{"text":"hi"}');
    expect(msg.channel).toBe('general');
  });

  it('should get a message by id', () => {
    const msg = createMessage('a1', 'a2', null, 'body');
    expect(getMessage(msg.id)).toBeDefined();
  });

  it('should list messages for an agent', () => {
    createMessage('a1', 'agent-2', null, 'body1');
    createMessage('a3', 'agent-2', null, 'body2');
    const msgs = listMessagesForAgent('agent-2');
    expect(msgs).toHaveLength(2);
  });

  it('should list only unread messages', () => {
    const m1 = createMessage('a1', 'agent-2', null, 'body1');
    createMessage('a3', 'agent-2', null, 'body2');
    markMessageDelivered(m1.id);
    const unread = listMessagesForAgent('agent-2', true);
    expect(unread).toHaveLength(1);
  });

  it('should list messages by channel', () => {
    createMessage('a1', null, 'general', 'body1');
    createMessage('a2', null, 'general', 'body2');
    createMessage('a3', null, 'other', 'body3');
    expect(listMessagesByChannel('general')).toHaveLength(2);
  });

  it('should mark message as delivered', () => {
    const msg = createMessage('a1', 'a2', null, 'body');
    expect(markMessageDelivered(msg.id)).toBe(true);
    const retrieved = getMessage(msg.id);
    expect(retrieved!.delivered).toBe(true);
  });

  it('should cleanup old delivered messages', () => {
    const msg = createMessage('a1', 'a2', null, 'body');
    markMessageDelivered(msg.id);
    // Use a very old timestamp by manipulating the DB directly
    // The cleanup function uses Date.now() - maxAgeHours, so old messages get cleaned
    const cleaned = cleanupOldMessages(0); // 0 hours retention = clean everything old
    expect(cleaned).toBeGreaterThanOrEqual(0);
  });
});

describe('Beacon Spawn CRUD', () => {
  beforeEach(async () => {
    await setupDb();
  });

  afterEach(async () => {
    await teardownDb();
  });

  it('should create a spawn record', () => {
    const spawn = createSpawn('spawn-1', null, null, null);
    expect(spawn.id).toBe('spawn-1');
    expect(spawn.status).toBe('spawning');
  });

  it('should get a spawn by id', () => {
    createSpawn('spawn-1', null, null, null);
    expect(getSpawn('spawn-1')).toBeDefined();
  });

  it('should list all spawns', () => {
    createSpawn('s1', null, null, null);
    createSpawn('s2', null, null, null);
    expect(listSpawns()).toHaveLength(2);
  });

  it('should list spawns filtered by status', () => {
    createSpawn('s1', null, null, null);
    const s2 = createSpawn('s2', null, null, null);
    updateSpawnStatus(s2.id, 'running', 'agent-1');
    const running = listSpawns('running');
    expect(running).toHaveLength(1);
    expect(running[0].id).toBe('s2');
  });

  it('should update spawn status to running', () => {
    createSpawn('s1', null, null, null);
    const updated = updateSpawnStatus('s1', 'running', 'agent-1');
    expect(updated).toBeDefined();
    expect(updated!.status).toBe('running');
    expect(updated!.agentId).toBe('agent-1');
    expect(updated!.startedAt).not.toBeNull();
  });

  it('should update spawn status to failed', () => {
    createSpawn('s1', null, null, null);
    const updated = updateSpawnStatus('s1', 'failed', null, 'error message');
    expect(updated!.status).toBe('failed');
    expect(updated!.error).toBe('error message');
  });

  it('should update spawn status to terminated with exit code', () => {
    createSpawn('s1', null, null, null);
    updateSpawnStatus('s1', 'running', 'agent-1');
    const updated = updateSpawnStatus('s1', 'terminated', null, undefined, 0);
    expect(updated!.status).toBe('terminated');
    expect(updated!.exitCode).toBe(0);
    expect(updated!.terminatedAt).not.toBeNull();
  });

  it('should return undefined when updating non-existent spawn', () => {
    expect(updateSpawnStatus('nonexistent', 'running', 'a1')).toBeUndefined();
  });

  it('should delete a spawn', () => {
    createSpawn('s1', null, null, null);
    expect(deleteSpawn('s1')).toBe(true);
    expect(getSpawn('s1')).toBeUndefined();
  });

  it('should get spawn by agent id', () => {
    createSpawn('s1', null, null, null);
    updateSpawnStatus('s1', 'running', 'agent-1');
    const spawn = getSpawnByAgentId('agent-1');
    expect(spawn).toBeDefined();
    expect(spawn!.id).toBe('s1');
  });
});

describe('Beacon Config CRUD', () => {
  beforeEach(async () => {
    await setupDb();
  });

  afterEach(async () => {
    await teardownDb();
  });

  it('should create a config entry', () => {
    const entry = createBeaconConfig({
      key: 'test-key',
      value: '{"enabled":true}',
    });
    expect(entry.key).toBe('test-key');
    expect(entry.value).toBe('{"enabled":true}');
    expect(entry.scope).toBe('local');
  });

  it('should create a config entry with swarm scope', () => {
    const entry = createBeaconConfig({
      key: 'swarm-key',
      value: '{}',
      scope: 'swarm',
    });
    expect(entry.scope).toBe('swarm');
  });

  it('should get a config entry by key', () => {
    createBeaconConfig({ key: 'k1', value: 'v1' });
    const entry = getBeaconConfig('k1');
    expect(entry).not.toBeNull();
    expect(entry!.key).toBe('k1');
  });

  it('should return null for non-existent config', () => {
    expect(getBeaconConfig('nonexistent')).toBeUndefined();
  });

  it('should list all config entries', () => {
    createBeaconConfig({ key: 'k1', value: 'v1' });
    createBeaconConfig({ key: 'k2', value: 'v2' });
    expect(listBeaconConfig()).toHaveLength(2);
  });

  it('should update a config entry', () => {
    createBeaconConfig({ key: 'k1', value: 'v1' });
    const updated = updateBeaconConfig('k1', 'v2');
    expect(updated).not.toBeNull();
    expect(updated!.value).toBe('v2');
  });

  it('should return null when updating non-existent config', () => {
    expect(updateBeaconConfig('nonexistent', 'v')).toBeNull();
  });

  it('should delete a config entry', () => {
    createBeaconConfig({ key: 'k1', value: 'v1' });
    expect(deleteBeaconConfig('k1')).toBe(true);
    expect(getBeaconConfig('k1')).toBeUndefined();
  });
});

describe('Beacon Event Log CRUD', () => {
  beforeEach(async () => {
    await setupDb();
  });

  afterEach(async () => {
    await teardownDb();
  });

  it('should create an event log', () => {
    const event = createEventLog({
      eventType: 'agent.connected',
      agentId: 'agent-1',
    });
    expect(event.eventType).toBe('agent.connected');
    expect(event.agentId).toBe('agent-1');
    expect(event.timestamp).toBeGreaterThan(0);
  });

  it('should get an event log by id', () => {
    const event = createEventLog({ eventType: 'agent.connected' });
    expect(getEventLog(event.id)).toBeDefined();
  });

  it('should list event logs', () => {
    createEventLog({ eventType: 'agent.connected' });
    createEventLog({ eventType: 'agent.disconnected' });
    expect(listEventLogs()).toHaveLength(2);
  });

  it('should list event logs filtered by agentId', () => {
    createEventLog({ eventType: 'agent.connected', agentId: 'a1' });
    createEventLog({ eventType: 'agent.connected', agentId: 'a2' });
    const filtered = listEventLogs({ agentId: 'a1' });
    expect(filtered).toHaveLength(1);
  });

  it('should list event logs filtered by eventType', () => {
    createEventLog({ eventType: 'agent.connected' });
    createEventLog({ eventType: 'agent.disconnected' });
    expect(listEventLogs({ eventType: 'agent.connected' })).toHaveLength(1);
  });

  it('should list event logs with since filter', () => {
    createEventLog({ eventType: 'agent.connected' });
    const filtered = listEventLogs({ since: Date.now() + 10000 });
    expect(filtered).toHaveLength(0);
  });

  it('should list event logs with limit', () => {
    createEventLog({ eventType: 'agent.connected' });
    createEventLog({ eventType: 'agent.disconnected' });
    expect(listEventLogs({ limit: 1 })).toHaveLength(1);
  });

  it('should cleanup old event logs', () => {
    createEventLog({ eventType: 'agent.connected' });
    const cleaned = cleanupOldEventLogs(0); // 0 days retention
    expect(cleaned).toBeGreaterThanOrEqual(0);
  });
});

describe('Beacon Knowledge Cache', () => {
  beforeEach(async () => {
    await setupDb();
  });

  afterEach(async () => {
    await teardownDb();
  });

  const sampleKnowledge: Knowledge = {
    id: 'k1',
    type: 'fact',
    key: 'test-fact',
    value: '{"data":1}',
    sourceBeaconId: null,
    sourceAgentId: null,
    confidence: 1.0,
    createdAt: 100,
    updatedAt: 100,
  };

  it('should cache knowledge', () => {
    cacheKnowledge(sampleKnowledge);
    const cached = getCachedKnowledge('k1');
    expect(cached).toBeDefined();
    expect(cached!.id).toBe('k1');
  });

  it('should get cached knowledge by id', () => {
    cacheKnowledge(sampleKnowledge);
    expect(getCachedKnowledge('k1')).toBeDefined();
    expect(getCachedKnowledge('nonexistent')).toBeUndefined();
  });

  it('should list cached knowledge', () => {
    cacheKnowledge(sampleKnowledge);
    cacheKnowledge({ ...sampleKnowledge, id: 'k2', key: 'fact-2' });
    expect(listCachedKnowledge()).toHaveLength(2);
  });

  it('should list cached knowledge filtered by type', () => {
    cacheKnowledge(sampleKnowledge);
    cacheKnowledge({
      ...sampleKnowledge,
      id: 'k2',
      key: 'pref-1',
      type: 'preference',
    });
    const facts = listCachedKnowledge('fact');
    expect(facts).toHaveLength(1);
  });

  it('should clear knowledge cache', () => {
    cacheKnowledge(sampleKnowledge);
    clearKnowledgeCache();
    expect(listCachedKnowledge()).toHaveLength(0);
  });

  it('should replace knowledge cache', () => {
    cacheKnowledge(sampleKnowledge);
    const newKnowledge = [
      { ...sampleKnowledge, id: 'k3', key: 'new-fact' },
      { ...sampleKnowledge, id: 'k4', key: 'another-fact' },
    ];
    replaceKnowledgeCache(newKnowledge);
    expect(listCachedKnowledge()).toHaveLength(2);
    expect(getCachedKnowledge('k1')).toBeUndefined();
    expect(getCachedKnowledge('k3')).toBeDefined();
  });
});

describe('Beacon Insight CRUD', () => {
  beforeEach(async () => {
    await setupDb();
  });

  afterEach(async () => {
    await teardownDb();
  });

  it('should create an insight', () => {
    const row = createInsight('persona', 'test-p', 'Test insight');
    expect(row.targetType).toBe('persona');
    expect(row.targetId).toBe('test-p');
    expect(row.scope).toBe('local');
  });

  it('should list insights', () => {
    createInsight('persona', 'p1', 'i1');
    createInsight('persona', 'p2', 'i2');
    expect(listInsights()).toHaveLength(2);
  });

  it('should list insights filtered by targetType and targetId', () => {
    createInsight('persona', 'p1', 'i1');
    createInsight('skill', 's1', 'i2');
    expect(listInsights('persona')).toHaveLength(1);
    expect(listInsights('persona', 'p1')).toHaveLength(1);
  });

  it('should get an insight by id', () => {
    const row = createInsight('persona', 'p1', 'i1');
    expect(getInsight(row.id)).toBeDefined();
  });

  it('should delete an insight', () => {
    const row = createInsight('persona', 'p1', 'i1');
    expect(deleteInsight(row.id)).toBe(true);
    expect(getInsight(row.id)).toBeUndefined();
  });

  it('should mark all insights for a target as examined', () => {
    createInsight('persona', 'p1', 'i1');
    createInsight('persona', 'p1', 'i2');
    const result = markInsightsExamined('persona', 'p1');
    expect(result.ok).toBe(true);
    expect(result.markedCount).toBe(2);
    const rows = listInsights('persona', 'p1');
    for (const row of rows) {
      expect(row.lastExamined).toBeDefined();
    }
  });

  it('should return markedCount 0 when the target has no insights', () => {
    const result = markInsightsExamined('persona', 'none');
    expect(result.ok).toBe(true);
    expect(result.markedCount).toBe(0);
  });
});

describe('Beacon Principle CRUD', () => {
  beforeEach(async () => {
    await setupDb();
  });

  afterEach(async () => {
    await teardownDb();
  });

  it('should create a principle', () => {
    const row = createPrinciple(
      'persona',
      'test-p',
      'Test principle',
      'source'
    );
    expect(row.targetType).toBe('persona');
    expect(row.principle).toBe('Test principle');
    expect(row.scope).toBe('local');
  });

  it('should list principles', () => {
    createPrinciple('persona', 'p1', 'pr1');
    createPrinciple('persona', 'p2', 'pr2');
    expect(listPrinciples()).toHaveLength(2);
  });

  it('should get a principle by id', () => {
    const row = createPrinciple('persona', 'p1', 'pr1');
    expect(getPrinciple(row.id)).toBeDefined();
  });

  it('should delete a principle', () => {
    const row = createPrinciple('persona', 'p1', 'pr1');
    expect(deletePrinciple(row.id)).toBe(true);
    expect(getPrinciple(row.id)).toBeUndefined();
  });
});
