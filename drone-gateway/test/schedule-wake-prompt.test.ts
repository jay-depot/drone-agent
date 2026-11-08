import { describe, expect, it } from 'vitest';
import {
  buildWakePrompt,
  classifyWakeReply,
  WAKE_INSTRUCTION,
} from '../src/schedule/wake-prompt.js';

describe('buildWakePrompt', () => {
  it('carries the note and the ISO time', () => {
    const prompt = buildWakePrompt('check the soup', 0);
    expect(prompt).toContain('check the soup');
    expect(prompt).toContain(new Date(0).toISOString());
    expect(prompt).toContain('[scheduled wake-up]');
  });
});

describe('classifyWakeReply', () => {
  it('classifies ordinary text as posted', () => {
    expect(classifyWakeReply('The soup is ready.')).toBe('posted');
  });

  it('classifies the no-response sentinel', () => {
    expect(classifyWakeReply('<<NO_RESPONSE>>')).toBe('sentinel');
  });

  it('classifies the cancel sentinel', () => {
    expect(classifyWakeReply('__CANCELLED__')).toBe('sentinel');
  });

  it('classifies whitespace as empty', () => {
    expect(classifyWakeReply('   ')).toBe('empty');
  });

  it('classifies null as empty', () => {
    expect(classifyWakeReply(null)).toBe('empty');
  });
});

describe('WAKE_INSTRUCTION', () => {
  it('mentions the no-response sentinel', () => {
    expect(WAKE_INSTRUCTION).toContain('<<NO_RESPONSE>>');
  });
});
