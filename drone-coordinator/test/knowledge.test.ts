import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  initDatabase,
  closeDatabase,
  createKnowledge,
  getKnowledge,
  listKnowledge,
  updateKnowledge,
  deleteKnowledge,
  searchKnowledge,
  upsertKnowledge,
} from '../src/db.js';

let dbPath = '';

async function setupDb(): Promise<string> {
  const dir = await mkdtemp(
    path.join(os.tmpdir(), 'drone-coordinator-knowledge-')
  );
  const dbFile = path.join(dir, 'test.db');
  initDatabase(dbFile);
  return dbFile;
}

afterEach(async () => {
  closeDatabase();
  if (dbPath) {
    await rm(path.dirname(dbPath), { recursive: true, force: true });
  }
  dbPath = '';
});

describe('Knowledge CRUD', () => {
  beforeEach(async () => {
    dbPath = await setupDb();
  });

  it('should create and retrieve a knowledge entry', () => {
    const knowledge = createKnowledge({
      id: 'test-1',
      type: 'fact',
      key: 'test-fact',
      value: JSON.stringify({ message: 'hello world' }),
      sourceBeaconId: 'beacon-1',
      sourceAgentId: 'agent-1',
      confidence: 0.9,
    });

    expect(knowledge.id).toBe('test-1');
    expect(knowledge.type).toBe('fact');
    expect(knowledge.key).toBe('test-fact');
    expect(knowledge.value).toBe(JSON.stringify({ message: 'hello world' }));
    expect(knowledge.sourceBeaconId).toBe('beacon-1');
    expect(knowledge.sourceAgentId).toBe('agent-1');
    expect(knowledge.confidence).toBe(0.9);
    expect(knowledge.createdAt).toBeGreaterThan(0);
    expect(knowledge.updatedAt).toBeGreaterThan(0);

    const retrieved = getKnowledge('test-1');
    expect(retrieved).toBeDefined();
    expect(retrieved!.id).toBe('test-1');
    expect(retrieved!.key).toBe('test-fact');
  });

  it('should return undefined for non-existent knowledge', () => {
    const result = getKnowledge('non-existent');
    expect(result).toBeUndefined();
  });

  it('should list all knowledge entries', () => {
    createKnowledge({
      id: 'k1',
      type: 'fact',
      key: 'fact-1',
      value: JSON.stringify({ a: 1 }),
    });
    createKnowledge({
      id: 'k2',
      type: 'preference',
      key: 'pref-1',
      value: JSON.stringify({ theme: 'dark' }),
    });
    createKnowledge({
      id: 'k3',
      type: 'skill_pattern',
      key: 'pattern-1',
      value: JSON.stringify({ pattern: 'test-first' }),
    });

    const all = listKnowledge();
    expect(all).toHaveLength(3);
  });

  it('should list knowledge filtered by type', () => {
    createKnowledge({
      id: 'k1',
      type: 'fact',
      key: 'fact-1',
      value: JSON.stringify({ a: 1 }),
    });
    createKnowledge({
      id: 'k2',
      type: 'preference',
      key: 'pref-1',
      value: JSON.stringify({ theme: 'dark' }),
    });

    const facts = listKnowledge('fact');
    expect(facts).toHaveLength(1);
    expect(facts[0].id).toBe('k1');

    const prefs = listKnowledge('preference');
    expect(prefs).toHaveLength(1);
    expect(prefs[0].id).toBe('k2');
  });

  it('should update a knowledge entry', () => {
    createKnowledge({
      id: 'k1',
      type: 'fact',
      key: 'fact-1',
      value: JSON.stringify({ a: 1 }),
    });

    const updated = updateKnowledge('k1', {
      value: JSON.stringify({ a: 2 }),
      confidence: 0.5,
    });

    expect(updated).toBeDefined();
    expect(updated!.value).toBe(JSON.stringify({ a: 2 }));
    expect(updated!.confidence).toBe(0.5);
    expect(updated!.key).toBe('fact-1'); // unchanged
    expect(updated!.type).toBe('fact'); // unchanged
  });

  it('should return undefined when updating non-existent knowledge', () => {
    const result = updateKnowledge('non-existent', { value: 'test' });
    expect(result).toBeUndefined();
  });

  it('should delete a knowledge entry', () => {
    createKnowledge({
      id: 'k1',
      type: 'fact',
      key: 'fact-1',
      value: JSON.stringify({ a: 1 }),
    });

    const deleted = deleteKnowledge('k1');
    expect(deleted).toBe(true);

    const retrieved = getKnowledge('k1');
    expect(retrieved).toBeUndefined();
  });

  it('should return false when deleting non-existent knowledge', () => {
    const result = deleteKnowledge('non-existent');
    expect(result).toBe(false);
  });

  it('should search knowledge by key and value', () => {
    createKnowledge({
      id: 'k1',
      type: 'fact',
      key: 'vite-preference',
      value: JSON.stringify({ tool: 'Vite' }),
    });
    createKnowledge({
      id: 'k2',
      type: 'fact',
      key: 'webpack-preference',
      value: JSON.stringify({ tool: 'Webpack' }),
    });
    createKnowledge({
      id: 'k3',
      type: 'preference',
      key: 'theme',
      value: JSON.stringify({ theme: 'dark' }),
    });

    const results = searchKnowledge('vite');
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('k1');

    const all = searchKnowledge('tool');
    expect(all).toHaveLength(2);
  });

  it('should search knowledge filtered by type', () => {
    createKnowledge({
      id: 'k1',
      type: 'fact',
      key: 'vite',
      value: JSON.stringify({ tool: 'Vite' }),
    });
    createKnowledge({
      id: 'k2',
      type: 'preference',
      key: 'theme',
      value: JSON.stringify({ theme: 'dark' }),
    });

    const results = searchKnowledge('Vite', 'fact');
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('k1');

    const noResults = searchKnowledge('Vite', 'preference');
    expect(noResults).toHaveLength(0);
  });

  it('should upsert - create new entry', () => {
    const result = upsertKnowledge({
      id: 'k1',
      type: 'fact',
      key: 'test-key',
      value: JSON.stringify({ data: 'original' }),
    });

    expect(result.id).toBe('k1');
    expect(result.value).toBe(JSON.stringify({ data: 'original' }));
  });

  it('should upsert - keep existing when confidence is lower', () => {
    // Create with high confidence
    upsertKnowledge({
      id: 'k1',
      type: 'fact',
      key: 'test-key',
      value: JSON.stringify({ data: 'original' }),
      confidence: 0.9,
    });

    // Try to upsert with lower confidence
    const result = upsertKnowledge({
      id: 'k2',
      type: 'fact',
      key: 'test-key',
      value: JSON.stringify({ data: 'newer-but-worse' }),
      confidence: 0.5,
    });

    // Should keep the original (higher confidence)
    expect(result.value).toBe(JSON.stringify({ data: 'original' }));
    expect(result.id).toBe('k1');
  });

  it('should upsert - replace when confidence is higher', () => {
    // Create with low confidence
    upsertKnowledge({
      id: 'k1',
      type: 'fact',
      key: 'test-key',
      value: JSON.stringify({ data: 'original' }),
      confidence: 0.3,
    });

    // Upsert with higher confidence
    const result = upsertKnowledge({
      id: 'k2',
      type: 'fact',
      key: 'test-key',
      value: JSON.stringify({ data: 'better-data' }),
      confidence: 0.9,
    });

    // Should replace with the higher confidence entry
    expect(result.value).toBe(JSON.stringify({ data: 'better-data' }));
  });
});
