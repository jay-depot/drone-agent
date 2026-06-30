import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

describe('Coordinator Client', () => {
  let configDir: string;
  let mockRequest: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    configDir = await mkdtemp(
      path.join(os.tmpdir(), 'drone-beacon-coordinator-client-')
    );
    // Mock http.request
    mockRequest = vi.fn();
    vi.spyOn(http, 'request').mockImplementation(mockRequest as any);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(configDir, { recursive: true, force: true });
  });

  function makeMockResponse(statusCode: number, body: unknown) {
    const response = new Readable({
      read() {
        this.push(Buffer.from(JSON.stringify(body)));
        this.push(null);
      },
    });
    (response as any).statusCode = statusCode;
    (response as any).statusMessage = 'OK';
    (response as any).headers = { 'content-type': 'application/json' };
    return response;
  }

  function setupMockHttpResponse(statusCode: number, body: unknown) {
    const response = makeMockResponse(statusCode, body);
    mockRequest.mockImplementation(
      (_opts: any, callback: (res: any) => void) => {
        callback(response);
        const req = new EventEmitter() as any;
        req.write = vi.fn();
        req.end = vi.fn();
        return req;
      }
    );
  }

  describe('createCoordinatorFetch', () => {
    it('should create a fetch wrapper', async () => {
      const { createCoordinatorFetch } =
        await import('../src/coordinator-client.js');
      const cfetch = createCoordinatorFetch('http://localhost:3456');
      expect(cfetch).toBeInstanceOf(Function);
    });
  });

  describe('createCoordinatorClient', () => {
    it('should return a client with all required methods', async () => {
      const { createCoordinatorClient } =
        await import('../src/coordinator-client.js');
      const { loadOrCreateIdentity } = await import('../src/identity.js');
      const { loadOrCreateTlsIdentity } = await import('../src/tls.js');

      const identity = loadOrCreateIdentity('test-beacon', configDir);
      const tlsIdentity = loadOrCreateTlsIdentity(configDir);

      const client = createCoordinatorClient(
        {
          host: 'localhost',
          port: 3456,
          beaconId: 'test-beacon',
          beaconName: 'Test Beacon',
        },
        { identity, tlsIdentity, useHttps: false }
      );

      expect(client.getBaseUrl()).toBe('http://localhost:3456');
      expect(client.registerBeacon).toBeInstanceOf(Function);
      expect(client.pollForApproval).toBeInstanceOf(Function);
      expect(client.heartbeat).toBeInstanceOf(Function);
      expect(client.fetchPersonas).toBeInstanceOf(Function);
      expect(client.fetchSkills).toBeInstanceOf(Function);
      expect(client.registerSession).toBeInstanceOf(Function);
      expect(client.endSession).toBeInstanceOf(Function);
      expect(client.registerAgentLocation).toBeInstanceOf(Function);
      expect(client.updateAgentLocationHeartbeat).toBeInstanceOf(Function);
      expect(client.unregisterAgentLocation).toBeInstanceOf(Function);
      expect(client.relayMessage).toBeInstanceOf(Function);
      expect(client.pushPersona).toBeInstanceOf(Function);
      expect(client.pushSkill).toBeInstanceOf(Function);
      expect(client.deletePersona).toBeInstanceOf(Function);
      expect(client.deleteSkill).toBeInstanceOf(Function);
      expect(client.pushKnowledge).toBeInstanceOf(Function);
      expect(client.pullKnowledge).toBeInstanceOf(Function);
      expect(client.searchKnowledge).toBeInstanceOf(Function);
      expect(client.registerSwarmSession).toBeInstanceOf(Function);
      expect(client.pushEvents).toBeInstanceOf(Function);
    });
  });

  describe('registerBeacon', () => {
    it('should register beacon and return status', async () => {
      const { createCoordinatorClient } =
        await import('../src/coordinator-client.js');
      const { loadOrCreateIdentity } = await import('../src/identity.js');
      const { loadOrCreateTlsIdentity } = await import('../src/tls.js');

      const identity = loadOrCreateIdentity('test-beacon', configDir);
      const tlsIdentity = loadOrCreateTlsIdentity(configDir);

      setupMockHttpResponse(201, { status: 'approved' });

      const client = createCoordinatorClient(
        {
          host: 'localhost',
          port: 3456,
          beaconId: 'test-beacon',
          beaconName: 'Test Beacon',
        },
        { identity, tlsIdentity, useHttps: false }
      );

      const result = await client.registerBeacon(
        identity,
        tlsIdentity.fingerprint
      );
      expect(result.status).toBe('approved');
    });

    it('should throw on non-ok response', async () => {
      const { createCoordinatorClient } =
        await import('../src/coordinator-client.js');
      const { loadOrCreateIdentity } = await import('../src/identity.js');
      const { loadOrCreateTlsIdentity } = await import('../src/tls.js');

      const identity = loadOrCreateIdentity('test-beacon', configDir);
      const tlsIdentity = loadOrCreateTlsIdentity(configDir);

      const response = makeMockResponse(403, { error: 'Forbidden' });
      mockRequest.mockImplementation(
        (_opts: any, callback: (res: any) => void) => {
          callback(response);
          const req = new EventEmitter() as any;
          req.write = vi.fn();
          req.end = vi.fn();
          return req;
        }
      );

      const client = createCoordinatorClient(
        {
          host: 'localhost',
          port: 3456,
          beaconId: 'test-beacon',
          beaconName: 'Test Beacon',
        },
        { identity, tlsIdentity, useHttps: false }
      );

      await expect(
        client.registerBeacon(identity, tlsIdentity.fingerprint)
      ).rejects.toThrow();
    });
  });

  describe('pollForApproval', () => {
    it('should return pending status on 404', async () => {
      const { createCoordinatorClient } =
        await import('../src/coordinator-client.js');
      const { loadOrCreateIdentity } = await import('../src/identity.js');
      const { loadOrCreateTlsIdentity } = await import('../src/tls.js');

      const identity = loadOrCreateIdentity('test-beacon', configDir);
      const tlsIdentity = loadOrCreateTlsIdentity(configDir);

      const response = makeMockResponse(404, { error: 'Not found' });
      mockRequest.mockImplementation(
        (_opts: any, callback: (res: any) => void) => {
          callback(response);
          const req = new EventEmitter() as any;
          req.write = vi.fn();
          req.end = vi.fn();
          return req;
        }
      );

      const client = createCoordinatorClient(
        {
          host: 'localhost',
          port: 3456,
          beaconId: 'test-beacon',
          beaconName: 'Test Beacon',
        },
        { identity, tlsIdentity, useHttps: false }
      );

      const result = await client.pollForApproval();
      expect(result.status).toBe('pending');
    });

    it('should return approved status', async () => {
      const { createCoordinatorClient } =
        await import('../src/coordinator-client.js');
      const { loadOrCreateIdentity } = await import('../src/identity.js');
      const { loadOrCreateTlsIdentity } = await import('../src/tls.js');

      const identity = loadOrCreateIdentity('test-beacon', configDir);
      const tlsIdentity = loadOrCreateTlsIdentity(configDir);

      setupMockHttpResponse(200, { status: 'approved' });

      const client = createCoordinatorClient(
        {
          host: 'localhost',
          port: 3456,
          beaconId: 'test-beacon',
          beaconName: 'Test Beacon',
        },
        { identity, tlsIdentity, useHttps: false }
      );

      const result = await client.pollForApproval();
      expect(result.status).toBe('approved');
    });
  });

  describe('fetchPersonas', () => {
    it('should fetch personas and mark them as coordinator scope', async () => {
      const { createCoordinatorClient } =
        await import('../src/coordinator-client.js');
      const { loadOrCreateIdentity } = await import('../src/identity.js');
      const { loadOrCreateTlsIdentity } = await import('../src/tls.js');

      const identity = loadOrCreateIdentity('test-beacon', configDir);
      const tlsIdentity = loadOrCreateTlsIdentity(configDir);

      setupMockHttpResponse(200, [
        {
          id: 'p1',
          name: 'P1',
          description: 'd1',
          systemPrompt: 'sp1',
          scope: 'coordinator',
          createdAt: 1,
          updatedAt: 1,
        },
      ]);

      const client = createCoordinatorClient(
        {
          host: 'localhost',
          port: 3456,
          beaconId: 'test-beacon',
          beaconName: 'Test Beacon',
        },
        { identity, tlsIdentity, useHttps: false }
      );

      const personas = await client.fetchPersonas();
      expect(personas).toHaveLength(1);
      expect(personas[0].scope).toBe('coordinator');
    });
  });

  describe('fetchSkills', () => {
    it('should fetch skills and mark them as coordinator scope', async () => {
      const { createCoordinatorClient } =
        await import('../src/coordinator-client.js');
      const { loadOrCreateIdentity } = await import('../src/identity.js');
      const { loadOrCreateTlsIdentity } = await import('../src/tls.js');

      const identity = loadOrCreateIdentity('test-beacon', configDir);
      const tlsIdentity = loadOrCreateTlsIdentity(configDir);

      setupMockHttpResponse(200, [
        {
          id: 's1',
          name: 'S1',
          description: 'd1',
          trigger: 't1',
          body: 'b1',
          scope: 'coordinator',
          createdAt: 1,
          updatedAt: 1,
        },
      ]);

      const client = createCoordinatorClient(
        {
          host: 'localhost',
          port: 3456,
          beaconId: 'test-beacon',
          beaconName: 'Test Beacon',
        },
        { identity, tlsIdentity, useHttps: false }
      );

      const skills = await client.fetchSkills();
      expect(skills).toHaveLength(1);
      expect(skills[0].scope).toBe('coordinator');
    });
  });

  describe('relayMessage', () => {
    it('should relay a message and return success', async () => {
      const { createCoordinatorClient } =
        await import('../src/coordinator-client.js');
      const { loadOrCreateIdentity } = await import('../src/identity.js');
      const { loadOrCreateTlsIdentity } = await import('../src/tls.js');

      const identity = loadOrCreateIdentity('test-beacon', configDir);
      const tlsIdentity = loadOrCreateTlsIdentity(configDir);

      setupMockHttpResponse(200, { messageId: 'msg-1' });

      const client = createCoordinatorClient(
        {
          host: 'localhost',
          port: 3456,
          beaconId: 'test-beacon',
          beaconName: 'Test Beacon',
        },
        { identity, tlsIdentity, useHttps: false }
      );

      const result = await client.relayMessage(
        'target-agent',
        'source-agent',
        '{"text":"hello"}'
      );
      expect(result.success).toBe(true);
      expect(result.messageId).toBe('msg-1');
    });

    it('should return success false on failure', async () => {
      const { createCoordinatorClient } =
        await import('../src/coordinator-client.js');
      const { loadOrCreateIdentity } = await import('../src/identity.js');
      const { loadOrCreateTlsIdentity } = await import('../src/tls.js');

      const identity = loadOrCreateIdentity('test-beacon', configDir);
      const tlsIdentity = loadOrCreateTlsIdentity(configDir);

      const response = makeMockResponse(404, { error: 'Agent not found' });
      mockRequest.mockImplementation(
        (_opts: any, callback: (res: any) => void) => {
          callback(response);
          const req = new EventEmitter() as any;
          req.write = vi.fn();
          req.end = vi.fn();
          return req;
        }
      );

      const client = createCoordinatorClient(
        {
          host: 'localhost',
          port: 3456,
          beaconId: 'test-beacon',
          beaconName: 'Test Beacon',
        },
        { identity, tlsIdentity, useHttps: false }
      );

      const result = await client.relayMessage(
        'target-agent',
        'source-agent',
        'body'
      );
      expect(result.success).toBe(false);
    });
  });

  describe('pushKnowledge', () => {
    it('should push knowledge to coordinator', async () => {
      const { createCoordinatorClient } =
        await import('../src/coordinator-client.js');
      const { loadOrCreateIdentity } = await import('../src/identity.js');
      const { loadOrCreateTlsIdentity } = await import('../src/tls.js');

      const identity = loadOrCreateIdentity('test-beacon', configDir);
      const tlsIdentity = loadOrCreateTlsIdentity(configDir);

      setupMockHttpResponse(200, {});

      const client = createCoordinatorClient(
        {
          host: 'localhost',
          port: 3456,
          beaconId: 'test-beacon',
          beaconName: 'Test Beacon',
        },
        { identity, tlsIdentity, useHttps: false }
      );

      await client.pushKnowledge({
        id: 'k1',
        type: 'fact',
        key: 'test',
        value: '{}',
        sourceBeaconId: null,
        sourceAgentId: null,
        confidence: 1.0,
        createdAt: 1,
        updatedAt: 1,
      });

      expect(mockRequest).toHaveBeenCalled();
    });
  });

  describe('pullKnowledge', () => {
    it('should pull knowledge from coordinator', async () => {
      const { createCoordinatorClient } =
        await import('../src/coordinator-client.js');
      const { loadOrCreateIdentity } = await import('../src/identity.js');
      const { loadOrCreateTlsIdentity } = await import('../src/tls.js');

      const identity = loadOrCreateIdentity('test-beacon', configDir);
      const tlsIdentity = loadOrCreateTlsIdentity(configDir);

      setupMockHttpResponse(200, [
        {
          id: 'k1',
          type: 'fact',
          key: 'test',
          value: '{}',
          sourceBeaconId: null,
          sourceAgentId: null,
          confidence: 1.0,
          createdAt: 1,
          updatedAt: 1,
        },
      ]);

      const client = createCoordinatorClient(
        {
          host: 'localhost',
          port: 3456,
          beaconId: 'test-beacon',
          beaconName: 'Test Beacon',
        },
        { identity, tlsIdentity, useHttps: false }
      );

      const knowledge = await client.pullKnowledge();
      expect(knowledge).toHaveLength(1);
    });

    it('should return empty array on failure', async () => {
      const { createCoordinatorClient } =
        await import('../src/coordinator-client.js');
      const { loadOrCreateIdentity } = await import('../src/identity.js');
      const { loadOrCreateTlsIdentity } = await import('../src/tls.js');

      const identity = loadOrCreateIdentity('test-beacon', configDir);
      const tlsIdentity = loadOrCreateTlsIdentity(configDir);

      // Simulate a request error by emitting 'error' on the req
      mockRequest.mockImplementation(
        (_opts: any, _callback: (res: any) => void) => {
          const req = new EventEmitter() as any;
          req.write = vi.fn();
          req.end = vi.fn();
          process.nextTick(() => req.emit('error', new Error('Network error')));
          return req;
        }
      );

      const client = createCoordinatorClient(
        {
          host: 'localhost',
          port: 3456,
          beaconId: 'test-beacon',
          beaconName: 'Test Beacon',
        },
        { identity, tlsIdentity, useHttps: false }
      );

      const knowledge = await client.pullKnowledge();
      expect(knowledge).toHaveLength(0);
    });
  });

  describe('searchKnowledge', () => {
    it('should search knowledge on coordinator', async () => {
      const { createCoordinatorClient } =
        await import('../src/coordinator-client.js');
      const { loadOrCreateIdentity } = await import('../src/identity.js');
      const { loadOrCreateTlsIdentity } = await import('../src/tls.js');

      const identity = loadOrCreateIdentity('test-beacon', configDir);
      const tlsIdentity = loadOrCreateTlsIdentity(configDir);

      setupMockHttpResponse(200, [
        {
          id: 'k1',
          type: 'fact',
          key: 'test',
          value: '{}',
          sourceBeaconId: null,
          sourceAgentId: null,
          confidence: 1.0,
          createdAt: 1,
          updatedAt: 1,
        },
      ]);

      const client = createCoordinatorClient(
        {
          host: 'localhost',
          port: 3456,
          beaconId: 'test-beacon',
          beaconName: 'Test Beacon',
        },
        { identity, tlsIdentity, useHttps: false }
      );

      const results = await client.searchKnowledge('test');
      expect(results).toHaveLength(1);
    });
  });

  describe('registerSwarmSession', () => {
    it('should register a swarm session', async () => {
      const { createCoordinatorClient } =
        await import('../src/coordinator-client.js');
      const { loadOrCreateIdentity } = await import('../src/identity.js');
      const { loadOrCreateTlsIdentity } = await import('../src/tls.js');

      const identity = loadOrCreateIdentity('test-beacon', configDir);
      const tlsIdentity = loadOrCreateTlsIdentity(configDir);

      setupMockHttpResponse(201, {});

      const client = createCoordinatorClient(
        {
          host: 'localhost',
          port: 3456,
          beaconId: 'test-beacon',
          beaconName: 'Test Beacon',
        },
        { identity, tlsIdentity, useHttps: false }
      );

      await client.registerSwarmSession('session-1', null);
      expect(mockRequest).toHaveBeenCalled();
    });
  });

  describe('pushEvents', () => {
    it('should push events to coordinator', async () => {
      const { createCoordinatorClient } =
        await import('../src/coordinator-client.js');
      const { loadOrCreateIdentity } = await import('../src/identity.js');
      const { loadOrCreateTlsIdentity } = await import('../src/tls.js');

      const identity = loadOrCreateIdentity('test-beacon', configDir);
      const tlsIdentity = loadOrCreateTlsIdentity(configDir);

      setupMockHttpResponse(201, {});

      const client = createCoordinatorClient(
        {
          host: 'localhost',
          port: 3456,
          beaconId: 'test-beacon',
          beaconName: 'Test Beacon',
        },
        { identity, tlsIdentity, useHttps: false }
      );

      await client.pushEvents([
        {
          id: 'e1',
          sessionId: 's1',
          type: 'msg',
          createdAt: Date.now(),
        },
      ]);
      expect(mockRequest).toHaveBeenCalled();
    });
  });
});
