import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { encodeKeys } from '../src/plugins/terminal/key-codec.js';
import { TerminalSessionManager } from '../src/plugins/terminal/session-manager.js';
import { terminalPlugin } from '../src/plugins/terminal/plugin.js';
import type { DronePluginRegistration, DroneLogger } from 'drone-core';

// ---------------------------------------------------------------------------
// Key encoding tests
// ---------------------------------------------------------------------------

describe('encodeKeys', () => {
  it('passes raw text through unchanged', () => {
    const result = encodeKeys('hello world');
    expect(result.toString()).toBe('hello world');
  });

  it('encodes <Enter> as \\n', () => {
    const result = encodeKeys('echo hello<Enter>');
    expect(result.toString()).toBe('echo hello\n');
  });

  it('encodes <Ctrl-C> as \\x03', () => {
    const result = encodeKeys('<Ctrl-C>');
    expect(result).toEqual(Buffer.from([0x03]));
  });

  it('encodes <Escape> as \\x1b', () => {
    const result = encodeKeys('<Escape>');
    expect(result).toEqual(Buffer.from([0x1b]));
  });

  it('encodes <Esc> as \\x1b', () => {
    const result = encodeKeys('<Esc>');
    expect(result).toEqual(Buffer.from([0x1b]));
  });

  it('encodes <Tab> as \\t', () => {
    const result = encodeKeys('<Tab>');
    expect(result.toString()).toBe('\t');
  });

  it('encodes <Backspace> as \\x7f', () => {
    const result = encodeKeys('<Backspace>');
    expect(result).toEqual(Buffer.from([0x7f]));
  });

  it('encodes <Up> as \\x1b[A', () => {
    const result = encodeKeys('<Up>');
    expect(result).toEqual(Buffer.from([0x1b, 0x5b, 0x41]));
  });

  it('encodes <Down> as \\x1b[B', () => {
    const result = encodeKeys('<Down>');
    expect(result).toEqual(Buffer.from([0x1b, 0x5b, 0x42]));
  });

  it('encodes <Left> as \\x1b[D', () => {
    const result = encodeKeys('<Left>');
    expect(result).toEqual(Buffer.from([0x1b, 0x5b, 0x44]));
  });

  it('encodes <Right> as \\x1b[C', () => {
    const result = encodeKeys('<Right>');
    expect(result).toEqual(Buffer.from([0x1b, 0x5b, 0x43]));
  });

  it('encodes <Delete> as \\x1b[3~', () => {
    const result = encodeKeys('<Delete>');
    expect(result).toEqual(Buffer.from([0x1b, 0x5b, 0x33, 0x7e]));
  });

  it('encodes <Home> as \\x1b[H', () => {
    const result = encodeKeys('<Home>');
    expect(result).toEqual(Buffer.from([0x1b, 0x5b, 0x48]));
  });

  it('encodes <End> as \\x1b[F', () => {
    const result = encodeKeys('<End>');
    expect(result).toEqual(Buffer.from([0x1b, 0x5b, 0x46]));
  });

  it('encodes <PageUp> as \\x1b[5~', () => {
    const result = encodeKeys('<PageUp>');
    expect(result).toEqual(Buffer.from([0x1b, 0x5b, 0x35, 0x7e]));
  });

  it('encodes <PageDown> as \\x1b[6~', () => {
    const result = encodeKeys('<PageDown>');
    expect(result).toEqual(Buffer.from([0x1b, 0x5b, 0x36, 0x7e]));
  });

  it('encodes <F1> as \\x1b[P', () => {
    const result = encodeKeys('<F1>');
    expect(result).toEqual(Buffer.from([0x1b, 0x5b, 0x50]));
  });

  it('encodes <F12> as \\x1b[24~', () => {
    const result = encodeKeys('<F12>');
    expect(result).toEqual(Buffer.from([0x1b, 0x5b, 0x32, 0x34, 0x7e]));
  });

  it('encodes <Alt-X> as \\x1b X', () => {
    const result = encodeKeys('<Alt-x>');
    expect(result).toEqual(Buffer.from([0x1b, 0x78]));
  });

  it('encodes <Alt-A> as \\x1b A', () => {
    const result = encodeKeys('<Alt-A>');
    expect(result).toEqual(Buffer.from([0x1b, 0x41]));
  });

  it('handles << as literal <', () => {
    const result = encodeKeys('<<raw>');
    expect(result.toString()).toBe('<raw>');
  });

  it('handles mixed text and named sequences', () => {
    const result = encodeKeys('ls<Enter>');
    expect(result.toString()).toBe('ls\n');
  });

  it('handles complex mixed input', () => {
    const result = encodeKeys('echo hello<Enter>grep foo<Enter>');
    expect(result.toString()).toBe('echo hello\ngrep foo\n');
  });

  it('passes through unrecognized named sequences as raw text', () => {
    const result = encodeKeys('<UnknownThing>');
    expect(result.toString()).toBe('<UnknownThing>');
  });

  it('handles unclosed bracket as raw text', () => {
    const result = encodeKeys('hello <world');
    expect(result.toString()).toBe('hello <world');
  });

  it('returns empty buffer for empty string', () => {
    const result = encodeKeys('');
    expect(result.length).toBe(0);
  });

  it('handles Ctrl-A through Ctrl-Z', () => {
    for (let i = 0; i < 26; i++) {
      const letter = String.fromCharCode(65 + i); // A-Z
      const result = encodeKeys(`<Ctrl-${letter}>`);
      expect(result).toEqual(Buffer.from([i + 1]));
    }
  });

  it('handles <Space>', () => {
    const result = encodeKeys('<Space>');
    expect(result.toString()).toBe(' ');
  });
});

// ---------------------------------------------------------------------------
// Session manager tests
// ---------------------------------------------------------------------------

describe('TerminalSessionManager', () => {
  let manager: TerminalSessionManager;

  beforeEach(() => {
    manager = new TerminalSessionManager(5);
  });

  afterEach(() => {
    manager.killAll();
  });

  describe('create', () => {
    it('creates a session with a shell command', () => {
      const id = manager.create('/bin/sh', '/tmp', 80, 24);
      expect(id).toBe('term-1');
      expect(manager.count).toBe(1);
    });

    it('auto-resolves shell when command is empty', () => {
      const id = manager.create('', '/tmp', 80, 24);
      expect(id).toBe('term-1');
      expect(manager.count).toBe(1);
    });

    it('assigns sequential IDs', () => {
      const id1 = manager.create('/bin/sh', '/tmp', 80, 24);
      const id2 = manager.create('/bin/sh', '/tmp', 80, 24);
      expect(id1).toBe('term-1');
      expect(id2).toBe('term-2');
    });

    it('throws when at capacity', () => {
      const small = new TerminalSessionManager(1);
      small.create('/bin/sh', '/tmp', 80, 24);
      expect(() => small.create('/bin/sh', '/tmp', 80, 24)).toThrow(
        /Maximum terminal sessions/
      );
      small.killAll();
    });
  });

  describe('list', () => {
    it('returns empty list when no sessions', () => {
      expect(manager.list()).toEqual([]);
    });

    it('returns session metadata', () => {
      const id = manager.create('/bin/sh', '/tmp', 80, 24);
      const list = manager.list();
      expect(list).toHaveLength(1);
      expect(list[0].id).toBe(id);
      expect(list[0].command).toBe('/bin/sh');
      expect(list[0].cwd).toBe('/tmp');
      expect(list[0].cols).toBe(80);
      expect(list[0].rows).toBe(24);
      expect(list[0].createdAt).toBeTruthy();
    });
  });

  describe('write and read', () => {
    it('writes data and reads output', async () => {
      const id = manager.create('/bin/sh', '/tmp', 80, 24);

      // Write a command
      manager.write(id, 'echo hello\n');

      // Wait for output to accumulate
      await new Promise(resolve => setTimeout(resolve, 300));

      const output = manager.read(id);
      expect(output).toContain('hello');
    });

    it('read() drains pending output', async () => {
      const id = manager.create('/bin/sh', '/tmp', 80, 24);

      manager.write(id, 'echo first\n');
      await new Promise(resolve => setTimeout(resolve, 300));
      const first = manager.read(id);
      expect(first).toContain('first');

      // After read, pending should be empty
      const second = manager.read(id);
      expect(second).toBe('');
    });
  });

  describe('screenshot', () => {
    it('returns full accumulated output', async () => {
      const id = manager.create('/bin/sh', '/tmp', 80, 24);

      manager.write(id, 'echo alpha\n');
      await new Promise(resolve => setTimeout(resolve, 300));
      manager.read(id); // drain

      manager.write(id, 'echo beta\n');
      await new Promise(resolve => setTimeout(resolve, 300));

      const screen = manager.screenshot(id);
      // screenshot should have ALL output, including what was already read
      expect(screen).toContain('alpha');
      expect(screen).toContain('beta');
    });
  });

  describe('resize', () => {
    it('updates dimensions', () => {
      const id = manager.create('/bin/sh', '/tmp', 80, 24);
      manager.resize(id, 132, 43);
      const list = manager.list();
      expect(list[0].cols).toBe(132);
      expect(list[0].rows).toBe(43);
    });

    it('throws for unknown session', () => {
      expect(() => manager.resize('term-999', 80, 24)).toThrow(/not found/);
    });
  });

  describe('kill', () => {
    it('removes a session', () => {
      const id = manager.create('/bin/sh', '/tmp', 80, 24);
      expect(manager.count).toBe(1);
      const killed = manager.kill(id);
      expect(killed).toBe(true);
      expect(manager.count).toBe(0);
    });

    it('returns false for unknown session', () => {
      expect(manager.kill('term-999')).toBe(false);
    });
  });

  describe('killAll', () => {
    it('kills all sessions', () => {
      manager.create('/bin/sh', '/tmp', 80, 24);
      manager.create('/bin/sh', '/tmp', 80, 24);
      manager.create('/bin/sh', '/tmp', 80, 24);
      expect(manager.count).toBe(3);
      manager.killAll();
      expect(manager.count).toBe(0);
    });

    it('is safe to call multiple times', () => {
      manager.killAll();
      manager.killAll(); // should not throw
    });
  });

  describe('isFull', () => {
    it('returns true when at capacity', () => {
      const small = new TerminalSessionManager(2);
      expect(small.isFull).toBe(false);
      small.create('/bin/sh', '/tmp', 80, 24);
      expect(small.isFull).toBe(false);
      small.create('/bin/sh', '/tmp', 80, 24);
      expect(small.isFull).toBe(true);
      small.killAll();
    });
  });

  describe('resolveShellCommand', () => {
    it('returns the shell if provided', () => {
      expect(TerminalSessionManager.resolveShellCommand('/bin/bash')).toBe(
        '/bin/bash'
      );
    });

    it('falls back to $SHELL or /bin/sh when empty', () => {
      const result = TerminalSessionManager.resolveShellCommand('');
      expect(result).toBeTruthy();
      // Should be either /bin/sh or the user's shell
      expect(result.startsWith('/')).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Plugin registration tests
// ---------------------------------------------------------------------------

describe('terminalPlugin', () => {
  it('has correct metadata', () => {
    expect(terminalPlugin.metadata.id).toBe('terminal');
    expect(terminalPlugin.metadata.name).toBe('Terminal');
    expect(terminalPlugin.metadata.defaultEnabled).toBe(false);
  });

  it('registers tools and prompt fragment', async () => {
    const registeredTools: string[] = [];
    const registeredFragments: { key: string; phase: string }[] = [];
    let shutdownHook: (() => Promise<void>) | undefined;

    const mockRegistration: DronePluginRegistration = {
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
      } as DroneLogger,
      getConfig: () => ({
        enabledPlugins: ['terminal'],
        externalPlugins: [],
        trustedPlugins: {},
        systemPrompt: '',
        activePersona: null,
        llm: { provider: 'ollama' },
        ollama: { host: 'http://127.0.0.1:11434', model: 'llama3.1' },
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
          promptOnToolIterationLimit: false,
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
          spawnTimeoutMs: 30000,
          retryCount: 1,
          retryDelayMs: 200,
          maxListPages: 25,
          maxListItems: 500,
          compatibilityMode: 'strict',
          maxResponseSizeBytes: 1048576,
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
          enabled: true,
          maxActiveSessions: 5,
          defaultShell: '',
          defaultCols: 80,
          defaultRows: 24,
        },
        promptFile: { enabled: false, files: [] },
        swarm: {
          knowledgeSync: {
            enabled: true,
            pushInsights: true,
            pullOnStartup: true,
            pullIntervalMinutes: 60,
          },
        },
        tui: {
          syntaxHighlighting: {
            colors: {
              keyword: 'magenta',
            },
            codeBackground: 'gray',
          },
        },
      }),
      registerTool: (tool: { name: string; defaultHidden?: boolean }) => {
        registeredTools.push(tool.name);
        // Verify all terminal tools are defaultHidden
        if (tool.name.startsWith('terminal__')) {
          expect(tool.defaultHidden).toBe(true);
        }
      },
      registerPromptFragment: (frag: { key: string; phase: string }) => {
        registeredFragments.push(frag);
      },
      registerHelp: () => {},
      registerWorkflow: () => {},
      registerSlashCommand: () => {},
      unregisterPluginTools: () => {},
      unregisterTool: () => {},
      hooks: {
        onPluginsLoaded: () => {},
        onSessionStart: () => {},
        onBeforePrompt: () => {},
        onAfterToolCall: () => {},
        onConversationEvent: () => {},
        onShutdown: (cb: () => Promise<void>) => {
          shutdownHook = cb;
        },
        onSessionClear: () => {},
        onSessionSafetyTrimWillRun: () => {},
        onSessionSafetyTrimApplied: () => {},
      },
      offer: () => {},
      request: () => undefined,
      runWorkflow: async () => ({ toolResult: '{}' }),
      requestElicitation: () => undefined,
    };

    await terminalPlugin.register(mockRegistration);

    // Verify all expected tools are registered
    const expectedTools = [
      'create',
      'write',
      'read',
      'screenshot',
      'resize',
      'list',
      'kill',
    ];
    for (const tool of expectedTools) {
      expect(registeredTools).toContain(tool);
    }

    // Verify prompt fragment is registered
    const fragment = registeredFragments.find(
      f => f.key === 'terminal-active-sessions'
    );
    expect(fragment).toBeDefined();
    expect(fragment!.phase).toBe('header');

    // Verify onShutdown hook is registered
    expect(shutdownHook).toBeDefined();
  });
});
