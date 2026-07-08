import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import os from 'node:os';
import {
  parseMacroFile,
  substituteMacroArgs,
} from '../src/plugins/macros/parser.js';
import { loadMacros } from '../src/plugins/macros/loader.js';
import { macrosPlugin } from '../src/plugins/macros/index.js';
import { silentLogger } from './helpers.js';
import { createDronePluginEngine } from '../src/runtime/plugin-engine.js';
import { createDefaultAgentConfig } from 'drone-core';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'drone-macros-'));
  try {
    vi.spyOn(os, 'homedir').mockReturnValue(path.join(dir, 'fake-home'));
    return await fn(dir);
  } finally {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeMacro(
  dir: string,
  filename: string,
  content: string
): Promise<string> {
  const macroDir = path.join(dir, '.drone-agent', 'macros');
  await mkdir(macroDir, { recursive: true });
  const filePath = path.join(macroDir, filename);
  await writeFile(filePath, content, 'utf-8');
  return filePath;
}

// ---------------------------------------------------------------------------
// Parser tests
// ---------------------------------------------------------------------------

describe('parseMacroFile', () => {
  it('parses a valid macro with #! declaration, comments, and steps', () => {
    const content = [
      '#! /plan Switch to plan persona and start planning',
      '# This is a comment',
      '/persona select plan',
      'Design a new feature using the plan persona.',
      '',
    ].join('\n');

    const result = parseMacroFile(content, '/fake/path/plan.macro');
    expect(result.command).toBe('/plan');
    expect(result.description).toBe(
      'Switch to plan persona and start planning'
    );
    expect(result.filePath).toBe('/fake/path/plan.macro');
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0]).toEqual({
      kind: 'slashCommand',
      line: '/persona select plan',
    });
    expect(result.steps[1]).toEqual({
      kind: 'chatPrompt',
      text: 'Design a new feature using the plan persona.',
    });
  });

  it('uses first comment as fallback description when #! has no description', () => {
    const content = [
      '#! /plan',
      '# Switch to plan persona and start planning',
      '/persona select plan',
    ].join('\n');

    const result = parseMacroFile(content, '/fake/path/plan.macro');
    expect(result.command).toBe('/plan');
    expect(result.description).toBe(
      'Switch to plan persona and start planning'
    );
  });

  it('detects positional arguments $1, $2', () => {
    const content = [
      '#! /review Review a file',
      '/persona select $1',
      'Review the file at path $2',
    ].join('\n');

    const result = parseMacroFile(content, '/fake/path/review.macro');
    expect(result.argSpec).toEqual([
      { position: 1, required: true },
      { position: 2, required: true },
    ]);
    expect(result.hasCatchAll).toBe(false);
    expect(result.catchAllOptional).toBe(false);
  });

  it('detects optional arguments $1?, $$?', () => {
    const content = ['#! /greet', 'Hello $1?', 'How are you doing $$?'].join(
      '\n'
    );

    const result = parseMacroFile(content, '/fake/path/greet.macro');
    expect(result.argSpec).toEqual([{ position: 1, required: false }]);
    expect(result.hasCatchAll).toBe(true);
    expect(result.catchAllOptional).toBe(true);
  });

  it('detects required catch-all $$', () => {
    const content = ['#! /echo', 'You said: $$'].join('\n');

    const result = parseMacroFile(content, '/fake/path/echo.macro');
    expect(result.hasCatchAll).toBe(true);
    expect(result.catchAllOptional).toBe(false);
    expect(result.argSpec).toEqual([]);
  });

  it('throws on missing #! declaration', () => {
    const content = ['/persona select plan', 'Design a new feature.'].join(
      '\n'
    );

    expect(() => parseMacroFile(content, '/fake/path/bad.macro')).toThrow(
      'first non-empty line must be "#! /<command> [description]"'
    );
  });

  it('throws on empty file', () => {
    expect(() => parseMacroFile('', '/fake/path/empty.macro')).toThrow(
      'file is empty'
    );
  });

  it('throws on whitespace-only file', () => {
    expect(() =>
      parseMacroFile('   \n  \n  ', '/fake/path/whitespace.macro')
    ).toThrow('file is empty');
  });

  it('throws on command without leading slash', () => {
    // Actually, the regex requires / before the command name.
    // Let's test a malformed declaration.
    const badContent = '#! plan\n/persona list\n';
    expect(() => parseMacroFile(badContent, '/fake/path/bad.macro')).toThrow(
      'first non-empty line must be "#! /<command> [description]"'
    );
  });

  it('throws on duplicate argument positions', () => {
    const content = ['#! /test', '/cmd $1 $1'].join('\n');

    expect(() => parseMacroFile(content, '/fake/path/dup.macro')).toThrow(
      'duplicate argument $1'
    );
  });

  it('throws when no steps are defined', () => {
    const content = ['#! /empty', '# just a comment', ''].join('\n');

    expect(() => parseMacroFile(content, '/fake/path/empty.macro')).toThrow(
      'no steps defined'
    );
  });

  it('handles only slash command steps', () => {
    const content = [
      '#! /setup',
      '/persona select coder',
      '/model llama3.1',
    ].join('\n');

    const result = parseMacroFile(content, '/fake/path/setup.macro');
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0]).toEqual({
      kind: 'slashCommand',
      line: '/persona select coder',
    });
    expect(result.steps[1]).toEqual({
      kind: 'slashCommand',
      line: '/model llama3.1',
    });
  });

  it('handles only chat prompt steps', () => {
    const content = [
      '#! /ask',
      'What is the meaning of life?',
      'Tell me in one sentence.',
    ].join('\n');

    const result = parseMacroFile(content, '/fake/path/ask.macro');
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0]).toEqual({
      kind: 'chatPrompt',
      text: 'What is the meaning of life?',
    });
    expect(result.steps[1]).toEqual({
      kind: 'chatPrompt',
      text: 'Tell me in one sentence.',
    });
  });
});

// ---------------------------------------------------------------------------
// Substitution tests
// ---------------------------------------------------------------------------

describe('substituteMacroArgs', () => {
  const macro = parseMacroFile('#! /test\n$1 $2 $$\n', '/fake/path/test.macro');

  it('substitutes positional arguments', () => {
    const result = substituteMacroArgs(
      'Hello $1 and $2',
      ['world', 'universe'],
      macro
    );
    expect(result).toBe('Hello world and universe');
  });

  it('substitutes catch-all $$ with remaining args', () => {
    const result = substituteMacroArgs('Args: $$', ['a', 'b', 'c'], macro);
    expect(result).toBe('Args: a b c');
  });

  it('substitutes $$ with single arg', () => {
    const result = substituteMacroArgs('$$', ['hello'], macro);
    expect(result).toBe('hello');
  });

  it('throws on missing required positional argument', () => {
    expect(() => substituteMacroArgs('$1 $2', ['only'], macro)).toThrow(
      'requires argument $2'
    );
  });

  it('throws on missing required catch-all', () => {
    expect(() => substituteMacroArgs('$$', [], macro)).toThrow(
      'requires arguments for $$'
    );
  });

  it('substitutes optional $1? with empty string when missing', () => {
    const optMacro = parseMacroFile('#! /test\n$1?\n', '/fake/path/opt.macro');
    const result = substituteMacroArgs('Hello $1?', [], optMacro);
    expect(result).toBe('Hello ');
  });

  it('substitutes optional $$? with empty string when missing', () => {
    const optMacro = parseMacroFile('#! /test\n$$?\n', '/fake/path/opt2.macro');
    const result = substituteMacroArgs('Args: $$?', [], optMacro);
    expect(result).toBe('Args: ');
  });

  it('leaves unknown $X patterns as-is', () => {
    const result = substituteMacroArgs('$foo $bar', ['x'], macro);
    expect(result).toBe('$foo $bar');
  });

  it('handles mixed required and optional args', () => {
    const mixedMacro = parseMacroFile(
      '#! /test\n$1 $2? $$?\n',
      '/fake/path/mixed.macro'
    );
    const result = substituteMacroArgs('$1 $2? $$?', ['first'], mixedMacro);
    expect(result).toBe('first  ');
  });
});

// ---------------------------------------------------------------------------
// Loader tests
// ---------------------------------------------------------------------------

describe('loadMacros', () => {
  it('loads macros from user directory', async () => {
    await withTempDir(async dir => {
      const userDir = path.join(dir, 'fake-home', '.drone-agent', 'macros');
      await mkdir(userDir, { recursive: true });
      await writeFile(
        path.join(userDir, 'plan.macro'),
        '#! /plan\n/persona select plan\n$$\n',
        'utf-8'
      );

      const macros = await loadMacros(dir);
      expect(macros.size).toBe(1);
      expect(macros.has('/plan')).toBe(true);
      expect(macros.get('/plan')?.steps).toHaveLength(2);
    });
  });

  it('loads macros from project directory', async () => {
    await withTempDir(async dir => {
      const projectDir = path.join(dir, '.drone-agent', 'macros');
      await mkdir(projectDir, { recursive: true });
      await writeFile(
        path.join(projectDir, 'review.macro'),
        '#! /review\n/persona select $1\nReview $2\n',
        'utf-8'
      );

      const macros = await loadMacros(dir);
      expect(macros.size).toBe(1);
      expect(macros.has('/review')).toBe(true);
    });
  });

  it('project macros override user macros with the same command', async () => {
    await withTempDir(async dir => {
      const userDir = path.join(dir, 'fake-home', '.drone-agent', 'macros');
      const projectDir = path.join(dir, '.drone-agent', 'macros');
      await mkdir(userDir, { recursive: true });
      await mkdir(projectDir, { recursive: true });

      await writeFile(
        path.join(userDir, 'plan.macro'),
        '#! /plan\n/persona select user\n',
        'utf-8'
      );
      await writeFile(
        path.join(projectDir, 'plan.macro'),
        '#! /plan\n/persona select project\n',
        'utf-8'
      );

      const macros = await loadMacros(dir);
      expect(macros.size).toBe(1);
      // Project should override user.
      expect(macros.get('/plan')?.steps[0]).toEqual({
        kind: 'slashCommand',
        line: '/persona select project',
      });
    });
  });

  it('returns empty map when no macro files exist', async () => {
    await withTempDir(async dir => {
      const macros = await loadMacros(dir);
      expect(macros.size).toBe(0);
    });
  });

  it('ignores non-.macro files', async () => {
    await withTempDir(async dir => {
      const macroDir = path.join(dir, '.drone-agent', 'macros');
      await mkdir(macroDir, { recursive: true });
      await writeFile(
        path.join(macroDir, 'notes.txt'),
        'This is not a macro file.',
        'utf-8'
      );

      const macros = await loadMacros(dir);
      expect(macros.size).toBe(0);
    });
  });

  it('skips malformed macro files and logs a warning', async () => {
    await withTempDir(async dir => {
      const macroDir = path.join(dir, '.drone-agent', 'macros');
      await mkdir(macroDir, { recursive: true });

      // Write one valid macro
      await writeFile(
        path.join(macroDir, 'valid.macro'),
        '#! /valid\n/persona list\n',
        'utf-8'
      );
      // Write a malformed macro (missing #! declaration)
      await writeFile(
        path.join(macroDir, 'bad.macro'),
        '/persona list\n',
        'utf-8'
      );
      // Write an empty macro
      await writeFile(path.join(macroDir, 'empty.macro'), '', 'utf-8');

      const warnings: string[] = [];
      const logger = {
        info: () => {},
        warn: (msg: string) => warnings.push(msg),
        error: () => {},
      };

      const macros = await loadMacros(dir, logger);

      // Only the valid macro should be loaded
      expect(macros.size).toBe(1);
      expect(macros.has('/valid')).toBe(true);

      // Two warnings should have been logged (one for each invalid file)
      expect(warnings.length).toBe(2);
      expect(warnings[0]).toContain('Skipping invalid macro file');
      expect(warnings[0]).toContain('bad.macro');
      expect(warnings[1]).toContain('Skipping invalid macro file');
      expect(warnings[1]).toContain('empty.macro');
    });
  });
});

// ---------------------------------------------------------------------------
// Plugin integration tests
// ---------------------------------------------------------------------------

describe('macrosPlugin', () => {
  it('registers slash commands from loaded macros', async () => {
    await withTempDir(async dir => {
      vi.spyOn(process, 'cwd').mockReturnValue(dir);

      const macroDir = path.join(dir, '.drone-agent', 'macros');
      await mkdir(macroDir, { recursive: true });
      await writeFile(
        path.join(macroDir, 'plan.macro'),
        '#! /plan\n/persona select plan\n$$\n',
        'utf-8'
      );

      const engine = createDronePluginEngine({
        plugins: [macrosPlugin],
        config: {
          ...createDefaultAgentConfig(),
          enabledPlugins: ['macros'],
        },
        logger: silentLogger(),
      });

      await engine.initialize();
      await engine.runHooks('onPluginsLoaded');

      const commands = engine.getSlashCommands();
      const planCmd = commands.find(c => c.command === '/plan');
      expect(planCmd).toBeDefined();
      expect(planCmd?.description).toBeDefined();
    });
  });

  it('registers /macro slash command for management', async () => {
    await withTempDir(async dir => {
      vi.spyOn(process, 'cwd').mockReturnValue(dir);

      const engine = createDronePluginEngine({
        plugins: [macrosPlugin],
        config: {
          ...createDefaultAgentConfig(),
          enabledPlugins: ['macros'],
        },
        logger: silentLogger(),
      });

      await engine.initialize();
      await engine.runHooks('onPluginsLoaded');

      const commands = engine.getSlashCommands();
      const macroCmd = commands.find(c => c.command === '/macro');
      expect(macroCmd).toBeDefined();
      expect(macroCmd?.description).toContain('Manage macros');
    });
  });

  it('executes a macro with slash command steps', async () => {
    await withTempDir(async dir => {
      vi.spyOn(process, 'cwd').mockReturnValue(dir);

      const macroDir = path.join(dir, '.drone-agent', 'macros');
      await mkdir(macroDir, { recursive: true });
      await writeFile(
        path.join(macroDir, 'test.macro'),
        '#! /test\n/persona select coder\n',
        'utf-8'
      );

      const engine = createDronePluginEngine({
        plugins: [macrosPlugin],
        config: {
          ...createDefaultAgentConfig(),
          enabledPlugins: ['macros'],
        },
        logger: silentLogger(),
      });

      await engine.initialize();
      await engine.runHooks('onPluginsLoaded');

      // Dispatch /test — it should be handled by the macro.
      const handled = await engine.dispatchSlashCommand('/test', {
        logger: silentLogger(),
        engine,
        conversation: undefined,
        sessionManager: undefined,
      });
      expect(handled).toBe(true);
    });
  });

  it('executes a macro with argument substitution', async () => {
    await withTempDir(async dir => {
      vi.spyOn(process, 'cwd').mockReturnValue(dir);

      const macroDir = path.join(dir, '.drone-agent', 'macros');
      await mkdir(macroDir, { recursive: true });
      await writeFile(
        path.join(macroDir, 'greet.macro'),
        '#! /greet\nHello $1!\n',
        'utf-8'
      );

      const engine = createDronePluginEngine({
        plugins: [macrosPlugin],
        config: {
          ...createDefaultAgentConfig(),
          enabledPlugins: ['macros'],
        },
        logger: silentLogger(),
      });

      await engine.initialize();
      await engine.runHooks('onPluginsLoaded');

      // Dispatch /greet world — should substitute $1 with "world"
      const handled = await engine.dispatchSlashCommand('/greet world', {
        logger: silentLogger(),
        engine,
        conversation: undefined,
        sessionManager: undefined,
      });
      expect(handled).toBe(true);
    });
  });

  it('provides help snippets', async () => {
    await withTempDir(async dir => {
      vi.spyOn(process, 'cwd').mockReturnValue(dir);

      const engine = createDronePluginEngine({
        plugins: [macrosPlugin],
        config: {
          ...createDefaultAgentConfig(),
          enabledPlugins: ['macros'],
        },
        logger: silentLogger(),
      });

      await engine.initialize();
      await engine.runHooks('onPluginsLoaded');

      const snippets = engine.getHelpSnippets();
      expect(snippets.length).toBeGreaterThanOrEqual(3);
      expect(snippets.some(s => s.includes('/macro list'))).toBe(true);
      expect(snippets.some(s => s.includes('/macro reload'))).toBe(true);
      expect(snippets.some(s => s.includes('/macro show'))).toBe(true);
    });
  });

  it('reports no macros loaded when no .macro files exist', async () => {
    await withTempDir(async dir => {
      vi.spyOn(process, 'cwd').mockReturnValue(dir);

      const engine = createDronePluginEngine({
        plugins: [macrosPlugin],
        config: {
          ...createDefaultAgentConfig(),
          enabledPlugins: ['macros'],
        },
        logger: silentLogger(),
      });

      await engine.initialize();
      await engine.runHooks('onPluginsLoaded');

      const commands = engine.getSlashCommands();
      // Only /macro should be registered (no user macros), plus built-in commands.
      const macroCommands = commands.filter(c => c.command === '/macro');
      expect(macroCommands.length).toBe(1);
      expect(macroCommands[0].command).toBe('/macro');
    });
  });

  it('handles missing required args gracefully with helpful message', async () => {
    await withTempDir(async dir => {
      vi.spyOn(process, 'cwd').mockReturnValue(dir);

      const macroDir = path.join(dir, '.drone-agent', 'macros');
      await mkdir(macroDir, { recursive: true });
      await writeFile(
        path.join(macroDir, 'greet.macro'),
        '#! /greet Greet someone\nHello $1!\n',
        'utf-8'
      );

      const engine = createDronePluginEngine({
        plugins: [macrosPlugin],
        config: {
          ...createDefaultAgentConfig(),
          enabledPlugins: ['macros'],
        },
        logger: silentLogger(),
      });

      await engine.initialize();
      await engine.runHooks('onPluginsLoaded');

      // Dispatch /greet with no args — should not crash, should log a warning
      const warnings: string[] = [];
      const handled = await engine.dispatchSlashCommand('/greet', {
        logger: {
          info: () => {},
          warn: (msg: string) => warnings.push(msg),
          error: () => {},
        },
        engine,
        conversation: undefined,
        sessionManager: undefined,
      });

      // The macro should still be handled (the handler returns true)
      expect(handled).toBe(true);

      // A warning should have been logged about the missing argument
      expect(warnings.length).toBeGreaterThanOrEqual(1);
      expect(warnings[0]).toContain('Macro "');
      expect(warnings[0]).toContain('failed');
      expect(warnings[0]).toContain('requires argument $1');
      expect(warnings[0]).toContain('Usage:');
      expect(warnings[0]).toContain('/greet <arg1>');
    });
  });

  it('logs chatPrompt text and streams events through engine hooks', async () => {
    await withTempDir(async dir => {
      vi.spyOn(process, 'cwd').mockReturnValue(dir);

      const macroDir = path.join(dir, '.drone-agent', 'macros');
      await mkdir(macroDir, { recursive: true });
      await writeFile(
        path.join(macroDir, 'ask.macro'),
        '#! /ask\nWhat is the meaning of life?\n',
        'utf-8'
      );

      const engine = createDronePluginEngine({
        plugins: [macrosPlugin],
        config: {
          ...createDefaultAgentConfig(),
          enabledPlugins: ['macros'],
        },
        logger: silentLogger(),
      });

      await engine.initialize();
      await engine.runHooks('onPluginsLoaded');

      // Register a conversation event listener to capture events
      const capturedEvents: Array<{
        kind: string;
        content?: string;
        name?: string;
      }> = [];
      engine.onConversationEvent(event => {
        capturedEvents.push({
          kind: event.kind,
          content: 'content' in event ? event.content : undefined,
          name: 'name' in event ? event.name : undefined,
        });
      });

      const infoMessages: string[] = [];

      const handled = await engine.dispatchSlashCommand('/ask', {
        logger: {
          info: (msg: string) => infoMessages.push(msg),
          warn: () => {},
          error: () => {},
        },
        engine,
        conversation: {
          getModel: () => 'test-model',
          setModel: () => {},
          getReasoningLevel: () => undefined,
          setReasoningLevel: (_level: any) => {},
          sendUserMessage: async (_prompt: string) => {
            // Simulate the events that conversation-service emits
            // through engine conversation event hooks
            await engine.runConversationEventHooks({
              kind: 'reasoning',
              content: 'Thinking deeply...',
            });
            await engine.runConversationEventHooks({
              kind: 'toolCall',
              name: 'file__read',
              arguments: { path: '/test.txt' },
            });
            await engine.runConversationEventHooks({
              kind: 'toolResult',
              name: 'file__read',
              content: 'file contents',
              arguments: { path: '/test.txt' },
            });
            await engine.runConversationEventHooks({
              kind: 'assistantMessage',
              content: '42',
            });
            return '42';
          },
        },
        sessionManager: undefined,
      });

      expect(handled).toBe(true);

      // The substituted prompt text should be logged first
      expect(infoMessages[0]).toBe('What is the meaning of life?');

      // The reply should be logged
      expect(infoMessages.some(m => m.includes('42'))).toBe(true);

      // Events should be captured through engine conversation event hooks
      expect(capturedEvents.length).toBe(4);
      expect(capturedEvents[0].kind).toBe('reasoning');
      expect(capturedEvents[0].content).toBe('Thinking deeply...');
      expect(capturedEvents[1].kind).toBe('toolCall');
      expect(capturedEvents[1].name).toBe('file__read');
      expect(capturedEvents[2].kind).toBe('toolResult');
      expect(capturedEvents[2].name).toBe('file__read');
      expect(capturedEvents[2].content).toBe('file contents');
      expect(capturedEvents[3].kind).toBe('assistantMessage');
      expect(capturedEvents[3].content).toBe('42');
    });
  });
});
