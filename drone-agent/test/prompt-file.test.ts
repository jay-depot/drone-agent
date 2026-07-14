import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resolvePromptFilePath,
  promptFilePlugin,
} from '../src/plugins/prompt-file/index.js';
import { loadAgentConfig } from '../src/runtime/config.js';
import type { DronePluginRegistration } from 'drone-core';

// ---------------------------------------------------------------------------
// Step 5: Path resolution tests
// ---------------------------------------------------------------------------

describe('resolvePromptFilePath', () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'prompt-file-test-'));
    process.chdir(tmpDir);
    vi.spyOn(os, 'homedir').mockReturnValue(tmpDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('resolves ~/ to the home directory', async () => {
    await writeFile(path.join(tmpDir, 'home-file.md'), 'hello');
    const result = await resolvePromptFilePath('~/home-file.md');
    expect(result).toBe(path.join(tmpDir, 'home-file.md'));
  });

  it('returns null for ~/ when file does not exist', async () => {
    const result = await resolvePromptFilePath('~/nonexistent.md');
    expect(result).toBeNull();
  });

  it('resolves ./ relative to CWD', async () => {
    await writeFile(path.join(tmpDir, 'cwd-file.md'), 'hello');
    const result = await resolvePromptFilePath('./cwd-file.md');
    expect(result).toBe(path.join(tmpDir, 'cwd-file.md'));
  });

  it('returns null for ./ when file does not exist', async () => {
    const result = await resolvePromptFilePath('./nonexistent.md');
    expect(result).toBeNull();
  });

  it('resolves ..?/ by walking up from CWD', async () => {
    const nestedDir = path.join(tmpDir, 'a', 'b', 'c');
    await mkdir(nestedDir, { recursive: true });
    await writeFile(path.join(tmpDir, 'root-file.md'), 'found');
    process.chdir(nestedDir);

    const result = await resolvePromptFilePath('..?/root-file.md');
    expect(result).toBe(path.join(tmpDir, 'root-file.md'));
  });

  it('returns null for ..?/ when file is not found in any parent', async () => {
    const nestedDir = path.join(tmpDir, 'a', 'b', 'c');
    await mkdir(nestedDir, { recursive: true });
    process.chdir(nestedDir);

    const result = await resolvePromptFilePath('..?/nonexistent.md');
    expect(result).toBeNull();
  });

  it('treats no-prefix paths as relative to CWD', async () => {
    await writeFile(path.join(tmpDir, 'plain-file.md'), 'hello');
    const result = await resolvePromptFilePath('plain-file.md');
    expect(result).toBe(path.join(tmpDir, 'plain-file.md'));
  });

  it('returns null for no-prefix paths that do not exist', async () => {
    const result = await resolvePromptFilePath('nonexistent.md');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Step 6: Config parsing tests
// ---------------------------------------------------------------------------

describe('promptFile config parsing', () => {
  let testHomeDir = '';
  const originalHomedir = os.homedir;

  async function writeJson(filePath: string, payload: unknown): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(payload, null, 2), 'utf-8');
  }

  async function setupDirs(): Promise<{
    homeDir: string;
    projectDir: string;
  }> {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'drone-agent-home-'));
    const projectDir = await mkdtemp(
      path.join(os.tmpdir(), 'drone-agent-project-')
    );
    testHomeDir = homeDir;
    vi.spyOn(os, 'homedir').mockImplementation(() => testHomeDir);
    return { homeDir, projectDir };
  }

  afterEach(async () => {
    if (testHomeDir) {
      await rm(testHomeDir, { recursive: true, force: true });
    }
    testHomeDir = '';
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    testHomeDir = '';
    os.homedir = originalHomedir;
  });

  it('parses promptFile with enabled and files', async () => {
    const { projectDir } = await setupDirs();
    await writeJson(path.join(projectDir, '.drone-agent/config.json'), {
      promptFile: {
        enabled: true,
        files: ['..?/AGENTS.md', './CONTRIBUTING.md'],
      },
    });

    const resolved = await loadAgentConfig(projectDir);
    expect(resolved.config.promptFile.enabled).toBe(true);
    expect(resolved.config.promptFile.files).toEqual([
      '..?/AGENTS.md',
      './CONTRIBUTING.md',
    ]);
  });

  it('rejects promptFile with non-boolean enabled', async () => {
    const { projectDir } = await setupDirs();
    await writeJson(path.join(projectDir, '.drone-agent/config.json'), {
      promptFile: { enabled: 'yes', files: [] },
    });

    await expect(loadAgentConfig(projectDir)).rejects.toThrow(
      /Expected boolean/
    );
  });

  it('rejects promptFile with non-array files', async () => {
    const { projectDir } = await setupDirs();
    await writeJson(path.join(projectDir, '.drone-agent/config.json'), {
      promptFile: { enabled: true, files: 'not-an-array' },
    });

    await expect(loadAgentConfig(projectDir)).rejects.toThrow(/Expected array/);
  });

  it('rejects promptFile with non-string array elements', async () => {
    const { projectDir } = await setupDirs();
    await writeJson(path.join(projectDir, '.drone-agent/config.json'), {
      promptFile: { enabled: true, files: [42] },
    });

    await expect(loadAgentConfig(projectDir)).rejects.toThrow(
      /Expected string/
    );
  });

  it('rejects promptFile that is not an object', async () => {
    const { projectDir } = await setupDirs();
    await writeJson(path.join(projectDir, '.drone-agent/config.json'), {
      promptFile: 'not-an-object',
    });

    await expect(loadAgentConfig(projectDir)).rejects.toThrow(
      /Expected object/
    );
  });

  it('merges and deduplicates promptFile.files across layers', async () => {
    const { homeDir, projectDir } = await setupDirs();
    await writeJson(path.join(homeDir, '.drone-agent/config.json'), {
      promptFile: {
        enabled: true,
        files: ['~/global-rules.md', '..?/AGENTS.md'],
      },
    });
    await writeJson(path.join(projectDir, '.drone-agent/config.json'), {
      promptFile: { files: ['..?/AGENTS.md', './CONTRIBUTING.md'] },
    });

    const resolved = await loadAgentConfig(projectDir);
    expect(resolved.config.promptFile.enabled).toBe(true);
    // Should include all unique files from both layers
    expect(resolved.config.promptFile.files).toEqual([
      '~/global-rules.md',
      '..?/AGENTS.md',
      './CONTRIBUTING.md',
    ]);
  });

  it('defaults to disabled with empty files when not configured', async () => {
    const { projectDir } = await setupDirs();
    const resolved = await loadAgentConfig(projectDir);
    expect(resolved.config.promptFile.enabled).toBe(false);
    expect(resolved.config.promptFile.files).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Step 7: Plugin integration tests
// ---------------------------------------------------------------------------

describe('promptFilePlugin', () => {
  let tmpDir: string;
  let originalCwd: string;

  function makeRegistration(overrides?: Partial<DronePluginRegistration>): {
    registration: DronePluginRegistration;
    captured: {
      hooks: {
        onPluginsLoaded: Array<() => Promise<void>>;
      };
      prompts: Array<{
        key: string;
        phase: string;
        render: () => Promise<string | false>;
      }>;
      logger: {
        info: ReturnType<typeof vi.fn>;
        warn: ReturnType<typeof vi.fn>;
        error: ReturnType<typeof vi.fn>;
      };
    };
  } {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const captured = {
      hooks: {
        onPluginsLoaded: [] as Array<() => Promise<void>>,
      },
      prompts: [] as Array<{
        key: string;
        phase: string;
        render: () => Promise<string | false>;
      }>,
      logger,
    };

    const baseConfig = {
      enabledPlugins: [],
      systemPrompt: '',
      activePersona: null,
      llm: { provider: 'ollama' },
      ollama: { host: '', model: '' },
      openai: {
        apiKey: '',
        defaultModel: 'gpt-4o',
        baseUrl: 'https://api.openai.com/v1',
        models: [{ id: 'gpt-4o', contextWindow: 128000 }],
      },
      anthropic: {
        apiKey: '',
        defaultModel: 'claude-sonnet-4-6',
        baseUrl: 'https://api.anthropic.com',
        apiVersion: '2023-06-01',
        models: [{ id: 'claude-sonnet-4-6', contextWindow: 200000 }],
      },
      openrouter: {
        apiKey: '',
        defaultModel: 'openai/gpt-4o',
        baseUrl: 'https://openrouter.ai/api/v1',
        models: [
          { id: 'openai/gpt-4o', contextWindow: 128000 },
          { id: 'anthropic/claude-3.5-sonnet', contextWindow: 200000 },
          { id: 'google/gemini-2.0-flash-001', contextWindow: 1000000 },
        ],
      },
      session: {
        contextWindowTokens: 32768,
        responseReserveTokens: 4096,
        maxToolIterations: 50,
      },
      lsp: {
        enabled: false,
        diagnosticTokenBudget: 500,
        requestTimeoutMs: 5000,
        preferExternal: false,
        autoInstall: true,
        servers: {},
      },
      mcp: {
        enabled: false,
        requestTimeoutMs: 10000,
        retryCount: 1,
        retryDelayMs: 200,
        maxListPages: 25,
        maxListItems: 500,
        compatibilityMode: 'strict',
        servers: {},
      },
      compaction: {
        enabled: false,
        strategy: 'summary-drop',
        softThresholdPercent: 75,
        slicePercent: 25,
        minTurnsToCompact: 4,
        summaryMaxTokens: 800,
        summaryBudgetPercent: 20,
      },
      memory: { enabled: false },
      log: { enabled: false },
      terminal: {
        enabled: false,
        maxActiveSessions: 5,
        defaultShell: '',
        defaultCols: 80,
        defaultRows: 24,
      },
      promptFile: { enabled: true, files: [] },
      externalPlugins: [],
      trustedPlugins: {},
      swarm: {
        knowledgeSync: {
          enabled: true,
          pushInsights: true,
          pullOnStartup: true,
          pullIntervalMinutes: 60,
        },
      },
      search: {
        enabled: false,
        paths: [],
      },
    };

    const registration: DronePluginRegistration = {
      logger,
      getConfig: () => ({ ...baseConfig, ...overrides?.getConfig?.() }),
      registerTool: () => {},
      registerPromptFragment: fragment => {
        captured.prompts.push(fragment);
      },
      registerHelp: () => {},
      registerWorkflow: () => {},
      registerSlashCommand: () => {},
      unregisterPluginTools: () => {},
      unregisterTool: () => {},
      hooks: {
        onPluginsLoaded: cb => captured.hooks.onPluginsLoaded.push(cb),
        onSessionStart: () => {},
        onBeforePrompt: () => {},
        onAfterToolCall: () => {},
        onConversationEvent: () => {},
        onSessionClear: () => {},
        onShutdown: () => {},
        onSessionSafetyTrimWillRun: () => {},
        onSessionSafetyTrimApplied: () => {},
      },
      offer: () => {},
      request: () => undefined,
      runWorkflow: async () => ({ toolResult: '{}' }),
      requestElicitation: () => undefined,
      ...overrides,
    };

    return { registration, captured };
  }

  beforeEach(async () => {
    originalCwd = process.cwd();
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'prompt-file-plugin-'));
    process.chdir(tmpDir);
    vi.spyOn(os, 'homedir').mockReturnValue(tmpDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('registers a prompt fragment when files are found', async () => {
    await writeFile(path.join(tmpDir, 'test.md'), 'Hello from test file');

    const { registration, captured } = makeRegistration({
      getConfig: () => ({
        ...makeRegistration().registration.getConfig(),
        promptFile: { enabled: true, files: ['./test.md'] },
      }),
    });

    await promptFilePlugin.register(registration);
    expect(captured.hooks.onPluginsLoaded).toHaveLength(1);

    await captured.hooks.onPluginsLoaded[0]();

    expect(captured.prompts).toHaveLength(1);
    expect(captured.prompts[0].key).toBe('prompt-file-content');
    expect(captured.prompts[0].phase).toBe('header');

    const rendered = await captured.prompts[0].render();
    expect(rendered).toContain('Hello from test file');
    expect(rendered).toContain('test.md');
  });

  it('skips registration when plugin is disabled', async () => {
    const { registration, captured } = makeRegistration({
      getConfig: () => ({
        ...makeRegistration().registration.getConfig(),
        promptFile: { enabled: false, files: ['./test.md'] },
      }),
    });

    await promptFilePlugin.register(registration);
    await captured.hooks.onPluginsLoaded[0]();

    expect(captured.prompts).toHaveLength(0);
    expect(captured.logger.info).toHaveBeenCalledWith(
      expect.stringContaining('disabled')
    );
  });

  it('warns when configured files are not found', async () => {
    const { registration, captured } = makeRegistration({
      getConfig: () => ({
        ...makeRegistration().registration.getConfig(),
        promptFile: { enabled: true, files: ['./nonexistent.md'] },
      }),
    });

    await promptFilePlugin.register(registration);
    await captured.hooks.onPluginsLoaded[0]();

    expect(captured.prompts).toHaveLength(0);
    expect(captured.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('could not resolve')
    );
  });

  it('concatenates multiple files with separators', async () => {
    await writeFile(path.join(tmpDir, 'a.md'), 'Content A');
    await writeFile(path.join(tmpDir, 'b.md'), 'Content B');

    const { registration, captured } = makeRegistration({
      getConfig: () => ({
        ...makeRegistration().registration.getConfig(),
        promptFile: { enabled: true, files: ['./a.md', './b.md'] },
      }),
    });

    await promptFilePlugin.register(registration);
    await captured.hooks.onPluginsLoaded[0]();

    expect(captured.prompts).toHaveLength(1);
    const rendered = await captured.prompts[0].render();
    expect(rendered).toContain('Content A');
    expect(rendered).toContain('Content B');
    expect(rendered).toContain('---');
  });

  it('logs info when enabled but no files configured', async () => {
    const { registration, captured } = makeRegistration({
      getConfig: () => ({
        ...makeRegistration().registration.getConfig(),
        promptFile: { enabled: true, files: [] },
      }),
    });

    await promptFilePlugin.register(registration);
    await captured.hooks.onPluginsLoaded[0]();

    expect(captured.prompts).toHaveLength(0);
    expect(captured.logger.info).toHaveBeenCalledWith(
      expect.stringContaining('no files configured')
    );
  });

  it('re-reads file content on each render call (hot-reload)', async () => {
    const filePath = path.join(tmpDir, 'hotreload.md');
    await writeFile(filePath, 'Version 1');

    const { registration, captured } = makeRegistration({
      getConfig: () => ({
        ...makeRegistration().registration.getConfig(),
        promptFile: { enabled: true, files: ['./hotreload.md'] },
      }),
    });

    await promptFilePlugin.register(registration);
    await captured.hooks.onPluginsLoaded[0]();

    expect(captured.prompts).toHaveLength(1);

    // First render reads the original content
    const firstRender = await captured.prompts[0].render();
    expect(firstRender).toContain('Version 1');

    // Modify the file
    await writeFile(filePath, 'Version 2');

    // Second render picks up the new content
    const secondRender = await captured.prompts[0].render();
    expect(secondRender).toContain('Version 2');
    expect(secondRender).not.toContain('Version 1');
  });
});
