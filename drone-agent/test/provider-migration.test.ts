import { describe, expect, it } from 'vitest';
import { createDefaultAgentConfig } from 'drone-core';
import {
  formatMigrationNotice,
  listLegacySections,
  migrateLegacyProviderConfig,
} from '../src/runtime/provider-migration.js';

function legacyConfig() {
  const config = createDefaultAgentConfig();
  config.llm = { provider: 'ollama' };
  config.ollama = {
    host: 'http://127.0.0.1:11434',
    model: 'llama3.1',
  };
  return config;
}

describe('migrateLegacyProviderConfig', () => {
  it('synthesizes an ollama provider from the legacy section', () => {
    const result = migrateLegacyProviderConfig(legacyConfig());
    expect(result.changed).toBe(true);
    expect(result.migratedSections).toEqual(['ollama']);
    const provider = result.config.providers['ollama'];
    expect(provider?.protocol).toBe('ollama');
    expect(provider?.baseUrl).toBe('http://127.0.0.1:11434');
    expect(provider?.models?.['llama3.1']).toBeDefined();
  });

  it('seeds llm.active from llm.provider + default model', () => {
    const result = migrateLegacyProviderConfig(legacyConfig());
    expect(result.config.llm.active).toBe('ollama/llama3.1');
  });

  it('seeds llm.active for cloud providers with declared model lists', () => {
    const config = legacyConfig();
    config.llm = { provider: 'openrouter' };
    config.openrouter.apiKey = 'sk-or';
    config.openrouter.defaultModel = 'openai/gpt-4o';
    config.openrouter.models = [
      { id: 'openai/gpt-4o', contextWindow: 128000 },
      { id: 'anthropic/claude-3.5-sonnet', contextWindow: 200000 },
    ];
    const result = migrateLegacyProviderConfig(config);
    expect(result.config.llm.active).toBe('openrouter/openai/gpt-4o');
    // Multi-slash upstream id preserved after the first slash.
    expect(
      result.config.providers['openrouter']?.models?.['openai/gpt-4o']
        ?.contextWindow
    ).toBe(128000);
  });

  it('migrates openai/anthropic sections only when an apiKey is present', () => {
    const config = legacyConfig();
    config.openai.apiKey = 'sk-test';
    config.openai.defaultModel = 'gpt-4o';
    config.anthropic.apiKey = '';
    const result = migrateLegacyProviderConfig(config);
    expect(result.migratedSections.sort()).toEqual(['ollama', 'openai']);
    expect(result.config.providers['anthropic']).toBeUndefined();
    expect(result.config.providers['openai']?.apiKey).toBe('sk-test');
  });

  it('never overwrites an existing llm.active', () => {
    const config = legacyConfig();
    config.llm = { provider: 'ollama', active: 'other/pick' };
    const result = migrateLegacyProviderConfig(config);
    expect(result.config.llm.active).toBe('other/pick');
  });

  it('is a no-op against already-migrated config', () => {
    const first = migrateLegacyProviderConfig(legacyConfig());
    const second = migrateLegacyProviderConfig(first.config);
    expect(second.changed).toBe(false);
    expect(second.migratedSections).toEqual([]);
    expect(Object.keys(second.config.providers)).toEqual(['ollama']);
  });

  it('ignores legacy sections when providers entries exist', () => {
    const config = legacyConfig();
    config.providers = {
      custom: { protocol: 'ollama', baseUrl: 'http://elsewhere:11434' },
    };
    const result = migrateLegacyProviderConfig(config);
    expect(result.migratedSections).toEqual([]);
    expect(result.changed).toBe(false);
    expect(result.config.providers['ollama']).toBeUndefined();
    expect(result.config.providers['custom']).toBeDefined();
  });

  it('falls back to the first declared model when no default is known', () => {
    const config = legacyConfig();
    config.llm = { provider: 'openai' };
    config.openai.apiKey = 'sk';
    config.openai.defaultModel = '';
    config.openai.models = [{ id: 'gpt-4o', contextWindow: 128000 }];
    const result = migrateLegacyProviderConfig(config);
    expect(result.config.llm.active).toBe('openai/gpt-4o');
  });
});

describe('formatMigrationNotice + listLegacySections', () => {
  it('produces a notice listing migrated sections', () => {
    const result = migrateLegacyProviderConfig(legacyConfig());
    const notice = formatMigrationNotice(result);
    expect(notice).toContain('ollama');
    expect(notice).toContain('deprecated');
  });

  it('returns undefined when nothing migrated', () => {
    const config = legacyConfig();
    config.providers = { x: { protocol: 'ollama' } };
    const result = migrateLegacyProviderConfig(config);
    expect(formatMigrationNotice(result)).toBeUndefined();
  });

  it('lists present legacy sections', () => {
    const config = legacyConfig();
    config.openai.apiKey = 'k';
    expect(listLegacySections(config).sort()).toEqual(['ollama', 'openai']);
  });
});
