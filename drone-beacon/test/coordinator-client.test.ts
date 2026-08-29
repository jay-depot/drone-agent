import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { PeerCertificate } from 'node:tls';
import {
  initCoordinatorTrust,
  setPendingCoordinatorFingerprint,
  confirmCoordinatorFingerprint,
  setBeaconApproved,
  getBeaconVerificationCode,
  resetCoordinatorTrust,
} from '../src/coordinator-trust.js';

const TEST_FP =
  'aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899';

// The mocked HTTP response is a Readable augmented with the response fields
// http.request callbacks observe.
type MockResponse = Readable & {
  statusCode: number;
  statusMessage: string;
  headers: Record<string, string>;
};

// The mocked ClientRequest returned by the http.request mock.
type MockClientRequest = EventEmitter & {
  write: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  destroy?: ReturnType<typeof vi.fn>;
  __socket?: MockSocket;
  __callback?: (res: MockResponse) => void;
};

type MockSocket = EventEmitter & {
  getPeerCertificate: () => { fingerprint256?: string };
};

describe('Coordinator Client', () => {
  let configDir: string;
  let mockRequest: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    resetCoordinatorTrust();
    configDir = await mkdtemp(
      path.join(os.tmpdir(), 'drone-beacon-coordinator-client-')
    );
    initCoordinatorTrust(configDir);
    setPendingCoordinatorFingerprint(TEST_FP);
    confirmCoordinatorFingerprint(TEST_FP);
    setBeaconApproved(true);
    // Mock http.request
    mockRequest = vi.fn();
    vi.spyOn(http, 'request').mockImplementation(
      mockRequest as unknown as typeof http.request
    );
  });

  describe('fetchCoordinatorFragments', () => {
    it('should fetch fragments and mark them as coordinator scope', async () => {
      const { createCoordinatorClient } =
        await import('../src/coordinator-client.js');
      const { loadOrCreateIdentity } = await import('../src/identity.js');
      const { loadOrCreateTlsIdentity } =
        await import('../../drone-swarm-common/src/tls.js');

      const identity = await loadOrCreateIdentity('test-beacon', configDir);
      const tlsIdentity = await loadOrCreateTlsIdentity(configDir);

      setupMockHttpResponse(200, {
        fragments: [
          {
            id: 'f1',
            target: 'broadcast',
            content: 'c',
            phase: 'header',
            scope: 'coordinator',
            createdAt: 1,
            updatedAt: 1,
            expiresAt: null,
          },
        ],
      });

      const client = createCoordinatorClient(
        {
          host: 'localhost',
          port: 3456,
          beaconId: 'test-beacon',
          beaconName: 'Test Beacon',
        },
        { identity, tlsIdentity, useHttps: false }
      );

      const fragments = await client.fetchCoordinatorFragments();
      expect(fragments).toHaveLength(1);
      expect(fragments[0].scope).toBe('coordinator');
      expect(fragments[0].target).toBe('broadcast');
    });

    it('should accept a raw array response shape', async () => {
      const { createCoordinatorClient } =
        await import('../src/coordinator-client.js');
      const { loadOrCreateIdentity } = await import('../src/identity.js');
      const { loadOrCreateTlsIdentity } =
        await import('../../drone-swarm-common/src/tls.js');

      const identity = await loadOrCreateIdentity('test-beacon', configDir);
      const tlsIdentity = await loadOrCreateTlsIdentity(configDir);

      setupMockHttpResponse(200, [
        {
          id: 'f2',
          target: 'agent-1',
          content: 'c',
          phase: 'footer',
          scope: 'coordinator',
          createdAt: 1,
          updatedAt: 1,
          expiresAt: null,
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

      const fragments = await client.fetchCoordinatorFragments();
      expect(fragments).toHaveLength(1);
      expect(fragments[0].id).toBe('f2');
    });

    it('should return empty array when coordinator is not trusted', async () => {
      const { createCoordinatorClient } =
        await import('../src/coordinator-client.js');
      const { loadOrCreateIdentity } = await import('../src/identity.js');
      const { loadOrCreateTlsIdentity } =
        await import('../../drone-swarm-common/src/tls.js');

      setBeaconApproved(false);

      const identity = await loadOrCreateIdentity('test-beacon', configDir);
      const tlsIdentity = await loadOrCreateTlsIdentity(configDir);

      setupMockHttpResponse(200, { fragments: [] });

      const client = createCoordinatorClient(
        {
          host: 'localhost',
          port: 3456,
          beaconId: 'test-beacon',
          beaconName: 'Test Beacon',
        },
        { identity, tlsIdentity, useHttps: false }
      );

      const fragments = await client.fetchCoordinatorFragments();
      expect(fragments).toEqual([]);
      expect(mockRequest).not.toHaveBeenCalled();
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    resetCoordinatorTrust();
    await rm(configDir, { recursive: true, force: true });
  });

  function makeMockResponse(statusCode: number, body: unknown) {
    const response = new Readable({
      read() {
        this.push(Buffer.from(JSON.stringify(body)));
        this.push(null);
      },
    });
    const mock = response as unknown as MockResponse;
    mock.statusCode = statusCode;
    mock.statusMessage = 'OK';
    mock.headers = { 'content-type': 'application/json' };
    return mock;
  }

  function setupMockHttpResponse(statusCode: number, body: unknown) {
    const response = makeMockResponse(statusCode, body);
    mockRequest.mockImplementation(
      (_opts: unknown, callback: (res: MockResponse) => void) => {
        callback(response);
        const req = new EventEmitter() as unknown as MockClientRequest;
        req.write = vi.fn();
        req.end = vi.fn();
        return req;
      }
    );
  }

  // Build a fake socket that can emit `secureConnect` with a fake peer cert,
  // used to exercise the TOFU fingerprint observation in createCoordinatorFetch.
  function makeHttpsRequestMock(cert: { fingerprint256?: string }) {
    const httpsRequest = vi.fn();
    httpsRequest.mockImplementation(
      (_opts: unknown, callback: (res: MockResponse) => void) => {
        const req = new EventEmitter() as unknown as MockClientRequest;
        const socket = new EventEmitter() as unknown as MockSocket;
        socket.getPeerCertificate = () => cert;
        req.on = (
          event: string,
          listener: (...args: unknown[]) => void
        ): MockClientRequest => {
          if (event === 'socket') {
            listener(socket);
            return req;
          }
          return EventEmitter.prototype.on.call(req, event, listener);
        };
        req.write = vi.fn();
        req.end = vi.fn();
        req.destroy = vi.fn((err?: Error) => {
          req.emit('error', err ?? new Error('destroyed'));
        });
        // Expose the socket so tests can emit `secureConnect` on it.
        req.__socket = socket;
        // Expose the response callback so tests can deliver the HTTP response
        // after exercising the TOFU/pinning path deterministically.
        req.__callback = callback;
        return req;
      }
    );
    vi.spyOn(https, 'request').mockImplementation(
      httpsRequest as unknown as typeof https.request
    );
    return {
      httpsRequest,
      getSocket: () =>
        (httpsRequest.mock.results[0]?.value as unknown as MockClientRequest)
          ?.__socket,
      getCallback: () =>
        (httpsRequest.mock.results[0]?.value as unknown as MockClientRequest)
          ?.__callback,
    };
  }

  describe('createCoordinatorFetch', () => {
    it('should create a fetch wrapper', async () => {
      const { createCoordinatorFetch } =
        await import('../src/coordinator-client.js');
      const cfetch = createCoordinatorFetch('http://localhost:3456');
      expect(cfetch).toBeInstanceOf(Function);
    });

    it('observes the coordinator fingerprint via the socket secureConnect (TOFU)', async () => {
      const { createCoordinatorFetch } =
        await import('../src/coordinator-client.js');
      const observed: string[] = [];
      const { getSocket, getCallback } = makeHttpsRequestMock({
        fingerprint256:
          'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99',
      });

      const cfetch = createCoordinatorFetch(
        'https://localhost:3456',
        undefined,
        fp => observed.push(fp)
      );
      const promise = cfetch('https://localhost:3456/health');

      const socket = getSocket();
      socket.emit('secureConnect');
      getCallback()(makeMockResponse(200, { ok: true }));

      expect(observed).toEqual([TEST_FP]);
      await expect(promise).resolves.toBeInstanceOf(Response);
    });

    it('destroys the request when the observed fingerprint mismatches the pinned value', async () => {
      const { createCoordinatorFetch } =
        await import('../src/coordinator-client.js');
      const pinned =
        'aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899';
      const { getSocket } = makeHttpsRequestMock({
        fingerprint256:
          'FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE',
      });

      const cfetch = createCoordinatorFetch('https://localhost:3456', pinned);
      const promise = cfetch('https://localhost:3456/health');

      const socket = getSocket();
      socket.emit('secureConnect');

      await expect(promise).rejects.toThrow(/fingerprint mismatch/);
    });
  });

  describe('buildCheckServerIdentity', () => {
    it('accepts any cert and calls onFirstFingerprint when no expected fingerprint', async () => {
      const { buildCheckServerIdentity } =
        await import('../src/coordinator-client.js');
      const seen: string[] = [];
      const check = buildCheckServerIdentity(undefined, fp => seen.push(fp));
      const fakeCert = {
        fingerprint256:
          'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99',
      } as PeerCertificate;
      const result = check('localhost', fakeCert);
      expect(result).toBeUndefined();
      expect(seen).toEqual([
        'aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899',
      ]);
    });

    it('accepts cert matching expected fingerprint', async () => {
      const { buildCheckServerIdentity } =
        await import('../src/coordinator-client.js');
      const expected =
        'aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899';
      const check = buildCheckServerIdentity(expected);
      const fakeCert = {
        fingerprint256:
          'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99',
      } as PeerCertificate;
      expect(check('localhost', fakeCert)).toBeUndefined();
    });

    it('rejects cert not matching expected fingerprint', async () => {
      const { buildCheckServerIdentity } =
        await import('../src/coordinator-client.js');
      const expected =
        'aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899';
      const check = buildCheckServerIdentity(expected);
      const fakeCert = {
        fingerprint256:
          'FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE',
      } as PeerCertificate;
      const err = check('localhost', fakeCert);
      expect(err).toBeInstanceOf(Error);
      expect(err?.message).toMatch(/fingerprint mismatch/);
    });

    it('returns error when cert has no fingerprint256', async () => {
      const { buildCheckServerIdentity } =
        await import('../src/coordinator-client.js');
      const check = buildCheckServerIdentity(undefined);
      const err = check('localhost', {} as PeerCertificate);
      expect(err).toBeInstanceOf(Error);
      expect(err?.message).toMatch(/no fingerprint/);
    });
  });
  describe('createCoordinatorClient', () => {
    it('should return a client with all required methods', async () => {
      const { createCoordinatorClient } =
        await import('../src/coordinator-client.js');
      const { loadOrCreateIdentity } = await import('../src/identity.js');
      const { loadOrCreateTlsIdentity } =
        await import('../../drone-swarm-common/src/tls.js');

      const identity = await loadOrCreateIdentity('test-beacon', configDir);
      const tlsIdentity = await loadOrCreateTlsIdentity(configDir);

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
      const { loadOrCreateTlsIdentity } =
        await import('../../drone-swarm-common/src/tls.js');

      const identity = await loadOrCreateIdentity('test-beacon', configDir);
      const tlsIdentity = await loadOrCreateTlsIdentity(configDir);

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

    it('computes the verification code with the observed coordinator fingerprint', async () => {
      const { createCoordinatorClient } =
        await import('../src/coordinator-client.js');
      const { loadOrCreateIdentity } = await import('../src/identity.js');
      const { loadOrCreateTlsIdentity } =
        await import('../../drone-swarm-common/src/tls.js');
      const { generateVerificationCode } = await import('drone-swarm-common');

      const identity = await loadOrCreateIdentity('test-beacon', configDir);
      const tlsIdentity = await loadOrCreateTlsIdentity(configDir);

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
      const expected = generateVerificationCode(
        identity.publicKey,
        tlsIdentity.fingerprint,
        TEST_FP
      );
      expect(result.verificationCode).toBe(expected);
      // The code is stored in memory for the compare-only trust endpoint.
      expect(getBeaconVerificationCode()).toBe(expected);
    });

    it('should throw on non-ok response', async () => {
      const { createCoordinatorClient } =
        await import('../src/coordinator-client.js');
      const { loadOrCreateIdentity } = await import('../src/identity.js');
      const { loadOrCreateTlsIdentity } =
        await import('../../drone-swarm-common/src/tls.js');

      const identity = await loadOrCreateIdentity('test-beacon', configDir);
      const tlsIdentity = await loadOrCreateTlsIdentity(configDir);

      const response = makeMockResponse(403, { error: 'Forbidden' });
      mockRequest.mockImplementation(
        (_opts: unknown, callback: (res: MockResponse) => void) => {
          callback(response);
          const req = new EventEmitter() as unknown as MockClientRequest;
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
      const { loadOrCreateTlsIdentity } =
        await import('../../drone-swarm-common/src/tls.js');

      const identity = await loadOrCreateIdentity('test-beacon', configDir);
      const tlsIdentity = await loadOrCreateTlsIdentity(configDir);

      const response = makeMockResponse(404, { error: 'Not found' });
      mockRequest.mockImplementation(
        (_opts: unknown, callback: (res: MockResponse) => void) => {
          callback(response);
          const req = new EventEmitter() as unknown as MockClientRequest;
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
      const { loadOrCreateTlsIdentity } =
        await import('../../drone-swarm-common/src/tls.js');

      const identity = await loadOrCreateIdentity('test-beacon', configDir);
      const tlsIdentity = await loadOrCreateTlsIdentity(configDir);

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
      const { loadOrCreateTlsIdentity } =
        await import('../../drone-swarm-common/src/tls.js');

      const identity = await loadOrCreateIdentity('test-beacon', configDir);
      const tlsIdentity = await loadOrCreateTlsIdentity(configDir);

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
      const { loadOrCreateTlsIdentity } =
        await import('../../drone-swarm-common/src/tls.js');

      const identity = await loadOrCreateIdentity('test-beacon', configDir);
      const tlsIdentity = await loadOrCreateTlsIdentity(configDir);

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
      const { loadOrCreateTlsIdentity } =
        await import('../../drone-swarm-common/src/tls.js');

      const identity = await loadOrCreateIdentity('test-beacon', configDir);
      const tlsIdentity = await loadOrCreateTlsIdentity(configDir);

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
      const { loadOrCreateTlsIdentity } =
        await import('../../drone-swarm-common/src/tls.js');

      const identity = await loadOrCreateIdentity('test-beacon', configDir);
      const tlsIdentity = await loadOrCreateTlsIdentity(configDir);

      const response = makeMockResponse(404, { error: 'Agent not found' });
      mockRequest.mockImplementation(
        (_opts: unknown, callback: (res: MockResponse) => void) => {
          callback(response);
          const req = new EventEmitter() as unknown as MockClientRequest;
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
      const { loadOrCreateTlsIdentity } =
        await import('../../drone-swarm-common/src/tls.js');

      const identity = await loadOrCreateIdentity('test-beacon', configDir);
      const tlsIdentity = await loadOrCreateTlsIdentity(configDir);

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
      const { loadOrCreateTlsIdentity } =
        await import('../../drone-swarm-common/src/tls.js');

      const identity = await loadOrCreateIdentity('test-beacon', configDir);
      const tlsIdentity = await loadOrCreateTlsIdentity(configDir);

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
      const { loadOrCreateTlsIdentity } =
        await import('../../drone-swarm-common/src/tls.js');

      const identity = await loadOrCreateIdentity('test-beacon', configDir);
      const tlsIdentity = await loadOrCreateTlsIdentity(configDir);

      // Simulate a request error by emitting 'error' on the req
      mockRequest.mockImplementation(
        (_opts: unknown, _callback: (res: MockResponse) => void) => {
          const req = new EventEmitter() as unknown as MockClientRequest;
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
      const { loadOrCreateTlsIdentity } =
        await import('../../drone-swarm-common/src/tls.js');

      const identity = await loadOrCreateIdentity('test-beacon', configDir);
      const tlsIdentity = await loadOrCreateTlsIdentity(configDir);

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
      const { loadOrCreateTlsIdentity } =
        await import('../../drone-swarm-common/src/tls.js');

      const identity = await loadOrCreateIdentity('test-beacon', configDir);
      const tlsIdentity = await loadOrCreateTlsIdentity(configDir);

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
      const { loadOrCreateTlsIdentity } =
        await import('../../drone-swarm-common/src/tls.js');

      const identity = await loadOrCreateIdentity('test-beacon', configDir);
      const tlsIdentity = await loadOrCreateTlsIdentity(configDir);

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

  describe('getSessionTranscript', () => {
    it('should fetch a session transcript from the coordinator', async () => {
      const { createCoordinatorClient } =
        await import('../src/coordinator-client.js');
      const { loadOrCreateIdentity } = await import('../src/identity.js');
      const { loadOrCreateTlsIdentity } =
        await import('../../drone-swarm-common/src/tls.js');

      const identity = await loadOrCreateIdentity('test-beacon', configDir);
      const tlsIdentity = await loadOrCreateTlsIdentity(configDir);

      setupMockHttpResponse(200, {
        session: { id: 'ss1', personaId: 'coder', status: 'ended' },
        transcript: '# Session ss1\n\n--- Turn 1 ---\n[user] hello',
      });

      const client = createCoordinatorClient(
        {
          host: 'localhost',
          port: 3456,
          beaconId: 'test-beacon',
          beaconName: 'Test Beacon',
        },
        { identity, tlsIdentity, useHttps: false }
      );

      const result = await client.getSessionTranscript('ss1');
      expect(result?.session.id).toBe('ss1');
      expect(result?.transcript).toContain('[user] hello');
      expect(mockRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          path: '/api/sessions/ss1/transcript',
        }),
        expect.any(Function)
      );
    });

    it('should return null when the transcript endpoint errors', async () => {
      const { createCoordinatorClient } =
        await import('../src/coordinator-client.js');
      const { loadOrCreateIdentity } = await import('../src/identity.js');
      const { loadOrCreateTlsIdentity } =
        await import('../../drone-swarm-common/src/tls.js');

      const identity = await loadOrCreateIdentity('test-beacon', configDir);
      const tlsIdentity = await loadOrCreateTlsIdentity(configDir);

      setupMockHttpResponse(404, {});

      const client = createCoordinatorClient(
        {
          host: 'localhost',
          port: 3456,
          beaconId: 'test-beacon',
          beaconName: 'Test Beacon',
        },
        { identity, tlsIdentity, useHttps: false }
      );

      const result = await client.getSessionTranscript('missing');
      expect(result).toBeNull();
    });
  });

  describe('coordinator proxy methods', () => {
    async function makeClient() {
      const { createCoordinatorClient } =
        await import('../src/coordinator-client.js');
      const { loadOrCreateIdentity } = await import('../src/identity.js');
      const { loadOrCreateTlsIdentity } =
        await import('../../drone-swarm-common/src/tls.js');

      const identity = await loadOrCreateIdentity('test-beacon', configDir);
      const tlsIdentity = await loadOrCreateTlsIdentity(configDir);

      return createCoordinatorClient(
        {
          host: 'localhost',
          port: 3456,
          beaconId: 'test-beacon',
          beaconName: 'Test Beacon',
        },
        { identity, tlsIdentity, useHttps: false }
      );
    }

    it('listBeacons fetches /api/beacons', async () => {
      setupMockHttpResponse(200, [{ id: 'b1', name: 'Beacon 1' }]);
      const client = await makeClient();
      const result = await client.listBeacons();
      expect(result).toHaveLength(1);
      expect(mockRequest).toHaveBeenCalledWith(
        expect.objectContaining({ path: '/api/beacons' }),
        expect.any(Function)
      );
    });

    it('listAgentLocations passes beaconId query', async () => {
      setupMockHttpResponse(200, []);
      const client = await makeClient();
      await client.listAgentLocations('b1');
      expect(mockRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          path: '/api/agents/location?beaconId=b1',
        }),
        expect.any(Function)
      );
    });

    it('spawnSpawn posts to /api/spawn', async () => {
      setupMockHttpResponse(200, { spawnId: 's1', status: 'spawning' });
      const client = await makeClient();
      const result = await client.spawnSpawn({ targetBeaconId: 'b1' });
      expect(result.spawnId).toBe('s1');
      expect(mockRequest).toHaveBeenCalledWith(
        expect.objectContaining({ path: '/api/spawn', method: 'POST' }),
        expect.any(Function)
      );
    });

    it('getSpawn fetches /api/spawn/:beaconId/:spawnId', async () => {
      setupMockHttpResponse(200, { spawnId: 's1', status: 'running' });
      const client = await makeClient();
      const result = await client.getSpawn('b1', 's1');
      expect(result.status).toBe('running');
      expect(mockRequest).toHaveBeenCalledWith(
        expect.objectContaining({ path: '/api/spawn/b1/s1' }),
        expect.any(Function)
      );
    });

    it('listSpawns passes status query', async () => {
      setupMockHttpResponse(200, []);
      const client = await makeClient();
      await client.listSpawns('b1', 'running');
      expect(mockRequest).toHaveBeenCalledWith(
        expect.objectContaining({ path: '/api/spawn/b1?status=running' }),
        expect.any(Function)
      );
    });

    it('terminateSpawn sends DELETE to /api/spawn/:beaconId/:spawnId', async () => {
      setupMockHttpResponse(200, { success: true });
      const client = await makeClient();
      await client.terminateSpawn('b1', 's1');
      expect(mockRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          path: '/api/spawn/b1/s1',
          method: 'DELETE',
        }),
        expect.any(Function)
      );
    });

    it('returns empty/null when coordinator is not trusted', async () => {
      resetCoordinatorTrust();
      const client = await makeClient();
      expect(await client.listBeacons()).toEqual([]);
      expect(await client.listAgentLocations('b1')).toEqual([]);
      expect(await client.spawnSpawn({ targetBeaconId: 'b1' })).toBeNull();
      expect(await client.getSpawn('b1', 's1')).toBeNull();
      expect(await client.listSpawns('b1')).toEqual([]);
      expect(await client.terminateSpawn('b1', 's1')).toBeNull();
    });
  });
});
