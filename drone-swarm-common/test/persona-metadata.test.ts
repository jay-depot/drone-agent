import { describe, expect, it } from 'vitest';
import { derivePersonaMetadata } from '../src/persona-metadata.js';

describe('derivePersonaMetadata', () => {
  it('uses frontmatter name and description', () => {
    const md = [
      '---',
      'name: my-persona',
      'description: Reviews code carefully',
      'color: "#00ff00"',
      '---',
      'You are a strict reviewer.',
    ].join('\n');

    expect(derivePersonaMetadata(md, 'my-persona')).toEqual({
      name: 'my-persona',
      description: 'Reviews code carefully',
    });
  });

  it('falls back to id and Persona: id when there is no frontmatter', () => {
    expect(derivePersonaMetadata('You are a helper.', 'helper')).toEqual({
      name: 'helper',
      description: 'Persona: helper',
    });
  });

  it('falls back when frontmatter omits name/description', () => {
    const md = ['---', 'color: cyan', '---', 'Body'].join('\n');
    expect(derivePersonaMetadata(md, 'bare')).toEqual({
      name: 'bare',
      description: 'Persona: bare',
    });
  });

  it('keeps an explicitly empty description empty', () => {
    const md = ['---', 'name: p', 'description:', '---', 'Body'].join('\n');
    expect(derivePersonaMetadata(md, 'p')).toEqual({
      name: 'p',
      description: '',
    });
  });

  it('parses frontmatter whose closing fence ends the file', () => {
    const md = ['---', 'name: eof', 'description: end of file', '---'].join(
      '\n'
    );
    expect(derivePersonaMetadata(md, 'eof')).toEqual({
      name: 'eof',
      description: 'end of file',
    });
  });

  it('strips single and double quotes from values', () => {
    const md = [
      '---',
      "name: 'single-quoted'",
      'description: "double-quoted"',
      '---',
    ].join('\n');
    expect(derivePersonaMetadata(md, 'q')).toEqual({
      name: 'single-quoted',
      description: 'double-quoted',
    });
  });

  it('does not mistake premountedTools plugin ids for metadata', () => {
    const md = [
      '---',
      'name: with-tools',
      'description: has premounted tools',
      'premountedTools:',
      '  name:',
      '    - read',
      '  file:',
      '    - list',
      '---',
      'Body',
    ].join('\n');
    expect(derivePersonaMetadata(md, 'with-tools')).toEqual({
      name: 'with-tools',
      description: 'has premounted tools',
    });
  });
});
