import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Regression test for /model <pick> persistence: `llm.active` was missing
 * from the config plugin's static KNOWN_CONFIG_KEYS allowlist, so the
 * capability's setValue threw "Unknown config key" and persistActiveModel
 * swallowed it into a warning — silently breaking persistence at runtime
 * while mocked-capability tests stayed green. This exercises the REAL write
 * path (capability.setValue → writeConfigValue → disk).
 */
describe('config setValue real write path (llm.active regression)', () => {
  let tmpHome: string;

  beforeEach(async () => {
    vi.resetModules();
    tmpHome = await mkdtemp(path.join(tmpdir(), 'drone-config-test-'));
    // ESM module namespaces are not spyable; vi.doMock below redirects
    // homedir for every module imported after resetModules. The plugin
    // imports the DEFAULT export (`import os from 'node:os'`), so the mock
    // must override `default` as well — spreading `actual` alone leaves
    // the original default object (with the real homedir) intact.
    vi.doMock('node:os', async importOriginal => {
      const actual = await importOriginal<typeof import('node:os')>();
      const mocked = { ...actual, homedir: () => tmpHome };
      return { ...mocked, default: mocked };
    });
  });

  afterEach(async () => {
    vi.doUnmock('node:os');
    await rm(tmpHome, { recursive: true, force: true });
  });

  it('persists llm.active to user-scope config.json and stays idempotent', async () => {
    const { configPlugin } = await import(
      '../src/plugins/config/index.js'
    );

    let capability: unknown;
    const registration = {
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
      },
      getConfig: () => ({
        enabledPlugins: [],
        systemPrompt: '',
        activePersona: null,
        llm: { provider: 'ollama' },
        providers: {},
        session: { contextWindowTokens: 32768 },
      }),
      registerTool: () => {},
      registerPromptFragment: () => {},
      registerHelp: () => {},
      registerWorkflow: () => {},
      registerSlashCommand: () => {},
      unregisterPluginTools: () => {},
      unregisterTool: () => {},
      mountTool: () => undefined,
      unmountTool: () => {},
      listMountedTools: () => [],
      hooks: {
        onPluginsLoaded: () => {},
        onSessionStart: () => {},
        onBeforePrompt: () => {},
        onAfterToolCall: () => {},
        onConversationEvent: () => {},
        onSessionClear: () => {},
        onShutdown: () => {},
        onSessionSafetyTrimWillRun: () => {},
        onSessionSafetyTrimApplied: () => {},
      },
      offer: (cap: unknown) => {
        capability = cap;
      },
      request: <T>() => undefined as T | undefined,
      runWorkflow: async () => ({ toolResult: '{}' }),
      requestElicitation: () => undefined,
    };

    // The config plugin registers its capability during register().
    await (
      configPlugin as { register: (r: never) => Promise<void> }
    ).register(registration as never);

    const setValue = (
      capability as {
        setValue: (
          scope: 'project' | 'user',
          key: string,
          value: unknown
        ) => Promise<string>;
      }
    ).setValue;

    const target = 'openrouter/stealth/ox-alpha';
    await setValue('user', 'llm.active', target);
    await setValue('user', 'llm.active', target);

    const written = JSON.parse(
      await readFile(path.join(tmpHome, '.drone-agent', 'config.json'), 'utf8')
    ) as { llm?: { active?: string } };
    expect(written.llm?.active).toBe(target);

    await setValue('user', 'llm.reasoningLevel', 'medium');
    const withReasoning = JSON.parse(
      await readFile(path.join(tmpHome, '.drone-agent', 'config.json'), 'utf8')
    ) as { llm?: { active?: string; reasoningLevel?: string } };
    expect(withReasoning.llm?.active).toBe(target);
    expect(withReasoning.llm?.reasoningLevel).toBe('medium');
  });
});
