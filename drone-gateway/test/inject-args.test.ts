import { describe, expect, it } from 'vitest';
import {
  parseInjectArgs,
  usageText,
  DEFAULT_TIMEOUT_SECONDS,
} from '../src/inject/args.js';

describe('parseInjectArgs', () => {
  it('returns help for --help', () => {
    expect(parseInjectArgs(['--help'])).toEqual({ kind: 'help' });
  });

  it('returns help for -h', () => {
    expect(parseInjectArgs(['run-agent', '-h'])).toEqual({ kind: 'help' });
  });

  it('throws on an unknown subcommand', () => {
    expect(() => parseInjectArgs(['frobnicate'])).toThrow(
      'Unknown subcommand: frobnicate'
    );
  });

  it('throws when no subcommand is given', () => {
    expect(() => parseInjectArgs(['--json'])).toThrow('Missing subcommand');
  });

  it('throws on an unknown flag', () => {
    expect(() =>
      parseInjectArgs([
        'inject-message',
        '--adapter',
        'a',
        '--conversation',
        'c',
        'hi',
        '--bogus',
      ])
    ).toThrow('Unknown option: --bogus');
  });

  it('throws when a flag lacks its value', () => {
    expect(() => parseInjectArgs(['inject-message', '--adapter'])).toThrow(
      'Option --adapter requires a value'
    );
  });

  it('requires --adapter and --conversation', () => {
    expect(() => parseInjectArgs(['inject-message', 'hi'])).toThrow(
      'Option --adapter is required'
    );
    expect(() =>
      parseInjectArgs(['inject-message', '--adapter', 'a', 'hi'])
    ).toThrow('Option --conversation is required');
  });

  describe('inject-message', () => {
    it('parses a positional text with common options', () => {
      const inv = parseInjectArgs([
        'inject-message',
        '--adapter',
        'matrix',
        '--conversation',
        '!room:s',
        '--prefix',
        'X',
        '--json',
        'hello',
      ]);
      expect(inv).toMatchObject({
        kind: 'inject-message',
        text: 'hello',
        options: {
          adapterId: 'matrix',
          conversationId: '!room:s',
          prefix: 'X',
          json: true,
        },
      });
    });

    it('parses --file instead of positional text', () => {
      const inv = parseInjectArgs([
        'inject-message',
        '--adapter',
        'a',
        '--conversation',
        'c',
        '--file',
        '-',
      ]);
      expect(inv).toMatchObject({ kind: 'inject-message', file: '-' });
    });

    it('throws when neither text nor --file is given', () => {
      expect(() =>
        parseInjectArgs([
          'inject-message',
          '--adapter',
          'a',
          '--conversation',
          'c',
        ])
      ).toThrow('exactly one of a positional text or --file');
    });

    it('throws when both text and --file are given', () => {
      expect(() =>
        parseInjectArgs([
          'inject-message',
          '--adapter',
          'a',
          '--conversation',
          'c',
          '--file',
          'x',
          'hi',
        ])
      ).toThrow('exactly one of a positional text or --file');
    });

    it('throws on more than one positional', () => {
      expect(() =>
        parseInjectArgs([
          'inject-message',
          '--adapter',
          'a',
          '--conversation',
          'c',
          'one',
          'two',
        ])
      ).toThrow('at most one positional');
    });
  });

  describe('run-agent', () => {
    it('defaults the timeout and parses all flags', () => {
      const inv = parseInjectArgs([
        'run-agent',
        '--adapter',
        'matrix',
        '--conversation',
        '!room:s',
        '--persona',
        'coder',
        '--working-dir',
        '/srv/x',
        '--model',
        'p/m',
        '--agent-path',
        '/usr/bin/drone-agent',
        '--no-response-sentinel',
        'say hi',
      ]);
      expect(inv).toMatchObject({
        kind: 'run-agent',
        task: 'say hi',
        persona: 'coder',
        workingDir: '/srv/x',
        model: 'p/m',
        agentPath: '/usr/bin/drone-agent',
        timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
        noResponseSentinel: true,
      });
    });

    it('parses an explicit --timeout', () => {
      const inv = parseInjectArgs([
        'run-agent',
        '--adapter',
        'a',
        '--conversation',
        'c',
        '--timeout',
        '30',
        'task',
      ]);
      expect(inv).toMatchObject({ kind: 'run-agent', timeoutSeconds: 30 });
    });

    it('rejects a non-numeric --timeout', () => {
      expect(() =>
        parseInjectArgs([
          'run-agent',
          '--adapter',
          'a',
          '--conversation',
          'c',
          '--timeout',
          'soon',
          'task',
        ])
      ).toThrow('Invalid --timeout value: soon');
    });

    it('rejects a negative --timeout', () => {
      expect(() =>
        parseInjectArgs([
          'run-agent',
          '--adapter',
          'a',
          '--conversation',
          'c',
          '--timeout',
          '-1',
          'task',
        ])
      ).toThrow('Invalid --timeout value: -1');
    });

    it('parses --task-file instead of positional task', () => {
      const inv = parseInjectArgs([
        'run-agent',
        '--adapter',
        'a',
        '--conversation',
        'c',
        '--task-file',
        '-',
      ]);
      expect(inv).toMatchObject({ kind: 'run-agent', taskFile: '-' });
    });

    it('throws when neither task nor --task-file is given', () => {
      expect(() =>
        parseInjectArgs(['run-agent', '--adapter', 'a', '--conversation', 'c'])
      ).toThrow('exactly one of a positional task or --task-file');
    });
  });

  describe('common option validation', () => {
    it('rejects an out-of-range --port', () => {
      expect(() =>
        parseInjectArgs([
          'inject-message',
          '--adapter',
          'a',
          '--conversation',
          'c',
          '--port',
          '99999',
          'hi',
        ])
      ).toThrow('Invalid --port value: 99999');
    });

    it('accepts a valid --port', () => {
      const inv = parseInjectArgs([
        'inject-message',
        '--adapter',
        'a',
        '--conversation',
        'c',
        '--port',
        '8090',
        'hi',
      ]);
      expect(inv).toMatchObject({ options: { port: 8090 } });
    });
  });
});

describe('usageText', () => {
  it('names both subcommands', () => {
    const text = usageText();
    expect(text).toContain('inject-message');
    expect(text).toContain('run-agent');
  });
});
