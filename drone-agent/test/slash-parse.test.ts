import { describe, expect, it } from 'vitest';
import {
  parseSlashInvocation,
  stripNowFlag,
} from '../src/runtime/slash-parse.js';

describe('parseSlashInvocation', () => {
  it('parses a bare command with no rest', () => {
    expect(parseSlashInvocation('')).toEqual({
      subcommand: undefined,
      flags: [],
    });
  });

  it('parses a subcommand with no flags', () => {
    expect(parseSlashInvocation('set clear')).toEqual({
      subcommand: 'set',
      flags: [],
    });
  });

  it('parses a flag with no subcommand', () => {
    expect(parseSlashInvocation('--all')).toEqual({
      subcommand: undefined,
      flags: ['all'],
    });
  });

  it('parses a subcommand with a trailing flag', () => {
    expect(parseSlashInvocation('unmount --all')).toEqual({
      subcommand: 'unmount',
      flags: ['all'],
    });
  });

  it('strips the dash prefix (both - and --) from flag tokens', () => {
    expect(parseSlashInvocation('-x --verbose')).toEqual({
      subcommand: undefined,
      flags: ['x', 'verbose'],
    });
  });

  it('keeps the first non-flag token as the subcommand even with earlier flags', () => {
    expect(parseSlashInvocation('--all set clear')).toEqual({
      subcommand: 'set',
      flags: ['all'],
    });
  });

  it('treats whitespace runs as a single separator', () => {
    expect(parseSlashInvocation('  set   clear  ')).toEqual({
      subcommand: 'set',
      flags: [],
    });
  });
});

describe('stripNowFlag', () => {
  it('returns the line unchanged (no --now) with hadNow false', () => {
    expect(stripNowFlag('/focus set clear')).toEqual({
      line: '/focus set clear',
      hadNow: false,
    });
  });

  it('strips a trailing --now and reports hadNow', () => {
    expect(stripNowFlag('/clear --now')).toEqual({
      line: '/clear',
      hadNow: true,
    });
  });

  it('strips --now placed right after the command token', () => {
    expect(stripNowFlag('/model --now openai/gpt-4o')).toEqual({
      line: '/model openai/gpt-4o',
      hadNow: true,
    });
  });

  it('strips only the first --now occurrence', () => {
    expect(stripNowFlag('/exec --now ls --now')).toEqual({
      line: '/exec ls --now',
      hadNow: true,
    });
  });

  it('does not strip a --now embedded in a larger token', () => {
    expect(stripNowFlag('/exec echo --nowish')).toEqual({
      line: '/exec echo --nowish',
      hadNow: false,
    });
  });
});
