import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

describe('Swarm node Identity', () => {
  let configDir: string;

  beforeEach(async () => {
    configDir = await mkdtemp(path.join(os.tmpdir(), 'drone-node-identity-'));
  });

  afterEach(async () => {
    await rm(configDir, { recursive: true, force: true });
  });

  it('should generate an Ed25519 keypair with correct structure', async () => {
    const { generateIdentity } = await import('../src/identity.js');
    const identity = generateIdentity('test-node');
    expect(identity.id).toBe('test-node');
    expect(identity.publicKey).toBeTruthy();
    expect(identity.publicKeyHex).toMatch(/^[a-f0-9]{64}$/);
    expect(identity.privateKeyPem).toContain('BEGIN PRIVATE KEY');
  });

  it('should generate unique identities for different calls', async () => {
    const { generateIdentity } = await import('../src/identity.js');
    const id1 = generateIdentity('node-1');
    const id2 = generateIdentity('node-2');
    expect(id1.publicKey).not.toBe(id2.publicKey);
    expect(id1.privateKeyPem).not.toBe(id2.privateKeyPem);
  });

  it('should load existing identity from disk', async () => {
    const { loadOrCreateIdentity } = await import('../src/identity.js');
    const first = await loadOrCreateIdentity('test-node', configDir);
    const second = await loadOrCreateIdentity('test-node', configDir);
    expect(second.publicKey).toBe(first.publicKey);
    expect(second.privateKeyPem).toBe(first.privateKeyPem);
    expect(second.publicKeyHex).toBe(first.publicKeyHex);
  });

  it('should generate new identity when file is missing', async () => {
    const { loadOrCreateIdentity } = await import('../src/identity.js');
    const identity = await loadOrCreateIdentity('new-node', configDir);
    expect(identity.id).toBe('new-node');
    expect(identity.publicKey).toBeTruthy();
  });

  it('should generate new identity when id changes', async () => {
    const { loadOrCreateIdentity } = await import('../src/identity.js');
    const first = await loadOrCreateIdentity('node-a', configDir);
    const second = await loadOrCreateIdentity('node-b', configDir);
    expect(second.publicKey).not.toBe(first.publicKey);
  });

  it('should return a valid signing key', async () => {
    const { generateIdentity, getSigningKey } =
      await import('../src/identity.js');
    const identity = generateIdentity('test-node');
    const key = getSigningKey(identity);
    expect(key.type).toBe('public');
    expect(key.asymmetricKeyType).toBe('ed25519');
  });

  it('should persist identity to disk as JSON (default filename)', async () => {
    const { loadOrCreateIdentity } = await import('../src/identity.js');
    const identity = await loadOrCreateIdentity('persist-test', configDir);
    const filePath = path.join(configDir, 'beacon-identity.json');
    const content = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(content);
    expect(parsed.id).toBe('persist-test');
    expect(parsed.publicKey).toBe(identity.publicKey);
    expect(parsed.privateKeyPem).toBe(identity.privateKeyPem);
  });

  it('should honour a custom identity filename', async () => {
    const { loadOrCreateIdentity } = await import('../src/identity.js');
    const identity = await loadOrCreateIdentity(
      'ext-test',
      configDir,
      'node-identity.json'
    );
    const filePath = path.join(configDir, 'node-identity.json');
    const content = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(content);
    expect(parsed.id).toBe('ext-test');
    expect(parsed.publicKey).toBe(identity.publicKey);
  });
});
