import { describe, expect, it } from 'vitest';
import { parseCliInvocation } from '../src/index.js';

describe('parseCliInvocation — --workflow flag', () => {
  it('parses --workflow with plugin.name format', () => {
    const inv = parseCliInvocation(['--workflow', 'persona.create']);
    expect(inv.kind).toBe('workflow');
    if (inv.kind !== 'workflow') return;
    expect(inv.options.workflow).toEqual({
      pluginId: 'persona',
      workflowName: 'create',
      args: {},
    });
  });

  it('parses repeated --workflow-arg key=value pairs', () => {
    const inv = parseCliInvocation([
      '--workflow',
      'persona.create',
      '--workflow-arg',
      'scope=user',
      '--workflow-arg',
      'description=reviews code',
    ]);
    expect(inv.kind).toBe('workflow');
    if (inv.kind !== 'workflow') return;
    expect(inv.options.workflow.args).toEqual({
      scope: 'user',
      description: 'reviews code',
    });
  });

  it('trims whitespace around keys and preserves values verbatim', () => {
    const inv = parseCliInvocation([
      '--workflow',
      'a.b',
      '--workflow-arg',
      '  scope = project  ',
    ]);
    expect(inv.kind).toBe('workflow');
    if (inv.kind !== 'workflow') return;
    // The key gets trimmed, the value preserves the spaces inside.
    expect(inv.options.workflow.args).toEqual({
      scope: ' project  ',
    });
  });

  it('rejects --workflow without a value', () => {
    expect(() => parseCliInvocation(['--workflow'])).toThrow(/Unknown option/);
  });

  it('rejects --workflow with no dot', () => {
    expect(() => parseCliInvocation(['--workflow', 'noDot'])).toThrow(
      /Invalid workflow format/
    );
  });

  it('rejects --workflow with empty plugin id', () => {
    expect(() => parseCliInvocation(['--workflow', '.create'])).toThrow(
      /Invalid workflow format/
    );
  });

  it('rejects --workflow with empty workflow name', () => {
    expect(() => parseCliInvocation(['--workflow', 'persona.'])).toThrow(
      /Invalid workflow format/
    );
  });

  it('rejects --workflow-arg without an = sign', () => {
    expect(() =>
      parseCliInvocation(['--workflow', 'a.b', '--workflow-arg', 'oops'])
    ).toThrow(/Invalid workflow arg format/);
  });

  it('rejects --workflow-arg with empty key', () => {
    expect(() =>
      parseCliInvocation(['--workflow', 'a.b', '--workflow-arg', '=value'])
    ).toThrow(/Invalid workflow arg format/);
  });

  it('rejects --workflow-arg before --workflow', () => {
    expect(() => parseCliInvocation(['--workflow-arg', 'scope=user'])).toThrow(
      /Unknown option/
    );
  });

  it('rejects --workflow-arg without a value argument', () => {
    expect(() =>
      parseCliInvocation(['--workflow', 'a.b', '--workflow-arg'])
    ).toThrow(/Missing value/);
  });

  it('combines --workflow with --output-plain and --once', () => {
    const inv = parseCliInvocation([
      '--once',
      '--output-plain',
      '--workflow',
      'persona.create',
      '--workflow-arg',
      'scope=project',
    ]);
    expect(inv.kind).toBe('workflow');
    if (inv.kind !== 'workflow') return;
    expect(inv.options.once).toBe(true);
    expect(inv.options.outputPlain).toBe(true);
  });

  it('parses --output-json', () => {
    const inv = parseCliInvocation(['--output-json']);
    expect(inv.kind).toBe('default');
    if (inv.kind !== 'default') return;
    expect(inv.options.outputJson).toBe(true);
  });

  it('rejects --output-plain and --output-json together', () => {
    expect(() =>
      parseCliInvocation(['--output-plain', '--output-json'])
    ).toThrow(/Cannot use --output-plain and --output-json/);
    expect(() =>
      parseCliInvocation(['--output-json', '--output-plain'])
    ).toThrow(/Cannot use --output-plain and --output-json/);
  });

  it('combines --workflow with --model and --plugin overrides', () => {
    const inv = parseCliInvocation([
      '--model',
      'llama3.1',
      '--plugin',
      'persona',
      '--workflow',
      'persona.create',
    ]);
    expect(inv.kind).toBe('workflow');
    if (inv.kind !== 'workflow') return;
    expect(inv.options.modelOverride).toBe('llama3.1');
    expect(inv.options.pluginOverrides).toEqual(['persona']);
  });
});

describe('parseCliInvocation — --plugin flag', () => {
  it('parses a single --plugin flag', () => {
    const inv = parseCliInvocation(['--plugin', 'bootstrap']);
    expect(inv.options.pluginOverrides).toEqual(['bootstrap']);
  });

  it('parses comma-separated plugin names in --plugin', () => {
    const inv = parseCliInvocation(['--plugin', 'bootstrap,lsp,git']);
    expect(inv.options.pluginOverrides).toEqual(['bootstrap', 'lsp', 'git']);
  });

  it('trims whitespace around comma-separated plugin names', () => {
    const inv = parseCliInvocation(['--plugin', ' bootstrap , lsp , git ']);
    expect(inv.options.pluginOverrides).toEqual(['bootstrap', 'lsp', 'git']);
  });

  it('supports repeated --plugin flags alongside comma-separated', () => {
    const inv = parseCliInvocation([
      '--plugin',
      'bootstrap',
      '--plugin',
      'lsp,git',
    ]);
    expect(inv.options.pluginOverrides).toEqual(['bootstrap', 'lsp', 'git']);
  });

  it('ignores empty segments in comma-separated plugin names', () => {
    const inv = parseCliInvocation(['--plugin', 'bootstrap,,lsp']);
    expect(inv.options.pluginOverrides).toEqual(['bootstrap', 'lsp']);
  });
});

describe('parseCliInvocation — non-workflow invocations', () => {
  it('returns kind "default" with no args', () => {
    expect(parseCliInvocation([]).kind).toBe('default');
  });

  it('returns kind "chat" with a single prompt', () => {
    const inv = parseCliInvocation(['hello world']);
    expect(inv.kind).toBe('chat');
    if (inv.kind !== 'chat') return;
    expect(inv.prompt).toBe('hello world');
  });

  it('returns kind "tool" for tool command', () => {
    const inv = parseCliInvocation([
      '--tool',
      'file.list',
      '--tool-arg',
      'path=/tmp',
    ]);
    expect(inv.kind).toBe('tool');
    if (inv.kind !== 'tool') return;
    expect(inv.toolName).toBe('file.list');
    expect(inv.input).toEqual({ path: '/tmp' });
  });
});
