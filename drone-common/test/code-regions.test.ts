import { describe, expect, it } from 'vitest';
import { transformOutsideCodeRegions } from '../src/index.js';

const mark = (text: string) => `«${text}»`;

describe('transformOutsideCodeRegions', () => {
  it('marks plain text in full', () => {
    expect(transformOutsideCodeRegions('plain text', mark)).toBe(
      '«plain text»'
    );
  });

  it('leaves a backtick fenced block unmarked', () => {
    const md = 'before\n```\ncode [[x]]\n```\nafter';
    expect(transformOutsideCodeRegions(md, mark)).toBe(
      '«before\n»```\ncode [[x]]\n```\n«after»'
    );
  });

  it('leaves a tilde fenced block unmarked', () => {
    const md = 'before\n~~~\ncode [[x]]\n~~~\nafter';
    expect(transformOutsideCodeRegions(md, mark)).toBe(
      '«before\n»~~~\ncode [[x]]\n~~~\n«after»'
    );
  });

  it('closes a block when the closing fence is longer than the opening fence', () => {
    const md = '```\ncode\n`````\nafter';
    expect(transformOutsideCodeRegions(md, mark)).toBe(
      '```\ncode\n`````\n«after»'
    );
  });

  it('does not close a block when the closing fence is shorter than the opening fence', () => {
    const md = '````\ncode\n```\nstill code\n````';
    expect(transformOutsideCodeRegions(md, mark)).toBe(md);
  });

  it('runs an unterminated fence to the end of the document', () => {
    const md = 'before\n```\ncode\nmore code';
    expect(transformOutsideCodeRegions(md, mark)).toBe(
      '«before\n»```\ncode\nmore code'
    );
  });

  it('leaves an inline span unmarked and marks the text around it', () => {
    expect(transformOutsideCodeRegions('a `x` b', mark)).toBe('«a »`x`« b»');
  });

  it('leaves a double-backtick span unmarked', () => {
    expect(transformOutsideCodeRegions('a ``x`` b', mark)).toBe(
      '«a »``x``« b»'
    );
  });

  it('treats an unmatched backtick run as marked text', () => {
    expect(transformOutsideCodeRegions('a `x b', mark)).toBe('«a `x b»');
  });

  it('marks a real link outside a code block and leaves the code block unmarked', () => {
    const md = 'See [[real]]\n```\n[[fake]]\n```';
    expect(transformOutsideCodeRegions(md, mark)).toBe(
      '«See [[real]]\n»```\n[[fake]]\n```'
    );
  });

  it('does not treat a fence marker inside an inline span as a fence', () => {
    const md = 'text ``` not a fence ``` end';
    expect(transformOutsideCodeRegions(md, mark)).toBe(
      '«text »``` not a fence ```« end»'
    );
  });

  it('returns an empty string for an empty document', () => {
    expect(transformOutsideCodeRegions('', mark)).toBe('');
  });

  it('is idempotent when the transform returns its input', () => {
    const md = 'text\n```\ncode\n```\n`inline`\nmore';
    expect(transformOutsideCodeRegions(md, t => t)).toBe(md);
  });
});
