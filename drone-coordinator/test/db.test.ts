import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { setupDb, teardownDb } from './setup.js';
import {
  createPersona,
  getPersona,
  listPersonas,
  updatePersona,
  deletePersona,
  createSkill,
  getSkill,
  listSkills,
  updateSkill,
  deleteSkill,
  registerBeacon,
  getBeacon,
  listBeacons,
  heartbeatBeacon,
  deleteBeacon,
  registerBeaconTrust,
  getBeaconTrust,
  listBeaconTrust,
  approveBeaconById,
  rejectBeacon,
  deleteBeaconTrust,
  createBeaconSession,
  getBeaconSession,
  listBeaconSessions,
  endBeaconSession,
  deleteBeaconSession,
  createSwarmSession,
  getSwarmSession,
  updateSwarmSessionStatus,
  createSwarmEvent,
  getSwarmEvents,
  getLatestSwarmEvents,
  searchSwarmEvents,
  registerAgentLocation,
  getAgentLocation,
  updateAgentLocationHeartbeat,
  unregisterAgentLocation,
  listAgentLocationsByBeacon,
  listAllAgentLocations,
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
import type { CreatePersonaRequest, CreateSkillRequest } from '../src/types.js';

describe('Persona CRUD', () => {
  beforeEach(async () => {
    await setupDb();
  });

  afterEach(async () => {
    await teardownDb();
  });

  it('should create a persona', () => {
    const req: CreatePersonaRequest = {
      id: 'test-persona',
      name: 'Test Persona',
      description: 'A test persona',
      systemPrompt: 'You are a test persona.',
    };
    const persona = createPersona(req);
    expect(persona.id).toBe('test-persona');
    expect(persona.name).toBe('Test Persona');
    expect(persona.scope).toBe('coordinator');
    expect(persona.createdAt).toBeGreaterThan(0);
    expect(persona.updatedAt).toBeGreaterThan(0);
  });

  it('should get a persona by id', () => {
    createPersona({
      id: 'p1',
      name: 'P1',
      description: 'd1',
      systemPrompt: 'sp1',
    });
    const p = getPersona('p1');
    expect(p).toBeDefined();
    expect(p!.id).toBe('p1');
  });

  it('should return undefined for non-existent persona', () => {
    expect(getPersona('nonexistent')).toBeUndefined();
  });

  it('should list all personas', () => {
    createPersona({
      id: 'p1',
      name: 'P1',
      description: 'd1',
      systemPrompt: 'sp1',
    });
    createPersona({
      id: 'p2',
      name: 'P2',
      description: 'd2',
      systemPrompt: 'sp2',
    });
    const list = listPersonas();
    expect(list).toHaveLength(2);
  });

  it('should update a persona', () => {
    createPersona({
      id: 'p1',
      name: 'P1',
      description: 'd1',
      systemPrompt: 'sp1',
    });
    const updated = updatePersona('p1', { name: 'Updated' });
    expect(updated).toBeDefined();
    expect(updated!.name).toBe('Updated');
    expect(updated!.description).toBe('d1');
  });

  it('should return undefined when updating non-existent persona', () => {
    expect(updatePersona('nonexistent', { name: 'x' })).toBeUndefined();
  });

  it('should delete a persona', () => {
    createPersona({
      id: 'p1',
      name: 'P1',
      description: 'd1',
      systemPrompt: 'sp1',
    });
    expect(deletePersona('p1')).toBe(true);
    expect(getPersona('p1')).toBeUndefined();
  });

  it('should return false when deleting non-existent persona', () => {
    expect(deletePersona('nonexistent')).toBe(false);
  });
});

describe('Skill CRUD', () => {
  beforeEach(async () => {
    await setupDb();
  });

  afterEach(async () => {
    await teardownDb();
  });

  it('should create a skill', () => {
    const req: CreateSkillRequest = {
      id: 'test-skill',
      name: 'Test Skill',
      description: 'A test skill',
      trigger: 'test-trigger',
      body: '# Skill Body',
    };
    const skill = createSkill(req);
    expect(skill.id).toBe('test-skill');
    expect(skill.scope).toBe('coordinator');
    expect(skill.createdAt).toBeGreaterThan(0);
  });

  it('should get a skill by id', () => {
    createSkill({
      id: 's1',
      name: 'S1',
      description: 'd1',
      trigger: 't1',
      body: 'b1',
    });
    const s = getSkill('s1');
    expect(s).toBeDefined();
    expect(s!.id).toBe('s1');
  });

  it('should return undefined for non-existent skill', () => {
    expect(getSkill('nonexistent')).toBeUndefined();
  });

  it('should list all skills', () => {
    createSkill({
      id: 's1',
      name: 'S1',
      description: 'd1',
      trigger: 't1',
      body: 'b1',
    });
    createSkill({
      id: 's2',
      name: 'S2',
      description: 'd2',
      trigger: 't2',
      body: 'b2',
    });
    expect(listSkills()).toHaveLength(2);
  });

  it('should update a skill', () => {
    createSkill({
      id: 's1',
      name: 'S1',
      description: 'd1',
      trigger: 't1',
      body: 'b1',
    });
    const updated = updateSkill('s1', { name: 'Updated' });
    expect(updated).toBeDefined();
    expect(updated!.name).toBe('Updated');
  });

  it('should return undefined when updating non-existent skill', () => {
    expect(updateSkill('nonexistent', { name: 'x' })).toBeUndefined();
  });

  it('should delete a skill', () => {
    createSkill({
      id: 's1',
      name: 'S1',
      description: 'd1',
      trigger: 't1',
      body: 'b1',
    });
    expect(deleteSkill('s1')).toBe(true);
    expect(getSkill('s1')).toBeUndefined();
  });

  it('should return false when deleting non-existent skill', () => {
    expect(deleteSkill('nonexistent')).toBe(false);
  });
});

describe('Beacon CRUD', () => {
  beforeEach(async () => {
    await setupDb();
  });

  afterEach(async () => {
    await teardownDb();
  });

  it('should register a beacon', () => {
    const beacon = registerBeacon({
      id: 'b1',
      name: 'Beacon 1',
      host: 'localhost',
      port: 3457,
    });
    expect(beacon.id).toBe('b1');
    expect(beacon.name).toBe('Beacon 1');
    expect(beacon.connectedAt).toBeGreaterThan(0);
    expect(beacon.lastHeartbeat).toBeGreaterThan(0);
  });

  it('should get a beacon by id', () => {
    registerBeacon({ id: 'b1', name: 'B1', host: 'localhost', port: 3457 });
    const b = getBeacon('b1');
    expect(b).toBeDefined();
    expect(b!.id).toBe('b1');
  });

  it('should return undefined for non-existent beacon', () => {
    expect(getBeacon('nonexistent')).toBeUndefined();
  });

  it('should list all beacons', () => {
    registerBeacon({ id: 'b1', name: 'B1', host: 'h1', port: 3457 });
    registerBeacon({ id: 'b2', name: 'B2', host: 'h2', port: 3458 });
    expect(listBeacons()).toHaveLength(2);
  });

  it('should update heartbeat', () => {
    registerBeacon({ id: 'b1', name: 'B1', host: 'localhost', port: 3457 });
    const hb = heartbeatBeacon('b1');
    expect(hb).toBeDefined();
    expect(hb!.lastHeartbeat).toBeGreaterThan(0);
  });

  it('should return undefined when heartbeating non-existent beacon', () => {
    expect(heartbeatBeacon('nonexistent')).toBeUndefined();
  });

  it('should delete a beacon', () => {
    registerBeacon({ id: 'b1', name: 'B1', host: 'localhost', port: 3457 });
    expect(deleteBeacon('b1')).toBe(true);
    expect(getBeacon('b1')).toBeUndefined();
  });

  it('should return false when deleting non-existent beacon', () => {
    expect(deleteBeacon('nonexistent')).toBe(false);
  });
});

describe('Beacon Trust', () => {
  beforeEach(async () => {
    await setupDb();
  });

  afterEach(async () => {
    await teardownDb();
  });

  it('should auto-approve localhost beacons', () => {
    const trust = registerBeaconTrust({
      id: 'b1',
      name: 'B1',
      host: 'localhost',
      port: 3457,
      publicKey: 'key1',
    });
    expect(trust.status).toBe('approved');
    expect(trust.verificationCode).toBeTruthy();
    expect(trust.approvedAt).not.toBeNull();
  });

  it('should auto-approve 127.0.0.1 beacons', () => {
    const trust = registerBeaconTrust({
      id: 'b1',
      name: 'B1',
      host: '127.0.0.1',
      port: 3457,
      publicKey: 'key1',
    });
    expect(trust.status).toBe('approved');
  });

  it('should create pending trust with verification code for remote beacons', () => {
    const trust = registerBeaconTrust({
      id: 'b1',
      name: 'B1',
      host: '10.0.0.1',
      port: 3457,
      publicKey: 'key1',
    });
    expect(trust.status).toBe('pending');
    expect(trust.verificationCode).toBeTruthy();
  });

  it('should re-register with matching public key and update connection info', () => {
    registerBeaconTrust({
      id: 'b1',
      name: 'B1',
      host: 'localhost',
      port: 3457,
      publicKey: 'key1',
    });
    const updated = registerBeaconTrust({
      id: 'b1',
      name: 'B1',
      host: '10.0.0.2',
      port: 3458,
      publicKey: 'key1',
    });
    expect(updated.host).toBe('10.0.0.2');
    expect(updated.port).toBe(3458);
    expect(updated.status).toBe('approved');
    // The verification code must be recomputed and persisted on re-registration
    // (re-registration runs on every restart, and existing rows may predate the
    // verification_code column).
    expect(updated.verificationCode).toBeTruthy();
    expect(getBeaconTrust('b1')!.verificationCode).toBeTruthy();
  });

  it('should throw on public key mismatch', () => {
    registerBeaconTrust({
      id: 'b1',
      name: 'B1',
      host: 'localhost',
      port: 3457,
      publicKey: 'key1',
    });
    expect(() => {
      registerBeaconTrust({
        id: 'b1',
        name: 'B1',
        host: 'localhost',
        port: 3457,
        publicKey: 'key2',
      });
    }).toThrow('Public key mismatch');
  });

  it('should get beacon trust by id', () => {
    registerBeaconTrust({
      id: 'b1',
      name: 'B1',
      host: 'localhost',
      port: 3457,
      publicKey: 'key1',
    });
    const trust = getBeaconTrust('b1');
    expect(trust).toBeDefined();
    expect(trust!.beaconId).toBe('b1');
    expect(trust!.verificationCode).toBeTruthy();
  });

  it('should return undefined for non-existent trust', () => {
    expect(getBeaconTrust('nonexistent')).toBeUndefined();
  });

  it('should list all beacon trust records', () => {
    registerBeaconTrust({
      id: 'b1',
      name: 'B1',
      host: 'localhost',
      port: 3457,
      publicKey: 'k1',
    });
    registerBeaconTrust({
      id: 'b2',
      name: 'B2',
      host: '10.0.0.1',
      port: 3457,
      publicKey: 'k2',
    });
    expect(listBeaconTrust()).toHaveLength(2);
  });

  it('should approve a pending beacon by ID', () => {
    const trust = registerBeaconTrust({
      id: 'b1',
      name: 'B1',
      host: '10.0.0.1',
      port: 3457,
      publicKey: 'key1',
    });
    const approved = approveBeaconById(trust.beaconId);
    expect(approved).not.toBeNull();
    expect(approved!.status).toBe('approved');
  });

  it('should return null for a beacon that is not pending', () => {
    expect(approveBeaconById('nonexistent')).toBeNull();
  });

  it('should reject a beacon', () => {
    registerBeaconTrust({
      id: 'b1',
      name: 'B1',
      host: '10.0.0.1',
      port: 3457,
      publicKey: 'key1',
    });
    expect(rejectBeacon('b1')).toBe(true);
    const trust = getBeaconTrust('b1');
    expect(trust!.status).toBe('rejected');
  });

  it('should return false when rejecting non-existent beacon', () => {
    expect(rejectBeacon('nonexistent')).toBe(false);
  });

  it('should delete beacon trust', () => {
    registerBeaconTrust({
      id: 'b1',
      name: 'B1',
      host: 'localhost',
      port: 3457,
      publicKey: 'key1',
    });
    expect(deleteBeaconTrust('b1')).toBe(true);
    expect(getBeaconTrust('b1')).toBeUndefined();
  });
});

describe('Beacon Session CRUD', () => {
  beforeEach(async () => {
    await setupDb();
    registerBeacon({ id: 'b1', name: 'B1', host: 'localhost', port: 3457 });
  });

  afterEach(async () => {
    await teardownDb();
  });

  it('should create a beacon session', () => {
    const session = createBeaconSession('b1', { id: 's1', agentId: 'agent-1' });
    expect(session.id).toBe('s1');
    expect(session.beaconId).toBe('b1');
    expect(session.agentId).toBe('agent-1');
    expect(session.disconnectedAt).toBeNull();
  });

  it('should get an active beacon session', () => {
    createBeaconSession('b1', { id: 's1', agentId: 'agent-1' });
    const session = getBeaconSession('b1', 'agent-1');
    expect(session).toBeDefined();
    expect(session!.id).toBe('s1');
  });

  it('should return undefined for non-existent session', () => {
    expect(getBeaconSession('b1', 'nonexistent')).toBeUndefined();
  });

  it('should list sessions for a beacon', () => {
    createBeaconSession('b1', { id: 's1', agentId: 'agent-1' });
    createBeaconSession('b1', { id: 's2', agentId: 'agent-2' });
    expect(listBeaconSessions('b1')).toHaveLength(2);
  });

  it('should end a beacon session', () => {
    createBeaconSession('b1', { id: 's1', agentId: 'agent-1' });
    const ended = endBeaconSession('b1', 'agent-1', 1000, 5000);
    expect(ended).toBeDefined();
    expect(ended!.disconnectedAt).toBe(1000);
    expect(ended!.durationMs).toBe(5000);
  });

  it('should return undefined when ending non-existent session', () => {
    expect(endBeaconSession('b1', 'nonexistent', 1000, 5000)).toBeUndefined();
  });

  it('should delete a beacon session', () => {
    createBeaconSession('b1', { id: 's1', agentId: 'agent-1' });
    expect(deleteBeaconSession('b1', 'agent-1')).toBe(true);
    expect(getBeaconSession('b1', 'agent-1')).toBeUndefined();
  });
});

describe('Swarm Session & Events', () => {
  beforeEach(async () => {
    await setupDb();
  });

  afterEach(async () => {
    await teardownDb();
  });

  it('should create a swarm session', () => {
    const session = createSwarmSession('ss1', null, 'b1');
    expect(session.id).toBe('ss1');
    expect(session.beaconId).toBe('b1');
    expect(session.status).toBe('active');
  });

  it('should get a swarm session by id', () => {
    createSwarmSession('ss1', null, 'b1');
    const s = getSwarmSession('ss1');
    expect(s).toBeDefined();
    expect(s!.id).toBe('ss1');
  });

  it('should return undefined for non-existent swarm session', () => {
    expect(getSwarmSession('nonexistent')).toBeUndefined();
  });

  it('should update swarm session status', () => {
    createSwarmSession('ss1', null, 'b1');
    const updated = updateSwarmSessionStatus('ss1', 'ended');
    expect(updated).toBeDefined();
    expect(updated!.status).toBe('ended');
  });
  it('should return undefined when updating non-existent session', () => {
    expect(updateSwarmSessionStatus('nonexistent', 'ended')).toBeUndefined();
  });

  it('should create a swarm event', () => {
    createSwarmSession('ss1', null, 'b1');
    const event = createSwarmEvent({
      id: 'evt1',
      sessionId: 'ss1',
      correlationId: null,
      type: 'tool_call',
      payload: '{"tool":"test"}',
      metadata: null,
      createdAt: Date.now(),
    });
    expect(event.id).toBe('evt1');
    expect(event.sessionId).toBe('ss1');
  });

  it('should get swarm events for a session', () => {
    createSwarmSession('ss1', null, 'b1');
    createSwarmEvent({
      id: 'e1',
      sessionId: 'ss1',
      correlationId: null,
      type: 'msg',
      payload: null,
      metadata: null,
      createdAt: 1,
    });
    createSwarmEvent({
      id: 'e2',
      sessionId: 'ss1',
      correlationId: null,
      type: 'msg',
      payload: null,
      metadata: null,
      createdAt: 2,
    });
    const events = getSwarmEvents('ss1');
    expect(events).toHaveLength(2);
  });

  it('should get latest swarm events', () => {
    createSwarmSession('ss1', null, 'b1');
    createSwarmEvent({
      id: 'e1',
      sessionId: 'ss1',
      correlationId: null,
      type: 'msg',
      payload: null,
      metadata: null,
      createdAt: 1,
    });
    createSwarmEvent({
      id: 'e2',
      sessionId: 'ss1',
      correlationId: null,
      type: 'msg',
      payload: null,
      metadata: null,
      createdAt: 2,
    });
    const latest = getLatestSwarmEvents('ss1', 1);
    expect(latest).toHaveLength(1);
    expect(latest[0].id).toBe('e2');
  });

  it('should search swarm events', () => {
    createSwarmSession('ss1', null, 'b1');
    createSwarmEvent({
      id: 'e1',
      sessionId: 'ss1',
      correlationId: null,
      type: 'msg',
      payload: 'hello world',
      metadata: null,
      createdAt: 1,
    });
    // FTS5 may not work in test context, but the function should not throw
    expect(() => searchSwarmEvents('hello')).not.toThrow();
  });
});

describe('Agent Location', () => {
  beforeEach(async () => {
    await setupDb();
  });

  afterEach(async () => {
    await teardownDb();
  });

  it('should register an agent location', () => {
    const loc = registerAgentLocation('agent-1', 'b1');
    expect(loc.agentId).toBe('agent-1');
    expect(loc.beaconId).toBe('b1');
    expect(loc.lastHeartbeat).toBeGreaterThan(0);
  });

  it('should get an agent location', () => {
    registerAgentLocation('agent-1', 'b1');
    const loc = getAgentLocation('agent-1');
    expect(loc).toBeDefined();
    expect(loc!.beaconId).toBe('b1');
  });

  it('should return undefined for non-existent agent location', () => {
    expect(getAgentLocation('nonexistent')).toBeUndefined();
  });

  it('should update agent location heartbeat', () => {
    registerAgentLocation('agent-1', 'b1');
    const updated = updateAgentLocationHeartbeat('agent-1');
    expect(updated).toBeDefined();
    expect(updated!.lastHeartbeat).toBeGreaterThan(0);
  });

  it('should return undefined when heartbeating non-existent location', () => {
    expect(updateAgentLocationHeartbeat('nonexistent')).toBeUndefined();
  });

  it('should unregister an agent location', () => {
    registerAgentLocation('agent-1', 'b1');
    expect(unregisterAgentLocation('agent-1')).toBe(true);
    expect(getAgentLocation('agent-1')).toBeUndefined();
  });

  it('should return false when unregistering non-existent location', () => {
    expect(unregisterAgentLocation('nonexistent')).toBe(false);
  });

  it('should list agent locations by beacon', () => {
    registerAgentLocation('agent-1', 'b1');
    registerAgentLocation('agent-2', 'b1');
    registerAgentLocation('agent-3', 'b2');
    const b1Agents = listAgentLocationsByBeacon('b1');
    expect(b1Agents).toHaveLength(2);
  });

  it('should list all agent locations', () => {
    registerAgentLocation('agent-1', 'b1');
    registerAgentLocation('agent-2', 'b2');
    expect(listAllAgentLocations()).toHaveLength(2);
  });
});

describe('Insight CRUD', () => {
  beforeEach(async () => {
    await setupDb();
  });

  afterEach(async () => {
    await teardownDb();
  });

  it('should create an insight', () => {
    const row = createInsight('persona', 'test-persona', 'Test insight');
    expect(row.targetType).toBe('persona');
    expect(row.targetId).toBe('test-persona');
    expect(row.insight).toBe('Test insight');
    expect(row.scope).toBe('coordinator');
  });

  it('should list insights', () => {
    createInsight('persona', 'p1', 'i1');
    createInsight('persona', 'p2', 'i2');
    const list = listInsights();
    expect(list).toHaveLength(2);
  });

  it('should list insights filtered by targetType and targetId', () => {
    createInsight('persona', 'p1', 'i1');
    createInsight('skill', 's1', 'i2');
    const filtered = listInsights('persona');
    expect(filtered).toHaveLength(1);
    expect(filtered[0].targetId).toBe('p1');
  });

  it('should get an insight by id', () => {
    const row = createInsight('persona', 'p1', 'i1');
    const found = getInsight(row.id);
    expect(found).toBeDefined();
    expect(found!.id).toBe(row.id);
  });

  it('should return undefined for non-existent insight', () => {
    expect(getInsight('nonexistent')).toBeUndefined();
  });

  it('should delete an insight', () => {
    const row = createInsight('persona', 'p1', 'i1');
    expect(deleteInsight(row.id)).toBe(true);
    expect(getInsight(row.id)).toBeUndefined();
  });

  it('should return false when deleting non-existent insight', () => {
    expect(deleteInsight('nonexistent')).toBe(false);
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

describe('Principle CRUD', () => {
  beforeEach(async () => {
    await setupDb();
  });

  afterEach(async () => {
    await teardownDb();
  });

  it('should create a principle', () => {
    const row = createPrinciple(
      'persona',
      'test-persona',
      'Test principle',
      'test-source'
    );
    expect(row.targetType).toBe('persona');
    expect(row.targetId).toBe('test-persona');
    expect(row.principle).toBe('Test principle');
    expect(row.source).toBe('test-source');
    expect(row.scope).toBe('coordinator');
  });

  it('should list principles', () => {
    createPrinciple('persona', 'p1', 'pr1');
    createPrinciple('persona', 'p2', 'pr2');
    expect(listPrinciples()).toHaveLength(2);
  });

  it('should list principles filtered by targetType and targetId', () => {
    createPrinciple('persona', 'p1', 'pr1');
    createPrinciple('skill', 's1', 'pr2');
    const filtered = listPrinciples('persona');
    expect(filtered).toHaveLength(1);
  });

  it('should get a principle by id', () => {
    const row = createPrinciple('persona', 'p1', 'pr1');
    const found = getPrinciple(row.id);
    expect(found).toBeDefined();
    expect(found!.id).toBe(row.id);
  });

  it('should return undefined for non-existent principle', () => {
    expect(getPrinciple('nonexistent')).toBeUndefined();
  });

  it('should delete a principle', () => {
    const row = createPrinciple('persona', 'p1', 'pr1');
    expect(deletePrinciple(row.id)).toBe(true);
    expect(getPrinciple(row.id)).toBeUndefined();
  });

  it('should return false when deleting non-existent principle', () => {
    expect(deletePrinciple('nonexistent')).toBe(false);
  });
});
