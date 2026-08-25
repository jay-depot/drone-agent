import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadAgentConfig } from '../src/runtime/config.js';

let testHomeDir = '';
const originalHomedir = os.homedir;

async function writeJson(filePath: string, payload: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(payload, null, 2), 'utf-8');
}

async function setupDirs(): Promise<{
  homeDir: string;
  projectDir: string;
  parentDir: string;
  orphanDir: string;
}> {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'drone-agent-home-'));
  const parentDir = await mkdtemp(
    path.join(os.tmpdir(), 'drone-agent-parent-')
  );
  const projectDir = path.join(parentDir, 'project');
  const orphanDir = await mkdtemp(
    path.join(os.tmpdir(), 'drone-agent-orphan-')
  );
  await mkdir(projectDir, { recursive: true });
  testHomeDir = homeDir;
  // Patch os.homedir() for the duration of this test so the loader reads
  // its "user" config from our temp directory.
  vi.spyOn(os, 'homedir').mockImplementation(() => testHomeDir);
  return { homeDir, parentDir, projectDir, orphanDir };
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

describe('loadAgentConfig', () => {
  it('returns defaults when no config files exist', async () => {
    const { projectDir } = await setupDirs();
    const resolved = await loadAgentConfig(projectDir);
    expect(resolved.layers).toHaveLength(1);
    expect(resolved.layers[0].scope).toBe('default');
    expect(resolved.config.ollama.host).toMatch(/^https?:\/\//);
    expect(resolved.config.compaction.strategy).toBe('summary-drop');
  });

  it('layers defaults + user + project config in that order', async () => {
    const { projectDir } = await setupDirs();
    await writeJson(path.join(testHomeDir, '.drone-agent/config.json'), {
      ollama: { host: 'http://user-host:11434' },
    });
    await writeJson(path.join(projectDir, '.drone-agent/config.json'), {
      ollama: { model: 'project-model' },
    });

    const resolved = await loadAgentConfig(projectDir);
    expect(resolved.layers.map(l => l.scope)).toEqual([
      'default',
      'user',
      'project',
    ]);
    expect(resolved.config.ollama.host).toBe('http://user-host:11434');
    expect(resolved.config.ollama.model).toBe('project-model');
  });

  it('walks upward to find the project config', async () => {
    const { projectDir, parentDir } = await setupDirs();
    await writeJson(path.join(parentDir, '.drone-agent/config.json'), {
      session: { contextWindowTokens: 65536 },
    });
    const nestedDir = path.join(projectDir, 'src', 'nested');
    await mkdir(nestedDir, { recursive: true });

    const resolved = await loadAgentConfig(nestedDir);
    expect(resolved.config.session.contextWindowTokens).toBe(65536);
    expect(resolved.layers.some(l => l.scope === 'project')).toBe(true);
  });

  it('rejects config files that are not strict JSON objects', async () => {
    const { projectDir } = await setupDirs();
    await writeJson(path.join(projectDir, '.drone-agent/config.json'), [
      'not',
      'an',
      'object',
    ]);
    await expect(loadAgentConfig(projectDir)).rejects.toThrow(
      /Expected object/
    );
  });

  it('rejects malformed LSP servers', async () => {
    const { projectDir } = await setupDirs();
    await writeJson(path.join(projectDir, '.drone-agent/config.json'), {
      lsp: { servers: { broken: { transport: 'tcp' } } },
    });
    await expect(loadAgentConfig(projectDir)).rejects.toThrow(
      /Expected union value/
    );
  });

  it('rejects unsupported LSP transports', async () => {
    const { projectDir } = await setupDirs();
    await writeJson(path.join(projectDir, '.drone-agent/config.json'), {
      lsp: { servers: { bad: { transport: 'websockets' } } },
    });
    await expect(loadAgentConfig(projectDir)).rejects.toThrow(
      /Expected union value/
    );
  });

  it('parses a stdio LSP server with optional args and roots', async () => {
    const { projectDir } = await setupDirs();
    await writeJson(path.join(projectDir, '.drone-agent/config.json'), {
      lsp: {
        servers: {
          ts: {
            transport: 'stdio',
            command: 'typescript-language-server',
            args: ['--stdio'],
            fileExtensions: ['.ts', '.tsx'],
            rootPatterns: ['tsconfig.json'],
          },
        },
      },
    });
    const resolved = await loadAgentConfig(projectDir);
    expect(resolved.config.lsp.servers.ts).toMatchObject({
      transport: 'stdio',
      command: 'typescript-language-server',
      args: ['--stdio'],
      fileExtensions: ['.ts', '.tsx'],
      rootPatterns: ['tsconfig.json'],
    });
  });

  it('rejects MCP streamable_http servers without a URL', async () => {
    const { projectDir } = await setupDirs();
    await writeJson(path.join(projectDir, '.drone-agent/config.json'), {
      mcp: { servers: { http: { transport: 'streamable_http' } } },
    });
    await expect(loadAgentConfig(projectDir)).rejects.toThrow(
      /Expected union value/
    );
  });

  it('parses a streamable_http MCP server with headers and retry settings', async () => {
    const { projectDir } = await setupDirs();
    await writeJson(path.join(projectDir, '.drone-agent/config.json'), {
      mcp: {
        servers: {
          remote: {
            transport: 'streamable_http',
            url: 'https://example.com/mcp',
            headers: { Authorization: 'Bearer ${TEST_TOKEN}' },
            retryCount: 3,
            retryDelayMs: 250,
            maxListPages: 10,
            maxListItems: 100,
            compatibilityMode: 'permissive',
          },
        },
      },
    });
    process.env.TEST_TOKEN = 'secret-token';
    try {
      const resolved = await loadAgentConfig(projectDir);
      expect(resolved.config.mcp.servers.remote).toMatchObject({
        transport: 'streamable_http',
        url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer secret-token' },
        retryCount: 3,
        retryDelayMs: 250,
        compatibilityMode: 'permissive',
      });
    } finally {
      delete process.env.TEST_TOKEN;
    }
  });

  it('throws when an environment variable interpolation target is unset', async () => {
    const { projectDir } = await setupDirs();
    await writeJson(path.join(projectDir, '.drone-agent/config.json'), {
      mcp: {
        servers: {
          remote: {
            transport: 'streamable_http',
            url: 'https://example.com/${MISSING_VAR}',
          },
        },
      },
    });
    delete process.env.MISSING_VAR;
    await expect(loadAgentConfig(projectDir)).rejects.toThrow(
      /unset environment variable MISSING_VAR/
    );
  });

  it('parses a stdio MCP server with command and args', async () => {
    const { projectDir } = await setupDirs();
    await writeJson(path.join(projectDir, '.drone-agent/config.json'), {
      mcp: {
        servers: {
          local: {
            transport: 'stdio',
            command: 'node',
            args: ['./mcp-server.js', '--stdio'],
            cwd: '/tmp',
            env: { LOG_LEVEL: 'info' },
            requestTimeoutMs: 5000,
          },
        },
      },
    });
    const resolved = await loadAgentConfig(projectDir);
    expect(resolved.config.mcp.servers.local).toMatchObject({
      transport: 'stdio',
      command: 'node',
      args: ['./mcp-server.js', '--stdio'],
      cwd: '/tmp',
      env: { LOG_LEVEL: 'info' },
      requestTimeoutMs: 5000,
    });
  });

  it('rejects unsupported compaction strategies', async () => {
    const { projectDir } = await setupDirs();
    await writeJson(path.join(projectDir, '.drone-agent/config.json'), {
      compaction: { strategy: 'rolling-window' },
    });
    await expect(loadAgentConfig(projectDir)).rejects.toThrow(
      /Expected 'summary-drop'/
    );
  });

  it('rejects compaction percent values out of range', async () => {
    const { projectDir } = await setupDirs();
    await writeJson(path.join(projectDir, '.drone-agent/config.json'), {
      compaction: { softThresholdPercent: 150 },
    });
    await expect(loadAgentConfig(projectDir)).rejects.toThrow(
      /Expected number to be less or equal to 100/
    );
  });

  it('rejects negative session responseReserveTokens', async () => {
    const { projectDir } = await setupDirs();
    await writeJson(path.join(projectDir, '.drone-agent/config.json'), {
      session: { responseReserveTokens: -1 },
    });
    await expect(loadAgentConfig(projectDir)).rejects.toThrow(
      /Expected number to be greater than 0/
    );
  });

  it('accepts a positive integer maxToolIterations', async () => {
    const { projectDir } = await setupDirs();
    await writeJson(path.join(projectDir, '.drone-agent/config.json'), {
      session: { maxToolIterations: 25 },
    });
    const resolved = await loadAgentConfig(projectDir);
    expect(resolved.config.session.maxToolIterations).toBe(25);
  });

  it('rejects non-integer maxToolIterations', async () => {
    const { projectDir } = await setupDirs();
    await writeJson(path.join(projectDir, '.drone-agent/config.json'), {
      session: { maxToolIterations: 1.5 },
    });
    await expect(loadAgentConfig(projectDir)).rejects.toThrow(
      /Expected integer/
    );
  });

  it('rejects zero or negative maxToolIterations', async () => {
    const { projectDir } = await setupDirs();
    await writeJson(path.join(projectDir, '.drone-agent/config.json'), {
      session: { maxToolIterations: 0 },
    });
    await expect(loadAgentConfig(projectDir)).rejects.toThrow(
      /Expected integer to be greater than 0/
    );
  });

  it('rejects non-numeric maxToolIterations', async () => {
    const { projectDir } = await setupDirs();
    await writeJson(path.join(projectDir, '.drone-agent/config.json'), {
      session: { maxToolIterations: 'lots' },
    });
    await expect(loadAgentConfig(projectDir)).rejects.toThrow(
      /Expected integer/
    );
  });

  it('rejects non-string systemPrompt values', async () => {
    const { projectDir } = await setupDirs();
    await writeJson(path.join(projectDir, '.drone-agent/config.json'), {
      systemPrompt: 42,
    });
    await expect(loadAgentConfig(projectDir)).rejects.toThrow(
      /Expected string/
    );
  });

  it('accepts null activePersona to explicitly disable it', async () => {
    const { projectDir } = await setupDirs();
    await writeJson(path.join(projectDir, '.drone-agent/config.json'), {
      activePersona: null,
    });
    const resolved = await loadAgentConfig(projectDir);
    expect(resolved.config.activePersona).toBeNull();
  });

  it('reports invalid JSON as a parse error', async () => {
    const { projectDir } = await setupDirs();
    await mkdir(path.join(projectDir, '.drone-agent'), { recursive: true });
    await writeFile(
      path.join(projectDir, '.drone-agent/config.json'),
      '{ not valid json',
      'utf-8'
    );
    await expect(loadAgentConfig(projectDir)).rejects.toThrow();
  });

  it('skips loading the user config again as project scope when launched from home', async () => {
    const { homeDir } = await setupDirs();
    await writeJson(path.join(testHomeDir, '.drone-agent/config.json'), {
      providers: { anthropic: { protocol: 'anthropic', apiKey: '${K}' } },
    });
    process.env.K = 'test-key';

    try {
      const resolved = await loadAgentConfig(homeDir);
      expect(resolved.layers.map(layer => layer.scope)).toEqual([
        'default',
        'user',
      ]);
      expect(resolved.config.providers).toMatchObject({
        anthropic: { protocol: 'anthropic' },
      });
      expect(resolved.warnings).toContainEqual(
        expect.stringContaining('skipping redundant project-scope load.')
      );
    } finally {
      delete process.env.K;
    }
  });

  it('behaves identically to a projectless launch when started from home', async () => {
    const { homeDir, projectDir } = await setupDirs();
    await writeJson(path.join(testHomeDir, '.drone-agent/config.json'), {
      session: { contextWindowTokens: 65536 },
    });

    const fromHome = await loadAgentConfig(homeDir);
    const fromProject = await loadAgentConfig(projectDir);

    expect(fromHome.layers.map(layer => layer.scope)).toEqual([
      'default',
      'user',
    ]);
    expect(fromHome.config).toEqual(fromProject.config);
  });

  it('loads a distinct project config below home without a dedupe warning', async () => {
    const { homeDir } = await setupDirs();
    const nestedProject = path.join(homeDir, 'work', 'app');
    await mkdir(nestedProject, { recursive: true });
    await writeJson(path.join(testHomeDir, '.drone-agent/config.json'), {
      ollama: { host: 'http://user-host:11434' },
    });
    await writeJson(path.join(nestedProject, '.drone-agent/config.json'), {
      ollama: { model: 'project-model' },
    });

    const resolved = await loadAgentConfig(nestedProject);
    expect(resolved.layers.map(layer => layer.scope)).toEqual([
      'default',
      'user',
      'project',
    ]);
    expect(resolved.config.ollama.model).toBe('project-model');
    expect(
      resolved.warnings?.some(warning =>
        warning.includes('same file as the user config')
      )
    ).toBe(false);
  });

  it('compares against the effective user config path when configDir overrides home', async () => {
    const { homeDir } = await setupDirs();
    const externalConfigDir = await mkdtemp(
      path.join(os.tmpdir(), 'drone-agent-extcfg-')
    );
    try {
      await writeJson(
        path.join(externalConfigDir, '.drone-agent', 'config.json'),
        {
          ollama: { model: 'external-user-model' },
        }
      );
      await writeJson(path.join(testHomeDir, '.drone-agent/config.json'), {
        ollama: { host: 'http://home-file-host:11434' },
      });

      const resolved = await loadAgentConfig(homeDir, {
        configDir: externalConfigDir,
      });

      expect(resolved.layers.map(layer => layer.scope)).toEqual([
        'default',
        'user',
        'project',
      ]);
      expect(resolved.config.ollama.host).toBe('http://home-file-host:11434');
      expect(resolved.config.ollama.model).toBe('external-user-model');
    } finally {
      await rm(externalConfigDir, { recursive: true, force: true });
    }
  });

  it('prefers the nearest project config over the home-level file', async () => {
    const { homeDir } = await setupDirs();
    const nestedProject = path.join(homeDir, 'work', 'app');
    await mkdir(nestedProject, { recursive: true });
    await writeJson(path.join(testHomeDir, '.drone-agent/config.json'), {
      session: { contextWindowTokens: 4096 },
      ollama: { model: 'home-model' },
    });
    await writeJson(path.join(nestedProject, '.drone-agent/config.json'), {
      ollama: { model: 'nearest-project-model' },
    });

    const resolved = await loadAgentConfig(nestedProject);
    expect(
      resolved.layers.filter(layer => layer.scope === 'project')
    ).toHaveLength(1);
    expect(resolved.config.ollama.model).toBe('nearest-project-model');
    expect(resolved.config.session.contextWindowTokens).toBe(4096);
  });
});
